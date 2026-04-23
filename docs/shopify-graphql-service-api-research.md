# Shopify Service GraphQL API Research

## Context

`ShopifyAdminApi.ts` already provides `graphql` and `graphqlDecode`, bound to an auth context via `layerFor`:

```ts
// current usage
const auth = yield* shopify.authenticateAdmin(request)
if (auth instanceof Response) return auth
const result = yield* program.pipe(Effect.provide(ShopifyAdminApi.layerFor(auth)))
```

Goal: expose `graphql` (and `graphqlDecode`?) directly on `Shopify` so callers don't need `layerFor`.

## Layer Scope Is Per-Request

`worker.ts` calls `makeRunEffect(env, request)` on every fetch, rebuilding `runtimeLayer` (including `Shopify.layer`) per invocation. So `Shopify.make` runs fresh each time — no cross-request state bleed.

This means **a `let` variable inside `make` is safe**. It's scoped to one Effect execution, not a global singleton.

## Design Options

### A: `let` variable (simplest)

```ts
// inside make:
let adminGraphql: ShopifyAdminContext["graphql"] | null = null;

// in authenticateAdmin success path, before returning buildAdminContext:
const ctx = buildAdminContext(shopify, session);
adminGraphql = ctx.graphql;
return ctx;

// exposed on service:
const graphql = Effect.fn("Shopify.graphql")(function* (query, options?) {
  if (!adminGraphql) yield* Effect.fail(new ShopifyError({ message: "graphql not initialized — call authenticateAdmin first", cause: undefined }));
  return yield* adminGraphql!(query, options);
});
```

Pros: minimal, obvious, no new primitives.  
Cons: imperative mutation in an otherwise functional codebase.

### B: `Effect.Ref`

```ts
// inside make:
const graphqlRef = yield* Ref.make<Option.Option<ShopifyAdminContext["graphql"]>>(Option.none());

// in authenticateAdmin success path:
const ctx = buildAdminContext(shopify, session);
yield* Ref.set(graphqlRef, Option.some(ctx.graphql));
return ctx;

// exposed on service:
const graphql = Effect.fn("Shopify.graphql")(function* (query, options?) {
  const fn = yield* Ref.get(graphqlRef);
  if (Option.isNone(fn)) yield* Effect.fail(new ShopifyError({ ... }));
  return yield* fn.value(query, options);
});
```

Pros: idiomatic Effect, explicit about mutability.  
Cons: more boilerplate, same semantics as `let` given per-request scope.

### C: Keep `ShopifyAdminApi`, simplify the call site

Instead of adding state to `Shopify`, keep the layered pattern but flatten the usage in route code by providing a helper:

```ts
// route code
const auth = yield* shopify.authenticateAdmin(request)
if (auth instanceof Response) return auth
yield* ShopifyAdminApi.pipe(Effect.provide(ShopifyAdminApi.layerFor(auth)))
```

Pros: no service state, cleanest separation.  
Cons: doesn't meet the stated goal (graphql on `Shopify`).

## Recommendation

**Option B** (`Effect.Ref`) if adding to `Shopify` directly — idiomatic and explicit.

But worth clarifying first:

1. Should `ShopifyAdminApi` be deleted / replaced, or should `Shopify` gain graphql in addition?
2. Should `graphqlDecode` also live on `Shopify`, or stay on `ShopifyAdminApi`?
3. Is `authenticateAdmin` always called before graphql in the same pipeline, or could they be in different `runEffect` calls? (If different invocations, the `let`/`Ref` approach won't work — `make` resets each time.)
