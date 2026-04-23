# Remove ShopifyAdminApi Service

## Goal

Delete `src/lib/ShopifyAdminApi.ts` and have callers use `Shopify.graphqlDecode` directly.

## Current Architecture

### `ShopifyAdminApi` (`src/lib/ShopifyAdminApi.ts`)

A `Context.Service` that wraps a `ShopifyAdminContextValue` and exposes:
- `graphql(query, options)` — raw GraphQL, maps error to `ShopifyAdminApiError`
- `graphqlDecode(schema, query, options)` — GraphQL + schema decode, maps error to `ShopifyAdminApiError`

Built via `layerFor(auth)` at request time after `authenticateAdmin` succeeds.

### `Shopify` service (`src/lib/Shopify.ts`)

Already has equivalent functionality via a `Ref<Option<ShopifyAdminContext>>`:

```ts
const adminContextRef = yield* Ref.make<Option.Option<ShopifyAdminContext>>(Option.none());
```

`authenticateAdmin` sets the ref on success (lines 364, 379). `graphqlDecode` reads from it (line 427). If called before `authenticateAdmin`, fails with `ShopifyError({ message: "authenticateAdmin must be called before graphqlDecode" })`.

`Shopify.graphqlDecode` also handles GraphQL-level errors (line 432) — `ShopifyAdminApi.graphqlDecode` does not.

**Ref safety**: `makeRunEffect` in `worker.ts:72` creates a fresh `ManagedRuntime` (and thus a fresh `Shopify` service with its own `adminContextRef`) per request. No shared state between concurrent requests.

### Middleware (`src/lib/ShopifyServerFnMiddleware.ts`)

Currently wraps `runEffect` to inject `ShopifyAdminApi.layerFor(auth)`:

```ts
// lines 73–82
const runEffect = <A, E, R extends RuntimeRequirements>(
  effect: Effect.Effect<A, E, R | ShopifyAdminApi>,
) =>
  baseRunEffect(
    effect.pipe(Effect.provide(ShopifyAdminApi.layerFor(auth))) as ...
  );
return next({ context: { admin: auth, session: auth.session, runEffect } });
```

The `authenticateAdmin` call at line 47 must remain — it is what populates `adminContextRef` in the `Shopify` service.

### Caller (`src/routes/app.index.tsx`)

```ts
const adminApi = yield* ShopifyAdminApi;        // line 35
const productCreateJson = yield* adminApi.graphqlDecode(...)  // line 37
const productVariantsBulkUpdateJson = yield* adminApi.graphqlDecode(...)  // line 78
```

## Changes Required

### 1. `src/lib/ShopifyServerFnMiddleware.ts`

- Remove import of `ShopifyAdminApi`
- Remove `baseRunEffect` alias, `RuntimeRequirements` type, and the custom `runEffect` wrapper entirely
- `next` context is **augmented** via `safeObjectMerge(existing, next.context)` — existing keys are preserved. `runEffect` is already in context from `ServerContext` (set in `worker.ts`), so it does not need to be re-passed.

```ts
// Before (lines 58–83): baseRunEffect alias + RuntimeRequirements type + runEffect wrapper
const baseRunEffect = context.runEffect;
type RuntimeRequirements = ...;
const runEffect = <A, E, R extends RuntimeRequirements>(
  effect: Effect.Effect<A, E, R | ShopifyAdminApi>,
) => baseRunEffect(effect.pipe(Effect.provide(ShopifyAdminApi.layerFor(auth))) as ...);
return next({ context: { admin: auth, session: auth.session, runEffect } });

// After
return next({ context: { admin: auth, session: auth.session } });
```

### 2. `src/routes/app.index.tsx`

Replace `ShopifyAdminApi` service access with `Shopify`:

```ts
// Before
import { ShopifyAdminApi } from "@/lib/ShopifyAdminApi";
const adminApi = yield* ShopifyAdminApi;
yield* adminApi.graphqlDecode(schema, query, options)

// After
import { Shopify } from "@/lib/Shopify";
const shopify = yield* Shopify;
yield* shopify.graphqlDecode(schema, query, options)
```

### 3. Delete `src/lib/ShopifyAdminApi.ts`

## Error Type Change

`ShopifyAdminApiError` → `ShopifyError`. Both are tagged errors. In `app.index.tsx`, errors bubble through `runEffect` → thrown as `Error`, so no explicit catch-site changes needed. Any future code that catches `ShopifyAdminApiError` by tag must be updated.

## What Stays the Same

- `authenticateAdmin` is still called in the middleware server phase — required to populate `adminContextRef`
- `admin` and `session` remain in middleware context for consumers that need them
- `graphqlDecode` behavior is identical; `Shopify.graphqlDecode` additionally handles GraphQL-level errors
