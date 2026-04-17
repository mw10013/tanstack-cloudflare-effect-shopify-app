# Shopify phase 4 webhook/scopes parity research

Phase 4 focuses on parity for `app/scopes_update` webhook handling and scope/session drift behavior.

## Source of truth

- Template webhook subscription config:
  - `refs/shopify-app-template/shopify.app.toml:16-19`
- Template webhook handler:
  - `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:5-20`
- Shopify docs: scope changes and webhook behavior:
  - `refs/shopify-docs/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes.md:88-98`
- Shopify docs: topic semantics (`app/scopes_update` keeps granted scopes in sync):
  - `refs/shopify-docs/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic.md:57-60`

## What phase 4 needs to achieve

- Add app-config subscription parity for `app/scopes_update` in `.shopify-cli/shopify.app.toml`.
- Add route parity for `/webhooks/app/scopes_update` under `src/routes/`.
- Reconcile local session persistence when granted scopes change.

## Current repo status

- Current app config includes only `app/uninstalled` subscription:
  - `.shopify-cli/shopify.app.toml:15-18`
- Current webhook route set includes only uninstall handler:
  - `src/routes/webhooks.app.uninstalled.ts:5-23`
- Session persistence is D1 payload storage keyed by session id + indexed by shop:
  - schema: `migrations/0001_init.sql:1-9`
  - write/read: `src/lib/Shopify.ts:92-136`

## Gap analysis

- Missing `app/scopes_update` subscription in local TOML.
- Missing `src/routes/webhooks.app.scopes_update.ts` route handler.
- No explicit scope-drift reconciliation path today.

## Recommended implementation shape

1. Add TOML subscription:
   - `topics = [ "app/scopes_update" ]`
   - `uri = "/webhooks/app/scopes_update"`
2. Add route `src/routes/webhooks.app.scopes_update.ts` with POST handler that:
   - validates webhook signature via `shopify.webhooks.validate` (same pattern as uninstall route)
   - returns `401` for invalid payloads, `200` for valid payloads
3. Reconcile drift by deleting persisted sessions for the shop on valid `app/scopes_update`:
   - use existing `deleteShopifySessionsByShop`
   - rationale: next authenticated request forces fresh token exchange and re-persists session with current granted scopes
4. Keep behavior idempotent:
   - repeated webhook deliveries remain safe because deleting by shop is repeatable

## Why delete-by-shop is the best fit here

- Template updates a Prisma `scope` column in-place (`refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:10-18`).
- This repo stores full Shopify session payload in D1 (`payload` blob) and does not maintain a dedicated `scope` column (`migrations/0001_init.sql:1-7`).
- Deleting shop sessions avoids bespoke payload patching logic and aligns with current token-exchange flow in `authenticateAdmin` (`src/lib/Shopify.ts:295-303`).

## Verification checklist

- TOML includes both app topics:
  - `app/uninstalled`
  - `app/scopes_update`
- `POST /webhooks/app/scopes_update` returns `401` for invalid signature and `200` for valid signature.
- Valid `app/scopes_update` delivery removes session rows for `result.domain`.
- Next `/app` request re-establishes session via token exchange without auth loop.
- Static checks pass after implementation (`pnpm typecheck`, `pnpm lint`).

## Out of scope for phase 4

- Production retry/backoff/observability pipelines for webhook failures (phase 5).
- Compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`) unless product scope requires them.
