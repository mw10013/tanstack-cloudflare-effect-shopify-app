# Shopify GraphQL parity research

Question: how `refs/shopify-app-template` sets up/uses GraphQL, whether this repo matches, and whether codegen is used in each.

## Sources scanned

- Template runtime + GraphQL usage:
  - `refs/shopify-app-template/app/shopify.server.ts`
  - `refs/shopify-app-template/app/routes/app.tsx`
  - `refs/shopify-app-template/app/routes/auth.$.tsx`
  - `refs/shopify-app-template/app/routes/app._index.tsx`
- Template codegen config:
  - `refs/shopify-app-template/.graphqlrc.ts`
  - `refs/shopify-app-template/package.json`
- Shopify docs + package docs:
  - `refs/shopify-docs/docs/api/shopify-app-react-router/v1/apis/admin-api.md`
  - `refs/shopify-docs/docs/api/shopify-app-react-router/v1/guide-graphql-types.md`
  - `refs/shopify-app-js/packages/apps/shopify-api/docs/guides/graphql-types.md`
  - `refs/shopify-app-js/packages/api-clients/api-codegen-preset/README.md`
  - `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/types.ts`
- This port:
  - `src/lib/Shopify.ts`
  - `src/routes/app.tsx`
  - `src/routes/auth.$.tsx`
  - `src/routes/app.index.tsx`
  - `package.json`
- `refs/shopify-codegen/` (now populated with `@shopify/api-codegen-preset` 1.2.2 source) — see `refs/shopify-codegen/packages/api-clients/api-codegen-preset/`.

## How the template sets up and uses GraphQL

1) Auth + admin context is provided by `shopifyApp`

- `refs/shopify-app-template/app/shopify.server.ts:10-34` initializes `shopifyApp(...)` and exports `authenticate`.
- Route loaders/actions then call `authenticate.admin(request)`.
  - `refs/shopify-app-template/app/routes/app.tsx:8-13`
  - `refs/shopify-app-template/app/routes/auth.$.tsx:6-10`

2) GraphQL calls are through `admin.graphql`

- `refs/shopify-app-template/app/routes/app._index.tsx:18-85` calls `admin.graphql(...)` for:
  - `productCreate`
  - `productVariantsBulkUpdate`
- Queries are inline template strings tagged with `#graphql` (`refs/shopify-app-template/app/routes/app._index.tsx:24`, `refs/shopify-app-template/app/routes/app._index.tsx:59`).

3) This matches Shopify guidance for app-router apps

- Docs example shows same shape: `const { admin } = await authenticate.admin(request); const response = await admin.graphql(...)` in `refs/shopify-docs/docs/api/shopify-app-react-router/v1/apis/admin-api.md:175-206`.

## Does template use codegen?

Yes, template is scaffolded for codegen.

- `refs/shopify-app-template/package.json:18` has script: `"graphql-codegen": "graphql-codegen"`.
- `refs/shopify-app-template/package.json:43` has dev dependency `@shopify/api-codegen-preset`.
- `refs/shopify-app-template/package.json:57` has `graphql-config`.
- `refs/shopify-app-template/.graphqlrc.ts:9-14` configures `shopifyApiProject({ apiType: ApiType.Admin, ... outputDir: "./app/types" })`.

Important nuance: template is configured for codegen, but generated files are not committed in this snapshot (`refs/shopify-app-template/app/types/` absent).

## How this project sets up and uses GraphQL

1) Auth/admin context is implemented manually (Cloudflare + TanStack Start)

- `src/lib/Shopify.ts:68-80` builds `shopifyApi(...)` from `@shopify/shopify-api`.
- `src/lib/Shopify.ts:213-304` implements `authenticateAdmin` (session token decode, offline token exchange, D1 session load/store).
- `src/lib/Shopify.ts:312-317` returns an `admin.graphql`-style function backed by `new shopify.clients.Graphql({ session })`.

2) Route guard integration is TanStack-native, not React Router loader pattern

- `src/routes/app.tsx:39-54` guards `/app` in `beforeLoad` via `createServerFn`.
- `src/routes/auth.$.tsx:8-18` wires `/auth/$` GET handler to `authenticateAdmin`, analogous to template `auth.$` loader.

