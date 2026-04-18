# Shopify GraphQL parity with `refs/shopify-app-template`

How this port matches template for Admin GraphQL usage, where it deviates for TanStack Start + Cloudflare, and what's left.

## Parity with template

### Route usage

Template: `loader`/`action` calls `authenticate.admin(request)` and uses the returned `admin.graphql(...)` (`refs/shopify-app-template/app/routes/app._index.tsx:18-23,58`).

This port: `generateProduct` server fn (`src/routes/app.index.tsx:37-126`) calls `authenticateAdmin({ request: context.request, env: context.env })` and uses the returned `admin.graphql(...)`. Same operations (`productCreate`, `productVariantsBulkUpdate`), same `#graphql` inline tags, same `response.json()` pattern, same mutation names (`populateProduct`, `shopifyReactRouterTemplateUpdateVariant`).

### `admin.graphql` return shape

Template wraps `@shopify/shopify-api`'s `GraphqlClient.request` (returns a parsed `RequestReturn` object) in `new Response(JSON.stringify(apiResponse))` so callers can `.json()` (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/graphql.ts:22-31`).

This port: `buildAdminContext` in `src/lib/Shopify.ts` does the same with `Response.json(apiResponse)`.

### Auth behavior feeding `admin.graphql`

Template's `authenticate.admin(request)` provides: session-token validation, offline token exchange, embedded-URL redirect, exit-iframe bounce. Port's `authenticateAdmin` (`src/lib/Shopify.ts:213-304`) implements all of the above against D1 + Web API, and `src/routes/auth.$.tsx:8-18` wires the `/auth/$` handler analogous to template's `auth.$` loader.

### Codegen scaffolding (configured but unused — matches template)

Template ships `.graphqlrc.ts`, `@shopify/api-codegen-preset`, `graphql-config`, and a `graphql-codegen` script (`refs/shopify-app-template/.graphqlrc.ts:9-14`, `refs/shopify-app-template/package.json:18,43,57`) — but **no file under `refs/shopify-app-template/app/` imports generated types**. Template's `app._index.tsx` reads `responseJson.data!.productCreate!.product!` untyped. Output dir `./app/types` is not listed in `.gitignore` because codegen is never expected to run in the template flow.

This port mirrors that: codegen scaffolding present, nothing consumes it. Output dir `./src/types` (port's source root is `./src` vs template's `./app`).

## Deviations to accommodate TanStack Start + Cloudflare

- **No `@shopify/shopify-app-react-router` dep.** The port uses `@shopify/shopify-api` directly and re-implements the `authenticate.admin` / `addDocumentResponseHeaders` / `login` surface in `src/lib/Shopify.ts`. Template's package ships only a `node` adapter (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/adapters/node/index.ts`); the port runs on Workers via `@shopify/shopify-api/adapters/web-api` (`src/lib/Shopify.ts:1`).
- **Session storage is D1, not Prisma.** Template uses `PrismaSessionStorage` (`refs/shopify-app-template/app/shopify.server.ts:17`); this port persists sessions directly in D1 via `storeShopifySession` / `loadShopifySession` / `deleteShopifySessionsByShop` (`src/lib/Shopify.ts:92-148`).
- **Route wiring is TanStack, not React Router.** Template guards `/app` with a `loader` calling `authenticate.admin(request)`; this port guards `/app` in `beforeLoad` via a `createServerFn` that calls `authenticateAdmin` and propagates `Response` redirects (`src/routes/app.tsx:39-54`).
- **Server fn inputs vs loader args.** Template actions receive `{ request }` from React Router; this port reads `context.request` from the TanStack server-fn context (`src/worker.ts:99-103` declares `ServerContext` with `env`, `request`, `runEffect`).
- **`apiVersion: January26`** (`src/lib/Shopify.ts:77`, `.graphqlrc.ts`) vs template's `October25`.
- **Handwritten response interfaces in `src/routes/app.index.tsx:8-35`** (`GeneratedVariant` / `GeneratedProduct` / `ShopifyGraphqlResponse`) where template leaves the response untyped. See "What's left" below.

## What's left for GraphQL parity

### Drop the handwritten GraphQL response interfaces

Template reads GraphQL responses untyped (`responseJson.data!.productCreate!.product!`, `refs/shopify-app-template/app/routes/app._index.tsx:58`). Port defines `GeneratedVariant` / `GeneratedProduct` / `ShopifyGraphqlResponse` and threads them through generics on each `.json()` call (`src/routes/app.index.tsx:8-35,76-80,111-115`).

To match template: delete those interfaces and the explicit `: ShopifyGraphqlResponse<…>` annotations on `productCreateJson` / `productVariantsBulkUpdateJson`. Keep the runtime guards (`if (!product)` / `if (!variantId)`) — template's naked non-null assertions are not an improvement worth copying.

That's it for GraphQL parity. `admin.graphql` call shape, response wrapping, operations, and upstream auth are all already matched.

## Explicitly not pursuing: `@shopify/shopify-app-react-router/server`

This library is tied to React Router — its name, its types (`LoaderFunctionArgs`-shaped returns, redirect `Response` semantics aligned with RR loaders), and its docs all assume a React Router host. TanStack Start is not that host. Adopting it would mean:

- Pulling a framework-specific dep into a project whose framework it doesn't match.
- Bending our route wiring around abstractions designed for RR loaders/actions rather than TanStack `beforeLoad` + server fns.
- Paying the surface cost of `shopifyApp` (webhooks, billing, POS, flow, fulfillment-service) when we only need admin auth.
- Tracking a pre-2.0 library (`1.2.0`) with likely breaking changes.

The current hand-rolled auth in `src/lib/Shopify.ts` sits on `@shopify/shopify-api` directly (the same dep the React Router library wraps) and is small enough that the cost of owning it is lower than the cost of adopting a framework-mismatched abstraction. Leave it alone.
