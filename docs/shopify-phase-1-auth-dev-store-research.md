# Shopify TanStack Start porting runbook

This is the canonical Shopify porting doc for this repo.

## Status

Phase 1 is complete: app installs, auth flow runs, session persists, and `/app` renders.

Evidence in code:

- OAuth begin route: `src/routes/auth.ts:5`
- OAuth callback + session persist: `src/routes/auth.callback.ts:5`
- uninstall webhook validation + session cleanup: `src/routes/webhooks.app.uninstalled.ts:5`
- guarded app route + success response: `src/routes/app.ts:19`
- Shopify API config from env vars: `src/lib/Shopify.ts:45`

## What we learned implementing phase 1

### 1) Credentials source changed in Shopify UI

The Partner app `API access requests` page is not the source of app credentials. It links to Dev Dashboard.

Current path that works:

- `Dev Dashboard -> Apps -> <app> -> Settings -> Credentials`

Docs match this:

- `refs/shopify-docs/docs/apps/build/dev-dashboard/get-api-access-tokens.md:55-57`

Runtime mapping in this repo:

- `Client ID` -> `SHOPIFY_API_KEY`
- `Secret` -> `SHOPIFY_API_SECRET`

Code requires both:

- `src/lib/Shopify.ts:49-50`

### 2) Preview host block was a real Vite production issue during dev

Observed failure:

- `Blocked request. This host (...trycloudflare.com) is not allowed.`

Root cause:

- Shopify tunnel hostname rotates and Vite host allowlist did not include it.

Fix implemented:

- `vite.config.ts:31` sets `server.allowedHosts`
- `vite.config.ts:21-28` allows localhost, `.trycloudflare.com`, and parsed `HOST`/`APP_URL`/`SHOPIFY_APP_URL`

### 3) App URL env requirements are strict

If `SHOPIFY_APP_URL`/`APP_URL`/`HOST` is absent, requests fail at runtime.

Code path:

- `src/lib/Shopify.ts:30-33`
- `src/lib/Shopify.ts:45-47`

### 4) Config ownership should stay CLI-first

This repo uses Shopify CLI config path indirection intentionally:

- `package.json:29` (`pnpm shopify:dev` -> `shopify app dev --path .shopify-cli`)
- `.shopify-cli/shopify.app.toml`
- `.shopify-cli/shopify.web.toml`

Keep managing app config through this path to avoid accidental config drift.

## Canonical phase 1 runbook (known-good)

1. Link/create app via CLI:

```bash
pnpm shopify:dev
```

2. Ensure `.env` has fresh credentials for this app:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`

3. Start dev again and open preview (`p`).

4. If preview fails with host-block message, restart after any `vite.config.ts` host changes.

5. Verify `/app` success text from guarded route:

- `src/routes/app.ts:40`

## Phase 2+ focus (template-parity porting)

Keep these constraints from earlier research:

- official Shopify app build path is React Router-first (`refs/shopify-docs/docs/apps/build/build.md:2`)
- TanStack loaders are isomorphic, so Shopify-secret logic should stay in server routes/functions (`refs/tan-start/docs/start/framework/react/guide/execution-model.md:31`)
- embedded UI shell concerns (App Bridge/Polaris) are phase 2+, after auth/session foundation is stable

Practical sequence:

1. Embedded shell parity (App Bridge navigation + document headers)
2. Polaris/UI parity
3. Additional webhooks/scopes flows
4. Port app pages from `refs/shopify-app-template` incrementally

## Docs map (post phase 1)

- `docs/shopify-phase-1-auth-dev-store-research.md`: canonical runbook + phase 1 learnings
- `docs/shopify-phase-2-embedded-shell-research.md`: phase 2 scope and implementation plan
- `docs/shopify-porting-arc-research.md`: high-level full arc for template parity porting
- `docs/shopify-docs-fetch-script-research.md`: Shopify docs mirror script behavior
