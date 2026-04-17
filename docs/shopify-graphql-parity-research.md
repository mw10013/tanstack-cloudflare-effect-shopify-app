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
- `refs/shopify-codegen/` is currently empty in this workspace.

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
  - This port's `app.index` currently instantiates `shopify.clients.Graphql` directly (`src/routes/app.index.tsx:68`) instead of reusing returned `admin.graphql` wrapper.

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

## Bottom line

- Template uses GraphQL via `authenticate.admin` + `admin.graphql`, and ships codegen scaffolding.
- This project uses GraphQL in a functionally similar way for runtime behavior, but with custom Cloudflare/TanStack auth plumbing.
- This project currently does not use codegen.
