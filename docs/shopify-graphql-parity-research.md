# Shopify GraphQL parity with `refs/shopify-app-template`

How this port matches template, where it deviates for TanStack Start + Cloudflare, and what's left.

## Parity with template

### Route usage

Template: `loader`/`action` calls `authenticate.admin(request)` and uses the returned `admin.graphql(...)` (`refs/shopify-app-template/app/routes/app._index.tsx:18-23,58`).

This port: `generateProduct` server fn (`src/routes/app.index.tsx`) calls `authenticateAdmin({ request: context.request, env: context.env })` and uses the returned `admin.graphql(...)`. Same operations (`productCreate`, `productVariantsBulkUpdate`), same `#graphql` inline tags, same `response.json()` pattern.

### `admin.graphql` return shape

Template wraps `@shopify/shopify-api`'s `GraphqlClient.request` (returns a parsed `RequestReturn` object) in `new Response(JSON.stringify(apiResponse))` so callers can `.json()` (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/graphql.ts:22-31`).

This port: `buildAdminContext` in `src/lib/Shopify.ts` does the same with `Response.json(apiResponse)`.

### Auth behavior

Template `authenticate.admin(request)` provides: session-token validation, offline token exchange, embedded-URL redirect, exit-iframe bounce. This port's `authenticateAdmin` (`src/lib/Shopify.ts:213-304`) implements all of the above against D1 + Web API, and `src/routes/auth.$.tsx:8-18` wires the `/auth/$` handler analogous to template's `auth.$` loader.

### Codegen scaffolding

Template: `.graphqlrc.ts` + `@shopify/api-codegen-preset` + `graphql-config` dev deps + `graphql-codegen` script. Generated files live under `./app/types` and are not committed (`refs/shopify-app-template/.graphqlrc.ts:9-14`, `refs/shopify-app-template/package.json:18,43,57`).

This port: same shape. Generated files live under `./src/types` (the analogue of template's `./app/types` — template's source root is `app/`, ours is `src/`). Not committed. See "Codegen: configured but not yet in use" below for the actual status.

## Deviations to accommodate TanStack Start + Cloudflare

- **No `@shopify/shopify-app-react-router` dep.** The port uses `@shopify/shopify-api` directly and re-implements the `authenticate.admin` / `addDocumentResponseHeaders` / `login` surface in `src/lib/Shopify.ts`. Template's package ships only a `node` adapter (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/adapters/node/index.ts`); the port runs on Workers via `@shopify/shopify-api/adapters/web-api` (`src/lib/Shopify.ts:1`).
- **Session storage is D1, not Prisma.** Template uses `PrismaSessionStorage` (`refs/shopify-app-template/app/shopify.server.ts:17`); this port persists sessions directly in D1 via `storeShopifySession` / `loadShopifySession` / `deleteShopifySessionsByShop` (`src/lib/Shopify.ts:92-148`).
- **Route wiring is TanStack, not React Router.** Template guards `/app` with a `loader` calling `authenticate.admin(request)`; this port guards `/app` in `beforeLoad` via a `createServerFn` that calls `authenticateAdmin` and propagates `Response` redirects (`src/routes/app.tsx:39-54`).
- **Server fn inputs vs loader args.** Template actions receive `{ request }` from React Router; this port reads `context.request` from the TanStack server-fn context (`src/worker.ts:99-103` declares `ServerContext` with `env`, `request`, `runEffect`).
- **`apiVersion: January26`** (`src/lib/Shopify.ts:77` and `.graphqlrc.ts`) vs template's `October25` — newer stable Shopify API version.
- **`@shopify/polaris-types` activation + `s-app-nav` augmentation.** Both live at the top of `src/routes/app.tsx` — the embedded-app subtree where Polaris and App Bridge elements render. `tsconfig.json` lists `@shopify/polaris-types` in `compilerOptions.types` identically to template (`refs/shopify-app-template/tsconfig.json:19`). React 18 (template) exposes JSX globally, so tsconfig `types` alone activates the augmentation. Our `@types/react` 19 scopes JSX inside the `react` module, so only the package's `declare module 'react'` blocks apply — and module augmentation only fires when the containing module is imported from a runtime file (a `.d.ts` alone is not enough). Type-only side-effect import `import type {} from "@shopify/polaris-types";` activates it without runtime resolution (package ships only a `types` export condition — a value import breaks Vite dep-scan; `import type` is erased). Empty specifier `{}` trips oxlint's `unicorn/require-module-specifiers`, disabled inline since there's no value to name. `s-app-nav` is an App Bridge element not covered by `@shopify/polaris-types`; template uses it untyped and accepts the error (`refs/shopify-app-template/app/routes/app.tsx:20-23`), this port augments it locally in the same file. Residual gap: `s-app-nav` is an App Bridge element not covered by `@shopify/polaris-types`; template has the same untyped usage at `refs/shopify-app-template/app/routes/app.tsx:20-23`.

