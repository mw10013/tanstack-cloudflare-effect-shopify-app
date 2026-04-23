# Shopify App Deployment to Cloudflare

Research on deploying this app to Cloudflare Workers for dev store testing without running local dev.

## TL;DR

Yes — fully supported. Two separate deployments required:
1. **Cloudflare Worker** (web app code) via `wrangler deploy`
2. **Shopify app config** via `shopify app deploy`

This project already has both pipelines scaffolded in `package.json`.

---

## Current Project State

`wrangler.jsonc` has a production env with a separate D1 database:

```json
"env": {
  "production": {
    "name": "tanstack-cloudflare-effect-shopify-app",
    "d1_databases": [{ "database_name": "shopify-app-d1-production", ... }]
  }
}
```

`shopify.app.tanstack-cloudflare-effect-app.toml` has placeholder URLs:
```toml
application_url = "https://example.com"
[auth]
redirect_urls = [ "https://example.com/api/auth" ]
```

---

## Deployment Steps

### 1. Set Cloudflare Secrets and Vars

`SHOPIFY_API_SECRET` is the only true secret. Set via wrangler:

```bash
wrangler secret put SHOPIFY_API_SECRET --env production
```

`SHOPIFY_APP_URL` is required at runtime (used to build redirect/auth URLs) but is not sensitive — add it as a plain var in `wrangler.jsonc`:

```jsonc
"env": {
  "production": {
    "vars": {
      "ENVIRONMENT": "production",
      "SHOPIFY_APP_URL": "https://tanstack-cloudflare-effect-shopify-app.<account>.workers.dev"
    }
  }
}
```

Source `SHOPIFY_API_SECRET` from `shopify app env show` or `.env`.

### 2. Run D1 Migrations (production)

```bash
pnpm d1:migrate:apply:PRODUCTION
# → wrangler d1 migrations apply shopify-app-d1-production --env production --remote
```

### 3. Deploy the Worker

```bash
pnpm deploy:PRODUCTION
# → CLOUDFLARE_ENV=production pnpm build && wrangler deploy --env production
```

This publishes to: `https://tanstack-cloudflare-effect-shopify-app.<account>.workers.dev`

(Or a custom domain if configured in wrangler.jsonc.)

### 4. Update Shopify App Config

Update `shopify.app.tanstack-cloudflare-effect-app.toml` with the actual worker URL:

```toml
application_url = "https://tanstack-cloudflare-effect-shopify-app.<account>.workers.dev"

[auth]
redirect_urls = [
  "https://tanstack-cloudflare-effect-shopify-app.<account>.workers.dev/api/auth",
]
```

### 5. Deploy Shopify App Config

```bash
shopify app deploy
```

This pushes the toml (URLs, scopes, webhook config, extensions) to Shopify as a new app version. Web app code and Shopify config are versioned independently.

### 6. Install on Dev Store

In Shopify Partner Dashboard → **Apps** → select the app (production or staging — each is a separate app record) → **Test on development store**.

- Both the production app and staging app appear as separate entries in the Partner Dashboard app list.
- Each app record can be installed on the same dev store independently — they appear as separate installations.
- Selecting "Test on development store" triggers the OAuth install flow using that app's `client_id` and redirect URLs from its deployed toml, pointing to its respective worker URL.

---

## Local Dev vs Deployed Comparison

| Aspect | `shopify app dev` | Deployed to Cloudflare |
|---|---|---|
| URL | Auto-generated tunnel (changes each run) | Static workers.dev URL |
| Environment vars | Injected by Shopify CLI | Wrangler secrets |
| App config updates | `automatically_update_urls_on_dev = true` | Manual toml edit + `shopify app deploy` |
| Database | Local D1 (`--local`) | Remote D1 production |
| Hot reload | Yes | No (redeploy required) |
| Shopify review eligible | No | Yes (after config deploy) |

---

## Key Distinction: Two Independent Deployments

From `refs/shopify-docs/docs/apps/launch/deployment/app-versions.md`:

> Releasing an app version does NOT deploy web app code — only configuration.

- `wrangler deploy` → updates the running code on Cloudflare
- `shopify app deploy` → updates URLs, scopes, webhooks, extensions in Shopify's system

