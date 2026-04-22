# Shopify Admin API Service: Architecture

## Names

```
Repository   →  D1 (SQLite rows → domain objects)
AdminApi     →  Shopify Admin GraphQL (GQL responses → domain objects)
AdminContext →  ShopifyAdminContext provided as an Effect tag
```

`AdminApi` matches Shopify's own SDK name (`AdminApiClient` in `refs/shopify-app-js/packages/api-clients/admin-api-client/`).

## The Auth Timing Problem

`Repository` gets `D1` at layer-build time (`makeRunEffect` in `worker.ts`) — synchronous, available before any request logic runs.

`AdminApi` needs `graphql`, available only after `Shopify.authenticateAdmin(request)` resolves — async, can return a redirect `Response` instead of a context, involves token decode plus a possible token-exchange with Shopify. It cannot be in the base `runtimeLayer`.

**Consequence:** auth dependency must be injected after auth completes, not at layer-build time.

## Effect v4 Idiomatic Pattern: `Effect.provideService`

Effect's own `HttpApiMiddleware` docs show exactly this pattern — inject an authenticated value mid-pipeline via `Effect.provideService`:

```ts
// refs/effect4/ai-docs/src/51_http-server/fixtures/server/Authorization.ts
return yield* Effect.provideService(
  httpEffect,
  CurrentUser,
  new User({ id: UserId.make(1), name: "Dev User", email: "dev@acme.com" })
)
```

`Layer.provideMerge` is for static layer composition at definition time. `Effect.provideService` is for per-request value injection at runtime — one tag, one value, one call.

## AdminContext Tag

```ts
// src/lib/AdminApi.ts
export class AdminContext extends Context.Service<AdminContext, ShopifyAdminContext>()(
  "app/AdminContext"
) {}
```

Mirrors how `CurrentUser` is defined in the Effect docs (`refs/effect4/ai-docs/src/51_http-server/fixtures/api/Authorization.ts:5`):

```ts
export class CurrentUser extends Context.Service<CurrentUser, User>()("acme/HttpApi/Authorization/CurrentUser") {}
```

## AdminApi: Module of Functions, Not a Context.Service

`AdminApi` functions yield `AdminContext` directly. No `AdminApi` class or layer — that would require the handler to compose a layer for a service whose only dependency is the already-available `admin` value.

```ts
// src/lib/AdminApi.ts
export class AdminApiError extends Schema.TaggedErrorClass<AdminApiError>()(
  "AdminApiError",
  { message: Schema.String, cause: Schema.Defect },
) {}

export class AdminContext extends Context.Service<AdminContext, ShopifyAdminContext>()(
  "app/AdminContext"
) {}

export const getProducts = Effect.fn("AdminApi.getProducts")(function* () {
  const { graphql } = yield* AdminContext;
  const response = yield* graphql(`#graphql
    query {
      products(first: 10) {
        edges { node { id title handle status variants(first: 10) { edges { node { id price barcode createdAt } } } } }
      }
    }
  `);
  return yield* Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProductsResponse)),
    Effect.mapError((cause) => new AdminApiError({ message: "getProducts failed", cause })),
  );
});
```

## Middleware: No Change

`ShopifyServerFnMiddleware` already passes `admin` (which IS `ShopifyAdminContext`) into TanStack context. No change needed:

```ts
// ShopifyServerFnMiddleware.ts — unchanged
return next({ context: { admin: auth, session: auth.session } });
```

## Handler: One `Effect.provideService` Call

```ts
.handler(({ context: { admin, runEffect } }) =>
  runEffect(
    Effect.provideService(
      AdminApi.getProducts(),
      AdminContext,
      admin,
    ),
  )
)
```

`admin` in TanStack context already IS the `ShopifyAdminContext` value — `Layer.succeed(AdminContext, admin)` is zero transformation. `Effect.provideService` injects it for the duration of that one effect execution.

## What Does NOT Belong in AdminApi

- Auth logic (stays in `Shopify.authenticateAdmin`)
- Session storage (stays in `Repository`)
- GraphQL client construction (stays in `Shopify.buildAdminContext`)