3) GraphQL mutation demo exists and is near-parity

- `src/routes/app.index.tsx:71-150` runs the same two mutations (`productCreate`, `productVariantsBulkUpdate`) and parses JSON.
- It also uses `#graphql` tags (`src/routes/app.index.tsx:72`, `src/routes/app.index.tsx:118`).

## Is GraphQL set up/used in the same way?

Short answer: mostly same runtime behavior, different implementation details, and not same codegen setup.

- Same:
  - Embedded-app auth gate before app pages.
  - Offline session-based Admin API access.
  - `#graphql` inline operations.
  - Product demo mutations on app index.
- Different:
  - Template uses `@shopify/shopify-app-react-router` (`authenticate.admin` + `admin.graphql`) directly.
  - This port re-implements that flow in `src/lib/Shopify.ts` for TanStack Start + Cloudflare.
  - This port's `app.index` currently instantiates `shopify.clients.Graphql` directly (`src/routes/app.index.tsx:52`) instead of reusing the returned `admin.graphql` wrapper. It also re-loads the offline session by shop instead of going through `authenticateAdmin`.

Given project goal (port template to TanStack Start + Cloudflare), this is conceptually aligned on runtime outcomes, but not identical at framework helper/tooling level.

## Why this project does not use codegen

Evidence in this repo:

- No `.graphqlrc.ts` in root.
- No `graphql-codegen` script in `package.json`.
- No `@shopify/api-codegen-preset` or `graphql-config` deps in `package.json`.
- No generated files like `admin.generated.d.ts`.
- GraphQL response shapes are handwritten interfaces in `src/routes/app.index.tsx:7-34`.

What Shopify docs/packages indicate:

- Codegen is an opt-in enhancement, not required for runtime.
  - `refs/shopify-docs/docs/api/shopify-app-react-router/v1/guide-graphql-types.md:17-20` says you can use codegen by installing packages and running `graphql-codegen`.
- For typed operations with `@shopify/shopify-api`, direct deps are expected.
  - `refs/shopify-app-js/packages/apps/shopify-api/docs/guides/graphql-types.md:33-35` says clients should be direct dependencies so codegen can overload types.
- Preset package explicitly exists for this purpose.
  - `refs/shopify-app-js/packages/api-clients/api-codegen-preset/README.md:8-12`.

Inference: this port prioritized auth/runtime parity and omitted optional dev-time GraphQL typegen wiring.

## Review: is the research sound?

Mostly yes. Corrections folded in above:

- `src/routes/app.index.tsx:68` → actual call site is `src/routes/app.index.tsx:52`.
- `refs/shopify-codegen/` is now populated (not empty).
- Previously missing nuance: the port's `app.index` also bypasses `authenticateAdmin` and re-derives the session from `shop` (`src/routes/app.index.tsx:37-52`), so it skips session-token validation + token-exchange-on-expiry that `authenticateAdmin` (`src/lib/Shopify.ts:213-304`) provides.

Otherwise all line-range citations, package.json evidence, and "same vs different" claims check out against current tree.

## What must we do to align this codebase with `refs/shopify-app-template`?

Goal: match template's GraphQL setup/usage as closely as Cloudflare Workers + TanStack Start allow. Remaining gaps + concrete steps:

### 1) Stop bypassing `authenticateAdmin` in routes

Template never constructs a GraphQL client by hand; every route goes through `authenticate.admin(request)` and uses the returned `admin.graphql` (`refs/shopify-app-template/app/routes/app._index.tsx:18-23,58`).

- Refactor `src/routes/app.index.tsx` `generateProduct` server fn to call `authenticateAdmin({ request, env })` and use `admin.graphql(...)` instead of `new shopify.clients.Graphql({ session })` (`src/routes/app.index.tsx:40-52`).
- Remove the `shop` input / `loadShopifySession` path from the server fn — template actions take only the request. This recovers session-token validation and offline-token refresh on expiry (`src/lib/Shopify.ts:282-303`).

### 2) Adopt `@shopify/shopify-app-react-router/server` where it's portable

Template delegates auth, boundary helpers, `addDocumentResponseHeaders`, and `admin.graphql` to `shopifyApp()` (`refs/shopify-app-template/app/shopify.server.ts:10-34`). This port re-implements the same surface in `src/lib/Shopify.ts`.

