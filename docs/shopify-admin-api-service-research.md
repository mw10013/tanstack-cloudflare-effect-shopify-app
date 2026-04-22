# Shopify Admin API Service: Architecture (Service-First)

## Decision

Use a real `AdminApi` `Context.Service`, not a module of free functions.

Reason: this module is not a thin wrapper and should be a first-class boundary (testable, swappable, composable) without leaking `AdminContext` into route handlers.

## Grounding in this repo

Current service pattern here is class service + `make` + explicit `layer`:

- `Shopify`: `src/lib/Shopify.ts:147`, `src/lib/Shopify.ts:148`, `src/lib/Shopify.ts:431`
- `Repository`: `src/lib/Repository.ts:14`, `src/lib/Repository.ts:15`, `src/lib/Repository.ts:148`
- `D1`: `src/lib/D1.ts:5`, `src/lib/D1.ts:6`, `src/lib/D1.ts:54`
- `KV`: `src/lib/KV.ts:18`, `src/lib/KV.ts:19`, `src/lib/KV.ts:68`

Also: this codebase usually uses simple service ids (`"Shopify"`, `"Repository"`, `"D1"`, `"KV"`, `"CloudflareEnv"`).

- One existing outlier has `"app/Request"` in `src/lib/Request.ts:3`.
- For new services, prefer repo convention: no `app/` prefix.

## Grounding in Effect v4 refs

- `Context.Service` is the default service model: `refs/effect4/LLMS.md:99`, `refs/effect4/LLMS.md:105`.
- v4 service construction pattern is `make` + `Layer.effect(...)`: `refs/effect4/migration/services.md:173`, `refs/effect4/migration/services.md:175`, `refs/effect4/migration/services.md:187`.
- `Effect.provideService` is explicitly for injecting one concrete service value into one effect execution: `refs/effect4/packages/effect/src/Effect.ts:5929`, `refs/effect4/packages/effect/src/Effect.ts:5948`.
- Per-request auth injection pattern exists in docs (`CurrentUser` middleware): `refs/effect4/ai-docs/src/51_http-server/fixtures/server/Authorization.ts:24`.

## Auth timing constraint (unchanged)

`Shopify.authenticateAdmin(request)` returns `ShopifyAdminContext | Response` (`src/lib/Shopify.ts:30`, `src/lib/Shopify.ts:290`).

So `ShopifyAdminContext` is only available after request auth resolves. It cannot live in static app runtime layer built in `worker.ts` (`src/worker.ts:44`, `src/worker.ts:56`).

## Recommended shape

### 1) Keep request-scoped raw value as internal service

```ts
export const AdminContext = Context.Service<ShopifyAdminContext>("AdminContext");
```

No `app/` prefix.

### 2) Expose only `AdminApi` publicly