## Codegen: configured but not yet in use

Codegen is wired but nothing in the repo actually consumes generated types yet. `src/routes/app.index.tsx:8-35` still defines handwritten `GeneratedVariant` / `GeneratedProduct` / `ShopifyGraphqlResponse` interfaces for the mutation responses.

To start using codegen (matches template's intended workflow per `refs/shopify-app-js/packages/api-clients/api-codegen-preset/README.md:287-365`):

1. **Run codegen once** (needs network — the preset fetches the Admin schema):
   ```sh
   pnpm graphql-codegen
   ```
   This writes `src/types/admin.schema.json`, `src/types/admin.types.d.ts`, `src/types/admin.generated.d.ts` (three files produced by `shopifyApiProject`, mirroring template's `./app/types/` output).

2. **Register the generated module augmentation** so `@shopify/shopify-api` client types are overloaded with per-operation variable + return types. Add once to a module in the server graph (e.g. top of `src/lib/Shopify.ts`):
   ```ts
   import "@/types/admin.generated.d.ts";
   ```
   Template does this via the preset's `module` option which defaults to the shopify client package; ambient import is sufficient (`refs/shopify-app-js/packages/api-clients/api-codegen-preset/README.md:341`).

3. **Replace handwritten interfaces** in `src/routes/app.index.tsx:8-35`. Generated types come from the `populateProduct` and `shopifyReactRouterTemplateUpdateVariant` operation names:
   ```ts
   import type { PopulateProductMutation, ShopifyReactRouterTemplateUpdateVariantMutation } from "@/types/admin.generated";
   ```
   Then type `response.json()` results with those.

4. **Rerun codegen whenever operations change.** Dev flow uses `--watch`:
   ```sh
   pnpm graphql-codegen -- --watch
   ```

5. **(Optional)** Commit the generated files — template does not, so keeping `src/types/` in `.gitignore` matches template exactly.

Output-location parity check: template writes to `./app/types` because its source root is `./app`; this port writes to `./src/types` because its source root is `./src`. Same relative placement, different top-level dir due to framework conventions.

## What remains for full parity

### Adopt `@shopify/shopify-app-react-router/server`

This would remove the hand-rolled `authenticateAdmin` / `addDocumentResponseHeaders` / `shopifyLogin` in `src/lib/Shopify.ts` in favor of `shopifyApp({ ... }).authenticate.admin(request)` etc., matching `refs/shopify-app-template/app/shopify.server.ts:10-34`.

Portability check:
- The package's only shipped adapter is `node` (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/adapters/node/index.ts`). It's thin — just `setAbstractRuntimeString(...)` + optional `APP_BRIDGE_URL`. Safe to skip on Workers; import `/server` directly after importing `@shopify/shopify-api/adapters/web-api`.
- Runtime abstraction is delegated to `@shopify/shopify-api`, which already works on Workers in this repo.
- `SessionStorage` interface is minimal (`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/src/types.ts:6-41`): `storeSession`, `loadSession`, `deleteSession`, `deleteSessions`, `findSessionsByShop`. Implement on top of existing D1 helpers (`src/lib/Shopify.ts:92-148`).

Steps:
1. Add dep `@shopify/shopify-app-react-router` (template uses `^1.1.0`).
2. Implement `D1SessionStorage` class against the `SessionStorage` interface, wrapping the current D1 helpers.
3. Add a `getShopify(env)` builder around `shopifyApp({ apiKey, apiSecretKey, apiVersion, scopes, appUrl, sessionStorage: new D1SessionStorage(env), distribution: AppStore, future: { expiringOfflineAccessTokens: true } })` mirroring `refs/shopify-app-template/app/shopify.server.ts:10-25`.
4. Replace `authenticateAdmin` / `addDocumentResponseHeaders` / `shopifyLogin` call sites with `shopify.authenticate.admin(request)` / `shopify.addDocumentResponseHeaders` / `shopify.login` (`refs/shopify-app-template/app/shopify.server.ts:30-32`).
5. Keep TanStack wiring (`beforeLoad` in `src/routes/app.tsx:39-54`, `/auth/$` GET handler in `src/routes/auth.$.tsx:8-18`) but route through library-provided functions.

Fallback: if the package pulls Node-only code that can't be tree-shaken on Workers, keep hand-rolled `authenticateAdmin` but expose it behind the exact template signature `authenticate.admin(request)` so downstream route code stays identical.

### Switch route code to generated types

Once step 1 of "Codegen" above runs, delete the handwritten interfaces in `src/routes/app.index.tsx:8-35` and use the generated `PopulateProductMutation` / `ShopifyReactRouterTemplateUpdateVariantMutation` types.
