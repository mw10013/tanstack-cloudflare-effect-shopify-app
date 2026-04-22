# Shopify AdminApi Service Architecture (Middleware-Provided Layer)

## Decision

Adopt service-first `AdminApi`, and provide the admin-aware layer in `ShopifyServerFnMiddleware` after auth.

Concretely:

- `AdminApi` is a `Context.Service`.
- `AdminContext` is internal to `AdminApi.ts`.
- middleware authenticates once, then wraps/overrides `runEffect` so handlers do not wire `AdminApi.layerFor(admin)` manually.

## Why this works well

### 1) Timing matches runtime reality

- `Shopify.authenticateAdmin(request)` returns `ShopifyAdminContext | Response` (`src/lib/Shopify.ts:30`, `src/lib/Shopify.ts:290`).
- so `admin` only exists after auth succeeds.
- base runtime layer is built earlier in `worker.ts` (`src/worker.ts:44`, `src/worker.ts:56`).

Result: `AdminContext` cannot be cleanly pre-provided in the base runtime layer.

### 2) Middleware already owns auth + request context

- middleware already calls auth with `context.runEffect(...)` (`src/lib/ShopifyServerFnMiddleware.ts:42`).
- middleware already enriches context via `next({ context: ... })` (`src/lib/ShopifyServerFnMiddleware.ts:52`).

Result: middleware is the correct place to attach admin-aware dependency provisioning.

### 3) Preserves one mental model for handlers

- handlers keep using `runEffect(...)`.
- no extra `runAdminEffect` API.
- no per-handler `Effect.provide(AdminApi.layerFor(admin))` noise.

## Service shape (repo-idiomatic)

This repo uses class services with `make` + explicit `layer`:

- `src/lib/Shopify.ts:147`
- `src/lib/Repository.ts:14`
- `src/lib/D1.ts:5`
- `src/lib/KV.ts:18`

Use the same for `AdminApi`.

```ts
import { Context, Effect, Layer, Schema } from "effect";

import type { ShopifyAdminContext } from "@/lib/Shopify";

export const AdminContext = Context.Service<ShopifyAdminContext>("AdminContext");

export class AdminApiError extends Schema.TaggedErrorClass<AdminApiError>()(
  "AdminApiError",
  { message: Schema.String, cause: Schema.Defect },
) {}

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
              }
            }
          }
        }
      `);
      return yield* Effect.tryPromise(() => response.json()).pipe(
        Effect.mapError((cause) =>
          new AdminApiError({ message: "getProducts failed", cause }),
        ),
      );
    });

    return { getProducts };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
  static readonly layerFor = (admin: ShopifyAdminContext) =>
    this.layer.pipe(Layer.provide(Layer.succeed(AdminContext, admin)));
}
```

Notes:

- service ids follow repo style: no `app/` prefix (`"AdminApi"`, `"AdminContext"`).

## Middleware wiring (primary approach)

Wrap/override `runEffect` in `ShopifyServerFnMiddleware` after successful auth.

```ts
.server(async ({ next, context }) => {
  const auth = await context.runEffect(
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* AppRequest;
      return yield* shopify.authenticateAdmin(request);
    }),
  );

  if (auth instanceof Response) {
    throw new TypeError(`Unexpected Shopify auth response: ${String(auth.status)}`);
  }

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
})
```

Handler stays clean:

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

## About pre-providing `AdminContext` in `worker.ts`

Not recommended.

- you would need nullable/default `AdminContext` before auth.
- that weakens guarantees and leaks nullability checks into `AdminApi` logic.
- it mixes unauthenticated and authenticated dependency states into the same base runtime.

Middleware-time provisioning keeps the boundary explicit: auth first, then admin-aware services.

## Is `layerFor` idiomatic in Effect v4?

Yes, the pattern is idiomatic. The name is local.

Evidence from `refs/effect4` showing layer factories from runtime input:

- `DatabasePool.layer(tenantId)` in `refs/effect4/ai-docs/src/01_effect/04_resources/30_layer-map.ts:27`
- `MessageStore.layerRemote(url)` in `refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts:31`
- `layerConfig(config)` and `layer(config)` in `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:397`, `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:417`

Also relevant: per-execution injection in auth middleware via `Effect.provideService(...)`:

- `refs/effect4/ai-docs/src/51_http-server/fixtures/server/Authorization.ts:24`
- API docs: `refs/effect4/packages/effect/src/Effect.ts:5929`

## Alternative idiomatic wiring (if needed)

If middleware `runEffect` override causes typing friction, fallback is one-liner at callsite:

```ts
runEffect(program.pipe(Effect.provide(AdminApi.layerFor(admin))))
```

It is still fully idiomatic and keeps runtime behavior equivalent.

## Recommendation

Proceed with middleware-provided admin-aware layer.

- implement `AdminApi` service with internal `AdminContext`.
- keep `AdminApi.layerFor(auth)` as composition helper.
- in `ShopifyServerFnMiddleware`, override `runEffect` post-auth.
- handlers continue to call one `runEffect`, now admin-aware.

## References

- `src/lib/Shopify.ts:30`
- `src/lib/Shopify.ts:290`
- `src/lib/ShopifyServerFnMiddleware.ts:42`
- `src/lib/ShopifyServerFnMiddleware.ts:52`
- `src/worker.ts:44`
- `src/worker.ts:56`
- `src/lib/Shopify.ts:147`
- `src/lib/Repository.ts:14`
- `src/lib/D1.ts:5`
- `src/lib/KV.ts:18`
- `src/lib/Request.ts:3`
- `refs/effect4/LLMS.md:99`
- `refs/effect4/LLMS.md:105`
- `refs/effect4/migration/services.md:173`
- `refs/effect4/migration/services.md:175`
- `refs/effect4/migration/services.md:187`
- `refs/effect4/ai-docs/src/01_effect/04_resources/30_layer-map.ts:27`
- `refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts:31`
- `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:397`
- `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:417`
- `refs/effect4/ai-docs/src/51_http-server/fixtures/server/Authorization.ts:24`
- `refs/effect4/packages/effect/src/Effect.ts:5929`
