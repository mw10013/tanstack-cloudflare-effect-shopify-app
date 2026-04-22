# ShopifyAdminApi Service Architecture (Middleware-Provided Layer)

## Decision (Revised)

Adopt service-first `ShopifyAdminApi`, provisioned after auth in `shopifyServerFnMiddleware`.

Concretely:

- `ShopifyAdminApi` is a `Context.Service`.
- `ShopifyAdminContext` stays file-private inside `ShopifyAdminApi.ts`.
- middleware authenticates once, then injects the admin-aware layer into handler effects.
- `Response` from `authenticateAdmin` is treated as expected auth control flow, not "impossible".

## Why this is sound

### 1) Runtime timing is correct

- `authenticateAdmin` returns `ShopifyAdminContext | Response` (`src/lib/Shopify.ts:286`, `src/lib/Shopify.ts:290`).
- `runEffect` runtime layer is built earlier in `worker.ts` (`src/worker.ts:44`, `src/worker.ts:56`).

Result: admin context cannot be safely pre-provided in the base runtime.

### 2) Middleware is the existing auth seam

- middleware already calls auth through `context.runEffect(...)` (`src/lib/ShopifyServerFnMiddleware.ts:42`).
- middleware already injects server-fn context (`src/lib/ShopifyServerFnMiddleware.ts:52`).

Result: this is the right place for post-auth provisioning.

### 3) Maintains handler ergonomics

- handlers still call one `runEffect(...)`.
- avoids per-handler `Effect.provide(...)` repetition.

## Critical corrections vs v1

1. **`Response` is expected**
   - `authenticateAdmin` explicitly documents `Response` return for redirect/bounce/unauthorized paths (`src/lib/Shopify.ts:286`).
   - middleware should branch intentionally on `Response` and apply a defined policy.

2. **Service call syntax**
   - handler example must call `getProducts()`.
   - `yield* adminApi.getProducts` is incorrect.

3. **Internal context consistency**
   - if decision says internal context, do not export `ShopifyAdminContext`.
   - keep it local and only export `ShopifyAdminApi` + public error types.

4. **Type-risk in `runEffect` override**
   - overriding `runEffect` can run into generic inference friction against `makeRunEffect` in `src/worker.ts:64`.
   - keep fallback ready: callsite `Effect.provide(ShopifyAdminApi.layerFor(admin))`.

5. **GraphQL normalization gap**
   - raw `response.json()` is not enough for repo standards.
   - preserve schema decode/error mapping discipline used in `src/routes/app.index.tsx:79` and `src/routes/app.index.tsx:120`.

6. **Scope boundary is server-fn middleware only**
   - this improves endpoints using `shopifyServerFnMiddleware` (for example `src/routes/app.index.tsx:44`).
   - it does not replace route-level auth flow in `src/routes/app.tsx:53`.

## Service shape (repo-idiomatic)

The class-service style matches existing services (`src/lib/Shopify.ts:147`, `src/lib/Repository.ts:14`, `src/lib/D1.ts:5`, `src/lib/KV.ts:18`).

```ts
import { Context, Effect, Layer, Schema } from "effect";

import type { ShopifyAdminContext as ShopifyAdminContextValue } from "@/lib/Shopify";

const ShopifyAdminContext = Context.Service<ShopifyAdminContextValue>("ShopifyAdminContext");

export class ShopifyAdminApiError extends Schema.TaggedErrorClass<ShopifyAdminApiError>()(
  "ShopifyAdminApiError",
  { message: Schema.String, cause: Schema.Defect },
) {}

export class ShopifyAdminApi extends Context.Service<ShopifyAdminApi>()("ShopifyAdminApi", {
  make: Effect.gen(function* () {
    const admin = yield* ShopifyAdminContext;
    const getProducts = Effect.fn("ShopifyAdminApi.getProducts")(function* () {
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
          new ShopifyAdminApiError({ message: "getProducts failed", cause }),
        ),
      );
    });
    return { getProducts };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
  static readonly layerFor = (admin: ShopifyAdminContextValue) =>
    this.layer.pipe(Layer.provide(Layer.succeed(ShopifyAdminContext, admin)));
}
```

Notes:

- service ids follow repo style, no `app/` prefix.
- add schema decoding on top of this base shape for real operations.

## Middleware wiring

Primary pattern: authenticate, branch on `Response`, then inject admin-aware layer.

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
    throw new Error(`Shopify admin auth required (${String(auth.status)})`);
  }

  const baseRunEffect = context.runEffect;
  const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R | ShopifyAdminApi>) =>
    baseRunEffect(effect.pipe(Effect.provide(ShopifyAdminApi.layerFor(auth))));

  return next({ context: { admin: auth, session: auth.session, runEffect } });
})
```

Handler call:

```ts
.handler(({ context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const adminApi = yield* ShopifyAdminApi;
      return yield* adminApi.getProducts();
    }),
  ),
)
```

## `layerFor` idiomatic status

`layerFor(input)` is idiomatic in Effect v4. Reference examples:

- `DatabasePool.layer(tenantId)` in `refs/effect4/ai-docs/src/01_effect/04_resources/30_layer-map.ts:27`
- `MessageStore.layerRemote(url)` in `refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts:31`
- config-driven layer factories in `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:397` and `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:417`

## Fallback if typing friction appears

If `runEffect` override gets noisy, keep middleware auth/context and provide per callsite:

```ts
runEffect(program.pipe(Effect.provide(ShopifyAdminApi.layerFor(admin))))
```

Behavior is equivalent and remains idiomatic.

## Recommendation

Proceed with middleware-provided admin-aware layer, with these guardrails:

- treat `Response` from auth as expected branch, define explicit policy.
- keep `ShopifyAdminContext` private to `ShopifyAdminApi.ts`.
- ensure service methods decode GraphQL payloads and map failures.
- start with `runEffect` override; fallback to callsite `provide` if types become brittle.
- keep `/app` route auth flow (`src/routes/app.tsx`) separate; do not assume middleware replaces it.

## References

- `src/lib/Shopify.ts:286`
- `src/lib/Shopify.ts:290`
- `src/lib/ShopifyServerFnMiddleware.ts:42`
- `src/lib/ShopifyServerFnMiddleware.ts:52`
- `src/worker.ts:44`
- `src/worker.ts:56`
- `src/worker.ts:64`
- `src/routes/app.index.tsx:44`
- `src/routes/app.index.tsx:79`
- `src/routes/app.index.tsx:120`
- `src/routes/app.tsx:53`
- `src/lib/Shopify.ts:147`
- `src/lib/Repository.ts:14`
- `src/lib/D1.ts:5`
- `src/lib/KV.ts:18`
- `refs/effect4/ai-docs/src/01_effect/04_resources/30_layer-map.ts:27`
- `refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts:31`
- `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:397`
- `refs/effect4/packages/sql/clickhouse/src/ClickhouseClient.ts:417`
