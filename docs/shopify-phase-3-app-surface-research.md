# Shopify phase 3 app surface parity research

Phase 3 is complete. This doc records completion evidence and any remaining non-phase-3 gaps.

## Source of truth

- Template app shell/nav: `refs/shopify-app-template/app/routes/app.tsx`
- Template app index + Admin API mutation demo: `refs/shopify-app-template/app/routes/app._index.tsx`
- Template additional page: `refs/shopify-app-template/app/routes/app.additional.tsx`
- TanStack Router route lifecycle (`beforeLoad` serial, `loader` parallel): `refs/tan-router/docs/router/guide/data-loading.md:14-25`
- TanStack Start server functions (`createServerFn` callable from loaders/components): `refs/tan-start/docs/start/framework/react/guide/server-functions.md:8-9`, `refs/tan-start/docs/start/framework/react/guide/server-functions.md:43-50`
- Shopify session-token requirement for backend requests: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:33`, `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md:31-33`

## What the template requires for phase 3

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

- `/app` auth guard remains parent-level in `beforeLoad` via `createServerFn`: `src/routes/app.tsx:42-89`
- Embedded shell parity remains in place: `src/routes/app.tsx:97-103`
- `/app` nav now includes both links required by template parity:
  - Home + Additional page: `src/routes/app.tsx:99-100`
- `/app/additional` route/page exists:
  - route declaration: `src/routes/app.additional.tsx:3-5`
- `/app` index now includes server-side Admin API mutation workflow:
  - server function handler: `src/routes/app.index.tsx:37-125`
  - `productCreate`: `src/routes/app.index.tsx:45-74`
  - `productVariantsBulkUpdate`: `src/routes/app.index.tsx:91-109`
  - JSON payload rendering blocks: `src/routes/app.index.tsx:217-230`
- App Bridge interaction parity exists:
  - toast behavior: `src/routes/app.index.tsx:139-144`
  - edit intent: `src/routes/app.index.tsx:166-168`
- Product scope required by template example is configured:
  - `.shopify-cli/shopify.app.toml:21` (`write_products`)

## Gap analysis vs template parity

- No phase-3 parity gaps found in route surface, nav, or Admin API mutation wiring.
- Remaining port gap is phase 4 (webhook/scopes parity), not phase 3:
  - missing `app/scopes_update` subscription in local TOML: `.shopify-cli/shopify.app.toml:15-18`
  - missing `app/scopes_update` webhook route in `src/routes/`

## Implemented TanStack-native shape

1. Parent `/app` auth stays in `beforeLoad` and runs before child route loading.
2. `/app/additional` route is implemented in TanStack file-route form.
3. App nav includes `/app` and `/app/additional` entries under embedded shell.
4. `/app` index uses POST `createServerFn` for Admin GraphQL mutation flow.
5. Existing `authenticateAdmin` + `admin.graphql` are reused in the server function.

## Auth nuance for phase 3 server-function calls

Shopify requires session-token auth on backend requests from embedded frontend:

- Session token in authorization header: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:33`
- Fetch a fresh token each request (1 minute TTL): `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:45`
- Backend must authenticate incoming requests: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md:31-33`

Current backend supports both header token and `id_token` query-param auth (`src/lib/Shopify.ts:239-241`, `src/lib/Shopify.ts:260-274`). The implemented `/app` mutation flow uses this existing path without adding a separate auth transport layer.

## Implementation slices (completed)

1. Route parity slice: `/app/additional` and nav link added.
2. Mutation slice: `generateProduct` server function and UI wiring implemented.
3. Auth slice: existing token auth paths reused for server-function requests.
4. Scope slice: `write_products` declared in app TOML.

## Verification checklist

- `/app` nav shows Home + Additional page (`src/routes/app.tsx:99-100`)
- `/app/additional` renders under embedded shell (`src/routes/app.additional.tsx:3-39`)
- Generate-product action is wired and renders both payload blocks (`src/routes/app.index.tsx:217-230`)
- App Bridge toast/edit interactions are wired (`src/routes/app.index.tsx:139-144`, `src/routes/app.index.tsx:166-168`)
- Static checks for this doc update were not re-run (research-only update)
