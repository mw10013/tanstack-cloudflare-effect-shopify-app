# Shopify App URL: Local Dev vs Staging Deployment

## Problem

After running `shopify app dev` and then deploying to staging, the dev store shows:
```
nirvana-titles-personnel-aspect.trycloudflare.com refused to connect
```

The store is trying to load the app from the dead local dev tunnel instead of the deployed Workers URL.

## Root Cause

Two issues combined:

**1. `automatically_update_urls_on_dev = true` in `shopify.app.staging.toml`**

When `shopify app dev` runs, the CLI temporarily overwrites the app URL in Shopify Partners with the Cloudflare tunnel URL (e.g. `nirvana-titles-personnel-aspect.trycloudflare.com`). When dev stops, **the URL is NOT restored**. The store remains pointed at the dead tunnel.

From `refs/shopify-docs/docs/apps/build/cli/test-apps-locally.mdx`:
> `automatically_update_urls_on_dev` — When true, the `app dev` command updates your app URL to the current tunnel URL. When false, the app URL won't be updated.

**2. `application_url = "https://example.com"` in `shopify.app.staging.toml`**

The staging TOML has a placeholder URL, never updated to the actual Workers URL. So `shopify app deploy --config staging` pushed `https://example.com` to Shopify Partners — not the Workers URL from `wrangler.jsonc`.

## How App URLs Work

```
shopify.app.staging.toml  →  shopify app deploy  →  Shopify Partners dashboard
                                                     (source of truth for app URL)
                                                           ↓
                                                     Dev store iframe embed
```

- `application_url` in the TOML = what gets pushed to Shopify Partners on deploy
- `shopify app dev` with `automatically_update_urls_on_dev = true` temporarily overrides this for the dev store only
- The deployed Workers app needs `SHOPIFY_APP_URL` in `wrangler.jsonc` to match `application_url` in the TOML — they must be in sync

## Shopify's Multi-Environment Convention

Two separate Shopify apps in Partners, two TOMLs:

| File | App in Partners | Purpose |
|------|----------------|---------|
| `shopify.app.toml` | `tcesa-local` (new) | Local dev — `shopify app dev` with no `--config` |
| `shopify.app.staging.toml` | `tcesa-staging` (existing) | Staging deploy — `shopify app deploy --config staging` |

Each TOML has its own `client_id`. The local dev app URL is managed dynamically by the CLI tunnel; the staging app URL is hardcoded to the Workers URL.

The `refs/shopify-app-template` ships only `shopify.app.toml` (no `application_url`, no `automatically_update_urls_on_dev`). The multi-environment TOML split is a convention documented by Shopify but not demonstrated in the template.

## Implementation Plan

### Manual step (Shopify Partners dashboard)
Create a new app named `tcesa-local` in the Partners dashboard (separate from `tcesa-staging`). Or let `shopify app config link` prompt you to create one.

### 1. Create `shopify.app.toml` (local dev)

```toml
client_id = "<new-local-client-id-from-config-link>"
name = "tcesa-local"
embedded = true

[build]
automatically_update_urls_on_dev = true

[webhooks]
api_version = "2026-07"

[access_scopes]
scopes = "write_products"

[auth]
redirect_urls = [ "https://redirect.shopifyapps.com" ]
```

Run `shopify app config link` (no `--config`) to link this TOML to the new `tcesa-local` app and populate `client_id`.

### 2. Update `shopify.app.staging.toml`

```toml
application_url = "https://tcesa-staging.87997fc2724b0127effb8e4524989975.workers.dev"

[build]
automatically_update_urls_on_dev = false   # never let dev clobber staging URL

[auth]
redirect_urls = [ "https://tcesa-staging.87997fc2724b0127effb8e4524989975.workers.dev/api/auth" ]
```

### 3. Update `package.json` scripts

- `shopify:dev` → `shopify app dev` (already correct, picks up `shopify.app.toml` by default)
- `shopify:config:link` → `shopify app config link` (for local TOML)
- Add `shopify:config:link:staging` → `shopify app config link --config staging`
- `shopify:env:show` → `shopify app env show` (local)
- Add `shopify:env:show:staging` → `shopify app env show --config staging`

### 4. Update `README.md`

Local dev first-time setup:
```bash
shopify app config link        # links shopify.app.toml to tcesa-local
shopify app dev                # uses shopify.app.toml automatically
```

Staging first-time setup and deploy — update wrangler secrets to use local env show (not staging env show):
```bash
shopify app env show           # get tcesa-local credentials (not staging)
# ...staging deploy steps unchanged...
```

### 5. Re-deploy staging to fix the broken URL now

```bash
# After updating shopify.app.staging.toml with the real Workers URL:
shopify app deploy --config staging
```

## Workflow Going Forward

**Local dev** — uses `shopify.app.toml`, separate `tcesa-local` app:
```bash
shopify app dev   # tunnel URL auto-managed, never touches staging app
```

**Staging** — uses `shopify.app.staging.toml`, deployed Workers URL:
```bash
pnpm deploy:staging
shopify app deploy --config staging
```

Staging URL in Partners is never clobbered by local dev because they are separate apps with separate `client_id`s.
