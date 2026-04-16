# Shopify phase 2 research (embedded shell + document headers)

## Goal

Phase 2 should move this repo from "auth plumbing works" to "embedded app shell parity" with the official React Router template, while staying TanStack Start + Cloudflare + D1.

## Grounding sources scanned

- Official template: `refs/shopify-app-template`
- Shopify app package internals: `refs/shopify-app-js/packages/apps/shopify-app-react-router`
- TanStack Start docs and examples: `refs/tan-start/docs/start/framework/react/guide` and `refs/tan-start/e2e/react-start/server-routes-global-middleware`
- Shopify docs: `refs/shopify-docs/docs/apps/build`

## Current repo baseline

- `/app` is still server-only and returns plain text (`src/routes/app.ts:40`).
- Root document shell is generic and does not include App Bridge/Polaris script setup (`src/routes/__root.tsx:50`).
- Phase 1 auth/webhook/session foundation is in place (`src/routes/auth.ts:5`, `src/routes/auth.callback.ts:5`, `src/routes/webhooks.app.uninstalled.ts:5`).

## What the official template does for this phase

### 1) Wrap embedded routes with an app shell provider

Template route layout:

- `<AppProvider embedded apiKey={apiKey}>` (`refs/shopify-app-template/app/routes/app.tsx:19`)
- app nav links inside the embedded shell (`refs/shopify-app-template/app/routes/app.tsx:20`)

Underlying provider behavior from `shopify-app-js`:

- inject App Bridge script when embedded (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:103`)
- always inject Polaris web components script (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:104`)
- handle `shopify:navigate` and route via client router navigate (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:125`)

Important portability constraint:

- provider uses React Router APIs directly (`useNavigate` import from `react-router`) (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:2`)
- package positioning is React Router-specific (`refs/shopify-app-js/packages/apps/shopify-app-react-router/README.md:8`)

Implication: recreate equivalent provider behavior with TanStack Router primitives; do not import the template provider directly.

### 2) Add Shopify document response headers

Template applies document headers in server entry:

- `addDocumentResponseHeaders(request, responseHeaders)` (`refs/shopify-app-template/app/entry.server.tsx:17`)

`shopify-app-js` helper behavior:

- adds `Link` preconnect/preload for CDN/App Bridge/Polaris (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/add-response-headers.ts:30`)
- sets embedded CSP `frame-ancestors` for shop + admin domains (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/add-response-headers.ts:39`)

### 3) Keep embedded auth request invariants

`shopify-app-js` admin auth path enforces embedded query invariants:

- validate `shop`/`host` and redirect to login path when invalid (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/validate-shop-and-host-params.ts:13`)
- enforce embedded=1 when required (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/ensure-app-is-embedded-if-required.ts:16`)
- bounce to patch session token page when `id_token` missing (`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/ensure-session-token-search-param-if-required.ts:21`)

For this repo, phase 2 should preserve current auth semantics and not regress iframe flow.

## TanStack Start capabilities we should use

- Server routes are suitable for auth/raw HTTP endpoints (`refs/tan-start/docs/start/framework/react/guide/server-routes.md:6`).
- Loaders are isomorphic, so keep Shopify-secret logic inside server-only boundaries (`refs/tan-start/docs/start/framework/react/guide/execution-model.md:31`).
- Global request middleware can run before every request, including SSR/server routes/server functions (`refs/tan-start/docs/start/framework/react/guide/middleware.md:431`).
- Server response headers/status are settable via server context utilities (`refs/tan-start/docs/start/framework/react/guide/server-functions.md:271`).
- Server entry is fetch-based and Cloudflare-compatible when custom handling is needed (`refs/tan-start/docs/start/framework/react/guide/server-entry-point.md:11`).

## Recommended phase 2 scope

1. Add TanStack-native embedded shell for `/app` document routes.
2. Add Shopify document response headers for HTML responses.
3. Keep phase 1 auth/session behavior stable.

Out of scope for phase 2:

- full app feature parity pages
- scope-update webhook behavior changes
- token-exchange migration

## Proposed implementation plan

### A) Convert `/app` from plain text endpoint to app shell route

- Replace `src/routes/app.ts` with a route component form (`src/routes/app.tsx`) plus server-validated data path.
- Keep auth/session verification server-only (prefer `createServerFn` called from loader).
- Return minimal shell data: `apiKey`, `shop`, `host` (sanitized).

Why:

- this matches template route role where `/app` is the embedded app layout (`refs/shopify-app-template/app/routes/app.tsx:15`).

### B) Implement a TanStack-native embedded provider component

Create a local provider component mirroring the official behavior:

- if embedded: inject App Bridge script with `data-api-key`
- always inject Polaris script
- subscribe to `shopify:navigate` and route with TanStack `useNavigate`

This recreates the concrete behavior shown in `shopify-app-js` provider (`AppProvider.tsx:103`, `AppProvider.tsx:104`, `AppProvider.tsx:125`).

### C) Add document headers centrally

Use global request middleware (`src/start.ts`) to apply response headers for HTML/doc requests:

- set `Content-Security-Policy` `frame-ancestors ...` for embedded docs
- set `Link` preconnect/preload headers for Shopify CDN/App Bridge/Polaris

Why middleware path:

- runs for SSR + server routes + server functions (`refs/tan-start/docs/start/framework/react/guide/middleware.md:431`)
- keeps header behavior centralized and not duplicated per route.

### D) Add a minimal additional embedded page

- Add `/app/additional` page and expose it in app nav.
- This aligns with template's baseline multi-page nav shape (`refs/shopify-app-template/app/routes/app.additional.tsx:1`).

## Acceptance criteria for phase 2

1. Opening app in Shopify admin renders HTML shell, not plain text.
2. Response includes Shopify-compatible document headers (`frame-ancestors` + preload links).
3. Embedded nav works through `shopify:navigate` -> TanStack router navigation.
4. Existing auth routes and uninstall webhook continue to pass local install loop.
5. `pnpm typecheck` and `pnpm lint` pass.

## Risks and guardrails

- Header over-application risk: avoid adding Shopify CSP to non-document responses.
- Query-param dependency risk: missing `shop`/`host` must still redirect into auth path, not silently render broken shell.
- Keep phase2 focused: do not combine with token-exchange migration or webhook model redesign.

## Suggested file targets

- `src/routes/app.tsx` (route shell + guarded loader/server fn)
- `src/routes/app.additional.tsx` (second embedded page)
- `src/components/shopify/EmbeddedAppProvider.tsx` (local provider equivalent)
- `src/start.ts` (global request middleware for response headers)
- `src/lib/ShopifyDocumentHeaders.ts` (header builder utility)
