# Shopify phase 3 app surface parity research

Phase 1 and phase 2 are complete. This doc scopes phase 3: app surface parity with the official template (`/app`, `/app/additional`) and TanStack-native server-side Admin API wiring.

## Source of truth

- Template app shell/nav: `refs/shopify-app-template/app/routes/app.tsx`
- Template app index + Admin API mutation demo: `refs/shopify-app-template/app/routes/app._index.tsx`
- Template additional page: `refs/shopify-app-template/app/routes/app.additional.tsx`
- TanStack Router route lifecycle (`beforeLoad` serial, `loader` parallel): `refs/tan-router/docs/router/guide/data-loading.md:14-25`
- TanStack Start server functions (`createServerFn` callable from loaders/components): `refs/tan-start/docs/start/framework/react/guide/server-functions.md:8-9`, `refs/tan-start/docs/start/framework/react/guide/server-functions.md:43-50`
- Shopify session-token requirement for backend requests: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:33`, `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md:31-33`

## What the template does for phase 3

- App nav has two links under embedded shell:
  - Home: `refs/shopify-app-template/app/routes/app.tsx:21`
  - Additional page: `refs/shopify-app-template/app/routes/app.tsx:22`
- `/app` index route combines auth + Admin API demo:
  - `loader` checks auth via `authenticate.admin(request)`: `refs/shopify-app-template/app/routes/app._index.tsx:12-16`
  - `action` runs `productCreate` and `productVariantsBulkUpdate` via `admin.graphql`: `refs/shopify-app-template/app/routes/app._index.tsx:18-85`
  - UI triggers mutation and renders JSON output: `refs/shopify-app-template/app/routes/app._index.tsx:104-190`
  - UI uses App Bridge toast + edit intent: `refs/shopify-app-template/app/routes/app._index.tsx:95-99`, `refs/shopify-app-template/app/routes/app._index.tsx:150-155`
- `/app/additional` provides second in-app page content: `refs/shopify-app-template/app/routes/app.additional.tsx:3-35`

## Current repo status

- `/app` already has parent auth guard in `beforeLoad` through `createServerFn`: `src/routes/app.tsx:7-54`
- Embedded shell parity is already in place: `src/routes/app.tsx:61-67`
- Current nav only has Home (missing additional page link): `src/routes/app.tsx:62-64`
- Current `/app` index is static connected-state UI (no Admin API mutation demo): `src/routes/app.index.tsx:10-16`
- Backend auth/Admin primitive already exists and is reusable:
  - `authenticateAdmin`: `src/lib/Shopify.ts:213-304`
  - returns `admin.graphql` client: `src/lib/Shopify.ts:312-317`

## Gap analysis vs template parity

- Missing route/page parity for `/app/additional`
- Missing nav parity (`Additional page` link)
- Missing app-index mutation workflow (`Generate a product`, JSON payload display)
- Missing App Bridge interaction parity (`toast`, `edit:shopify/Product` intent) in route components
- Scope mismatch for template mutation example:
  - template requests `write_products`: `refs/shopify-app-template/shopify.app.toml:6`
  - local app config currently has empty scopes: `.shopify-cli/shopify.app.toml:21`

## TanStack-native implementation shape (recommended)

1. Keep parent `/app` auth in `beforeLoad` (already aligned with TanStack guidance that `beforeLoad` runs before child route loading): `refs/tan-router/docs/router/guide/authenticated-routes.md:10-12`, `refs/tan-router/docs/router/guide/authenticated-routes.md:24`
2. Add `src/routes/app.additional.tsx` for `/app/additional`
3. Add nav link in `src/routes/app.tsx` to `/app/additional`
4. Replace static `src/routes/app.index.tsx` with:
   - POST `createServerFn` for product generation
   - client-side loading state + result rendering
   - optional App Bridge toast + edit intent parity
5. Reuse existing `authenticateAdmin` + `admin.graphql` in the server function handler

## Auth nuance for phase 3 server-function calls

Shopify requires session-token auth on backend requests from embedded frontend:

- Session token in authorization header: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:33`
- Fetch a fresh token each request (1 minute TTL): `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:45`
- Backend must authenticate incoming requests: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md:31-33`

Current backend supports header token auth path (`src/lib/Shopify.ts:239-242`), so phase 3 should verify TanStack server-function requests carry this header in embedded runtime. If not, add a request path that supplies a valid token-bearing request before calling `authenticateAdmin`.

## Proposed implementation slices

1. Route parity slice: add `/app/additional` and nav link
2. Mutation slice: add `generateProduct` server function and UI wiring in `/app`
3. Session-token slice: verify/fix token transport for server-function requests
4. Scope slice: set `write_products` and reinstall so offline token reflects new scope
5. Validation slice: manual in-app check + `pnpm typecheck` + `pnpm lint`

## Verification checklist

- `/app` nav shows Home + Additional page
- `/app/additional` renders under embedded shell without auth regressions
- Generate-product action succeeds and renders both GraphQL payload blocks
- No iframe/auth redirect loop on mutation request path
- Static checks pass (`pnpm typecheck`, `pnpm lint`)
