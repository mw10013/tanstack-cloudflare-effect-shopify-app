# Rename prefix `tanstack-cloudflare-effect-shopify-app` → `tcesa`

## Goal

Shorten the verbose naming prefix used in Cloudflare Worker names, D1 database names, and package.json scripts. The npm package `name` field stays unchanged.

## Current names → proposed names

### wrangler.jsonc

| Field | Current | Proposed |
|---|---|---|
| top-level `name` (local) | `tanstack-cloudflare-effect-shopify-app-local` | `tcesa-local` |
| local `database_name` | `tanstack-cloudflare-effect-shopify-app-d1-local` | `tcesa-d1-local` |
| local `database_id` | `tanstack-cloudflare-effect-shopify-app-d1-local` | `tcesa-d1-local` |
| staging `name` | `tanstack-cloudflare-effect-shopify-app-staging` | `tcesa-staging` |
| staging `SHOPIFY_APP_URL` | `...tanstack-cloudflare-effect-shopify-app-staging.*.workers.dev` | `...tcesa-staging.*.workers.dev` |
| staging `database_name` | `tanstack-cloudflare-effect-shopify-app-d1-staging` | `tcesa-d1-staging` |
| production `name` | `tanstack-cloudflare-effect-shopify-app` | `tcesa` |
| production `SHOPIFY_APP_URL` | `...tanstack-cloudflare-effect-shopify-app.*.workers.dev` | `...tcesa.*.workers.dev` |
| production `database_name` | `tanstack-cloudflare-effect-shopify-app-d1-production` | `tcesa-d1-production` |

Note: staging/production `database_id` values are real UUIDs — unchanged.

### package.json scripts

| Script | Current db/worker name | Proposed |
|---|---|---|
| `tail:PRODUCTION` | `tanstack-cloudflare-effect-shopify-app` | `tcesa` |
| `d1:migrate:list` | `tanstack-cloudflare-effect-shopify-app-d1-local` | `tcesa-d1-local` |
| `d1:migrate:apply` | `tanstack-cloudflare-effect-shopify-app-d1-local` | `tcesa-d1-local` |
| `d1:migrate:list:staging` | `tanstack-cloudflare-effect-shopify-app-d1-staging` | `tcesa-d1-staging` |
| `d1:migrate:apply:staging` | `tanstack-cloudflare-effect-shopify-app-d1-staging` | `tcesa-d1-staging` |
| `d1:migrate:list:PRODUCTION` | `tanstack-cloudflare-effect-shopify-app-d1-production` | `tcesa-d1-production` |
| `d1:migrate:apply:PRODUCTION` | `tanstack-cloudflare-effect-shopify-app-d1-production` | `tcesa-d1-production` |

### Shopify toml files

The user asked whether `tcesa-staging` / `tcesa` makes sense for the toml files.

**`shopify.app.staging.toml`** — `name = "tanstack-start-app-staging"` → `name = "tcesa-staging"`

This `name` is the human-readable Shopify Partner Dashboard app name. Renaming it here changes what's shown in the dashboard. The `client_id` is what actually identifies the app, so a rename is cosmetic/organizational.

**`shopify.web.toml`** — `name = "tanstack-cloudflare-effect-app"` → `name = "tcesa"`

This is the web component identifier used by Shopify CLI to reference the frontend/backend component within the app config. Renaming to `tcesa` is consistent and fine.

There is no `shopify.app.toml` (production) file yet — when created it should use `name = "tcesa"`.

## Side effects & migration steps

### Local (`.wrangler/`)

The local D1 database is stored under `.wrangler/state/v3/d1/` keyed by `database_id`. After renaming `database_id` from `tanstack-cloudflare-effect-shopify-app-d1-local` to `tcesa-d1-local`, the old local DB is orphaned. Steps:

1. Apply the config rename.
2. Delete `.wrangler/` to remove old state.
3. Re-run `pnpm d1:migrate:apply` to recreate local DB under new name.

### Remote staging Worker

Renaming the Worker (`name` in wrangler.jsonc `env.staging`) creates a **new** Worker in Cloudflare on next deploy. The old `tanstack-cloudflare-effect-shopify-app-staging` worker remains until manually deleted via Cloudflare dashboard or `wrangler delete`. The workers.dev URL changes to `tcesa-staging.<account_id>.workers.dev` — update `SHOPIFY_APP_URL` in wrangler.jsonc accordingly (already in the table above).

### Remote production Worker

Same as staging. `tanstack-cloudflare-effect-shopify-app` worker persists until deleted. New worker is `tcesa`.

### Remote D1 databases

The `database_id` UUIDs are unchanged, so wrangler still binds to the same physical databases. The `database_name` in wrangler.jsonc is just a local label when `database_id` is present — the Cloudflare dashboard still shows the old name. To align dashboard names, run:

```bash
wrangler d1 rename tanstack-cloudflare-effect-shopify-app-d1-staging tcesa-d1-staging --env staging --remote
wrangler d1 rename tanstack-cloudflare-effect-shopify-app-d1-production tcesa-d1-production --env production --remote
```

(Verify `wrangler d1 rename` is available in your wrangler version — added in recent releases.)

### scripts/refs-shopify-docs.ts

Line 10 references `tanstack-cloudflare-effect-shopify-app/refs-shopify-docs` as the npm script origin comment string. Not functionally impactful but can be updated for consistency.

### README.md / AGENTS.md / docs/

These contain references to the old prefix. Cosmetic — update for consistency.

## Summary

Config-only files (wrangler.jsonc, package.json) are safe to rename freely. The main operational concern is:
- Delete `.wrangler/` and re-migrate local DB after rename.
- Old remote Workers linger until explicitly deleted — not harmful, but clean up to avoid billing confusion.
- D1 dashboard names won't auto-update; use `wrangler d1 rename` if you want them in sync.
- Shopify toml `name` changes are cosmetic (Partner Dashboard display name); `client_id` is the real identity.
