# Shopify TanStack Start porting runbook

This is the canonical Shopify porting doc for this repo.

## Status

Phase 1 is complete: app installs, auth flow runs, session persists, and `/app` renders.

Evidence in code:

- auth splat route for bounce/exit-iframe handling: `src/routes/auth.$.tsx:5`
- uninstall webhook validation + session cleanup: `src/routes/webhooks.app.uninstalled.ts:5`
- guarded embedded app layout route: `src/routes/app.tsx:39`
- Shopify API config from env vars: `src/lib/Shopify.ts:46`

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

- `src/lib/Shopify.ts:35-42`
- `src/lib/Shopify.ts:50-52`

### 4) Config ownership should stay CLI-first

This repo uses Shopify CLI config path indirection intentionally:

- `package.json:29` (`pnpm shopify:dev` -> `shopify app dev --path .shopify-cli`)
- `.shopify-cli/shopify.app.toml`
- `.shopify-cli/shopify.web.toml`

Keep managing app config through this path to avoid accidental config drift.

### 5) Cloudflare local runtime does not automatically inherit Shopify CLI process env

Key references:

- Shopify CLI provides local dev process env including `HOST/APP_URL` (`refs/shopify-docs/docs/apps/structure.md:136-143`).
- Cloudflare local dev supports `.env` (and `.dev.vars`), and only includes process env when `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` (`refs/cloudflare-docs/src/content/partials/workers/secrets-in-dev.mdx:9-17`, `refs/cloudflare-docs/src/content/partials/workers/secrets-in-dev.mdx:45-46`).
- Runtime config requires one of `SHOPIFY_APP_URL`/`APP_URL`/`HOST` (`src/lib/Shopify.ts:35-52`).

This mismatch is the root cause of: `SHOPIFY_APP_URL or APP_URL or HOST is required`.

## Local runbook for dynamic tunnel URL (no hardcoding)

1. Run dev through Shopify CLI (`pnpm shopify:dev`) so tunnel URL exists in parent process env.
2. Ensure Cloudflare local runtime can consume parent process env:
   - add `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` to the dev command path.
3. Ensure `.env` values are exported in the dev script (`package.json:6`) via `set -a && source .env && set +a`.
4. Keep credentials in local env (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`) as before.
5. Restart dev session after changing local env loading behavior.

### Observed startup behavior (working, but noisy)

- `Using secrets defined in .env` and `Using secrets defined in process.env` can both appear together; this is expected after enabling `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`.
- Shopify proxy can briefly log `ECONNREFUSED 127.0.0.1:3200` if it forwards before Vite is listening; this is a startup race, not an auth regression.
- In successful runs, retries continue and app loads after Vite reports `Local: http://localhost:3200/`.
- `[shopify-api/INFO] Future flag ... is disabled` lines are informational library logs from `@shopify/shopify-api` initialization, not runtime failures (`src/lib/Shopify.ts:65-73`).

## Production ownership (important)

Shopify docs: local dev envs are injected by CLI, but deployed env vars must be set in hosting provider (`refs/shopify-docs/docs/apps/launch/deployment/deploy-to-hosting-service.md:153-166`).

For Cloudflare production:

- Set `SHOPIFY_APP_URL` in Worker vars/secrets (platform-owned value).
- Set `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` as secrets.
- Keep `shopify.app.toml` `application_url` in sync with deployed app URL (`refs/shopify-docs/docs/apps/launch/deployment/deploy-to-hosting-service.md:177-183`).

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

5. Verify app loads at `/app` inside Shopify admin iframe:

- route auth gate: `src/routes/app.tsx:39-53`
- rendered page: `src/routes/app.index.tsx:10-16`

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