Portability check:
- `@shopify/shopify-app-react-router/server` operates on standard `Request`/`Response` and delegates runtime abstraction to `@shopify/shopify-api` (which already works via `adapters/web-api` in this repo — `src/lib/Shopify.ts:1`).
- Only adapter shipped is `adapters/node` (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/adapters/node/index.ts`). It just calls `setAbstractRuntimeString(...)` and reads `APP_BRIDGE_URL`. Safe to skip on Workers; import `/server` directly after importing `@shopify/shopify-api/adapters/web-api`.
- `SessionStorage` interface is minimal (`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/src/types.ts:6-41`) — `storeSession`, `loadSession`, `deleteSession`, `deleteSessions`, `findSessionsByShop`. Implement on top of existing D1 helpers in `src/lib/Shopify.ts:92-148`.

Steps:
- Add dep `@shopify/shopify-app-react-router` (pin to latest 1.x; template uses `^1.1.0`).
- Create `D1SessionStorage` implementing `SessionStorage`, wrapping current D1 logic.
- Add a `getShopify(env)` builder around `shopifyApp({ apiKey, apiSecretKey, apiVersion, scopes, appUrl, sessionStorage: new D1SessionStorage(env), distribution: AppStore, future: { expiringOfflineAccessTokens: true } })` mirroring `refs/shopify-app-template/app/shopify.server.ts:10-25`.
- Replace `authenticateAdmin` callers with `shopify.authenticate.admin(request)`; replace `addDocumentResponseHeaders` with `shopify.addDocumentResponseHeaders`; replace `shopifyLogin` with `shopify.login` (`refs/shopify-app-template/app/shopify.server.ts:30-32`).
- Keep TanStack wiring (`beforeLoad` in `src/routes/app.tsx:39-54`, `auth.$` GET handler in `src/routes/auth.$.tsx:8-18`) but have them call the library-provided functions.

If the react-router package turns out to pull unshakeable Node-only code in practice (e.g. `crypto`, streams), fall back to keeping the hand-rolled `authenticateAdmin` but still expose it with the template's `authenticate.admin(request)` signature so downstream route code is identical.

### 3) Add codegen scaffolding (dev-time parity)

Template ships codegen but doesn't commit outputs (`refs/shopify-app-template/package.json:18,43,57`, `refs/shopify-app-template/.graphqlrc.ts:9-14`). Match that:

- Add dev deps: `@shopify/api-codegen-preset`, `graphql-config` (script uses `graphql-codegen` CLI provided by the preset).
- Add `package.json` script: `"graphql-codegen": "graphql-codegen"`.
- Add `.graphqlrc.ts` at repo root modeled on `refs/shopify-app-template/.graphqlrc.ts` but targeting TanStack dirs:
  - `apiType: ApiType.Admin`
  - `apiVersion: ApiVersion.January26` (match `src/lib/Shopify.ts:77`)
  - `documents: ["./src/**/*.{ts,tsx}"]`
  - `outputDir: "./src/types"` (add to `.gitignore` if matching template's "configured but not committed" choice)
- Delete handwritten response interfaces in `src/routes/app.index.tsx:8-35` and switch to generated types once codegen runs. Per `refs/shopify-app-js/packages/apps/shopify-api/docs/guides/graphql-types.md:33-35`, keep `@shopify/shopify-api` as a direct dep so client types are overloaded.

### 4) Docs/meta nits

- After step 2, update `docs/shopify-graphql-parity-research.md` "Different" section — custom auth plumbing disappears.
- If staying on `@shopify/shopify-api` directly (skip step 2), still do steps 1 and 3 — they're independent.

## Bottom line

- Template uses GraphQL via `authenticate.admin` + `admin.graphql`, and ships codegen scaffolding.
- This project uses GraphQL in a functionally similar way for runtime behavior, but with custom Cloudflare/TanStack auth plumbing and no codegen.
- Full alignment = (1) route uses `authenticate.admin` + `admin.graphql`, (2) adopt `shopify-app-react-router/server` + D1 `SessionStorage`, (3) add `.graphqlrc.ts` + codegen deps/script.