```ts
import { Context, Effect, Layer, Schema } from "effect";

import type { ShopifyAdminContext } from "@/lib/Shopify";
import * as Domain from "@/lib/Domain";

const ShopifyErrors = Schema.optional(
  Schema.Array(Schema.Struct({ message: Schema.String })),
);

const ProductsResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      products: Schema.Struct({
        edges: Schema.Array(
          Schema.Struct({
            node: Domain.Product,
          }),
        ),
      }),
    }),
  ),
  errors: ShopifyErrors,
});

export class AdminApiError extends Schema.TaggedErrorClass<AdminApiError>()(
  "AdminApiError",
  { message: Schema.String, cause: Schema.Defect },
) {}

const mapAdminApiError =
  (message: string) =>
  (cause: unknown) =>
    new AdminApiError({ message, cause });

export const AdminContext = Context.Service<ShopifyAdminContext>("AdminContext");

export class AdminApi extends Context.Service<AdminApi>()("AdminApi", {
  make: Effect.gen(function* () {
    const admin = yield* AdminContext;

    const getProducts = Effect.fn("AdminApi.getProducts")(function* () {
      const response = yield* admin.graphql(`#graphql
        query {
          products(first: 10) {
            edges {
              node {
                id
                title
                handle
                status
                variants(first: 10) {
                  edges {
                    node {
                      id
                      price
                      barcode
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      `);

      const decoded = yield* Effect.tryPromise(() => response.json()).pipe(
        Effect.mapError(mapAdminApiError("getProducts response json failed")),
        Effect.flatMap(Schema.decodeUnknownEffect(ProductsResponse)),
        Effect.mapError(mapAdminApiError("getProducts decode failed")),
      );

      if (!decoded.data?.products) {
        return yield* Effect.fail(
          new AdminApiError({
            message: decoded.errors?.[0]?.message ?? "getProducts failed",
            cause: decoded,
          }),
        );
      }

      return decoded.data.products.edges.map((edge) => edge.node);
    });

    return { getProducts };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly layerFor = (admin: ShopifyAdminContext) =>
    this.layer.pipe(Layer.provide(Layer.succeed(AdminContext, admin)));
}
```

### 3) Handler only depends on `AdminApi`

```ts
.handler(({ context: { admin, runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const adminApi = yield* AdminApi;
      return yield* adminApi.getProducts;
    }).pipe(Effect.provide(AdminApi.layerFor(admin))),
  )
)
```

This removes `AdminContext` from route-level dependency surface.

## Is `layerFor` idiomatic?

Yes. The exact name `layerFor` is project-specific, but the pattern (a function that takes runtime input and returns a `Layer`) is idiomatic and common.

Evidence in `refs/effect4`:

- Layer factory on a service class: `DatabasePool.layer(tenantId)` in `refs/effect4/ai-docs/src/01_effect/04_resources/30_layer-map.ts:27`.
- Dynamic layer variant by input: `MessageStore.layerRemote(url)` in `refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts:31`.
- Top-level layer factories from runtime config: `layerConfig(config)` and `layer(config)` in `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:397`, `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:417`.

`layerFor(admin)` is the same shape: take request value, build/provide a layer, then use `Effect.provide(...)`.

## Other idiomatic wiring options

### Option A: keep `layerFor` (recommended)

```ts
Effect.gen(function* () {
  const adminApi = yield* AdminApi;
  return yield* adminApi.getProducts;
}).pipe(Effect.provide(AdminApi.layerFor(admin)));
```

Pros: one reusable entrypoint, less repeated layer plumbing in handlers.

### Option B: inline layer composition at callsite

```ts
Effect.gen(function* () {
  const adminApi = yield* AdminApi;
  return yield* adminApi.getProducts;
}).pipe(
  Effect.provide(
    AdminApi.layer.pipe(
      Layer.provide(Layer.succeed(AdminContext, admin)),
    ),
  ),
);
```

Same semantics as `layerFor`, just noisier.

### Option C: provide dependency and service separately

```ts
Effect.gen(function* () {
  const adminApi = yield* AdminApi;
  return yield* adminApi.getProducts;
}).pipe(
  Effect.provide(AdminApi.layer),
  Effect.provideService(AdminContext, admin),
);
```

Evidence that per-execution single-service injection is idiomatic: `Effect.provideService` docs in `refs/effect4/packages/effect/src/Effect.ts:5929` and HTTP auth fixture in `refs/effect4/ai-docs/src/51_http-server/fixtures/server/Authorization.ts:24`.

### Option D: effectful service acquisition (`provideServiceEffect`)

```ts
Effect.provideServiceEffect(AdminContext, getAdminEffect)(program)
```

Evidence: `provideServiceEffect` docs in `refs/effect4/packages/effect/src/Effect.ts:5983`, `refs/effect4/packages/effect/src/Effect.ts:5999`.

Useful when the provided dependency itself must be acquired effectfully.

## Worker vs middleware provisioning

### Can `worker.ts` pre-provide `AdminContext` in base runtime layer?

Not cleanly.

- `admin` does not exist until `Shopify.authenticateAdmin(request)` succeeds (`src/lib/Shopify.ts:290`).
- `authenticateAdmin` can return `Response` redirect/unauthorized control flow (`src/lib/Shopify.ts:30`, `src/lib/Shopify.ts:347`).
- Base runtime layer in `makeRunEffect` is built before route middleware logic (`src/worker.ts:44`, `src/worker.ts:56`).

You could seed a nullable/default `AdminContext`, but that weakens type guarantees and pushes null/empty checks into `AdminApi` methods.

### Better: provide admin-aware layer after auth in middleware

Yes, this is the right lazy-per-request model.

`ShopifyServerFnMiddleware` already has everything needed (`context.runEffect` + authenticated `auth`): `src/lib/ShopifyServerFnMiddleware.ts:42`, `src/lib/ShopifyServerFnMiddleware.ts:52`.

If you do not want a separate `runAdminEffect`, override `runEffect` in middleware context:

```ts
const baseRunEffect = context.runEffect;

const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R | AdminApi>) =>
  baseRunEffect(effect.pipe(Effect.provide(AdminApi.layerFor(auth))));

return next({
  context: {
    admin: auth,
    session: auth.session,
    runEffect,
  },
});
```

Then handler stays simple and uses normal `runEffect`:

```ts
.handler(({ context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const adminApi = yield* AdminApi;
      return yield* adminApi.getProducts;
    }),
  ),
)
```

This preserves one mental model (`runEffect`) and removes repeated per-handler layer plumbing.

## Recommendation

Adopt service-first now.

- Service ids: use `"AdminApi"` and `"AdminContext"` (no `app/` prefix).
- Keep `AdminContext` internal to `src/lib/AdminApi.ts`.
- Use `AdminApi.layerFor(admin)` as the default wiring helper.
- In middleware, wrap/override `runEffect` with `Effect.provide(AdminApi.layerFor(auth))` so handlers keep using one `runEffect`.
- Keep auth/session/token logic in `Shopify.authenticateAdmin` + `ShopifyServerFnMiddleware` (`src/lib/Shopify.ts:290`, `src/lib/ShopifyServerFnMiddleware.ts:52`).

## References

- **Repo service pattern (`make` + `Layer.effect`)**
  - `src/lib/Shopify.ts:147`
  - `src/lib/Repository.ts:14`
  - `src/lib/D1.ts:5`
  - `src/lib/KV.ts:18`
- **Effect service model + v4 `make` guidance**
  - `refs/effect4/LLMS.md:99`
  - `refs/effect4/migration/services.md:173`
  - `refs/effect4/migration/services.md:175`
  - `refs/effect4/migration/services.md:187`
- **Layer factory / dynamic layer examples (evidence for `layerFor` shape)**
  - `refs/effect4/ai-docs/src/01_effect/04_resources/30_layer-map.ts:27` (`DatabasePool.layer(tenantId)`)
  - `refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts:31` (`MessageStore.layerRemote(url)`)
  - `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:397` (`layerConfig(config)`)
  - `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:417` (`layer(config)`)
- **Per-execution service injection / alternatives**
  - `refs/effect4/packages/effect/src/Effect.ts:5929` (`provideService`)
  - `refs/effect4/packages/effect/src/Effect.ts:5983` (`provideServiceEffect` example)
  - `refs/effect4/packages/effect/src/Effect.ts:5999` (`provideServiceEffect` API)
  - `refs/effect4/ai-docs/src/51_http-server/fixtures/server/Authorization.ts:24` (`provideService` in auth middleware)