Both must be in sync. If URLs change (e.g., custom domain), both must be redeployed.

---

## Staging vs Production App Records

Each environment requires its own Shopify app record (separate `client_id`) and its own Cloudflare Worker deployment. The `shopify.web.toml` is shared — it defines the dev server command and webhook path, which don't change per environment. Only the `shopify.app.*.toml` files differ.

### Config files per environment

| File | Shared? | Purpose |
|---|---|---|
| `shopify.web.toml` | Yes — one file | Dev server command, webhook path, roles |
| `shopify.app.tanstack-cloudflare-effect-app.toml` | Production only | `client_id`, `application_url`, `redirect_urls`, scopes |
| `shopify.app.staging.toml` | Staging only | Same fields, different `client_id` and worker URL |

### Setup

1. Create a second app record in Shopify Partner Dashboard (name it e.g. "tanstack-cloudflare-effect-app-staging").
2. Link it from the project root:
   ```bash
   shopify app config link
   # CLI prompts: which app record? → select the staging app
   # CLI prompts: config name? → enter "staging"
   # Creates: shopify.app.staging.toml
   ```
3. The new toml gets its own `client_id` from the staging app record.

### Switching between configs

`shopify app config use` sets the active config for CLI commands (`shopify app dev`, `shopify app deploy`, `shopify app env show`):

```bash
shopify app config use staging        # activate staging — subsequent CLI commands target staging app
shopify app config use tanstack-cloudflare-effect-app  # activate production
```

The active config is stored in `.shopify.app.toml` (gitignored). Alternatively, pass `--config` per command to avoid switching:

```bash
shopify app deploy --config staging
shopify app deploy --config tanstack-cloudflare-effect-app
```

### Deploying staging

Staging needs its own wrangler env in `wrangler.jsonc` (separate worker name, D1 database):

```jsonc
"env": {
  "staging": {
    "name": "tanstack-cloudflare-effect-shopify-app-staging",
    "vars": {
      "ENVIRONMENT": "staging",
      "SHOPIFY_APP_URL": "https://tanstack-cloudflare-effect-shopify-app-staging.<account>.workers.dev"
    },
    "d1_databases": [{ "binding": "D1", "database_name": "shopify-app-d1-staging", "database_id": "<id>" }]
  }
}
```

Deploy flow mirrors production but targets the staging env:

```bash
wrangler secret put SHOPIFY_API_SECRET --env staging   # staging app's secret
wrangler d1 migrations apply shopify-app-d1-staging --env staging --remote
wrangler deploy --env staging
shopify app deploy --config staging
```

### Using production vs staging

| Action | Production | Staging |
|---|---|---|
| Deploy worker | `wrangler deploy --env production` | `wrangler deploy --env staging` |
| Deploy Shopify config | `shopify app deploy --config tanstack-cloudflare-effect-app` | `shopify app deploy --config staging` |
| Install on dev store | Partner Dashboard → production app record | Partner Dashboard → staging app record |
| Worker URL | `tanstack-cloudflare-effect-shopify-app.<account>.workers.dev` | `tanstack-cloudflare-effect-shopify-app-staging.<account>.workers.dev` |
| D1 database | `shopify-app-d1-production` | `shopify-app-d1-staging` |

---

## Webhook Delivery

`shopify.web.toml` sets `webhooks_path = "/webhooks/app/uninstalled"`. In production, Shopify delivers webhooks to the deployed worker URL — no tunnel needed. The worker must be publicly reachable (it is by default on workers.dev).

Webhook HMAC verification uses `SHOPIFY_API_SECRET` (the wrangler secret set in step 1).

---

## References

- `refs/shopify-docs/docs/apps/launch/deployment/deploy-to-hosting-service.md` — env vars, hosting requirements
- `refs/shopify-docs/docs/apps/launch/deployment/app-versions.md` — config vs code versioning
- `refs/shopify-docs/docs/apps/build/app-configuration.md` — toml reference
- `wrangler.jsonc` — production env definition
- `shopify.app.tanstack-cloudflare-effect-app.toml` — current app config (placeholder URLs)
- `package.json` scripts: `deploy:PRODUCTION`, `d1:migrate:apply:PRODUCTION`
