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

### 1. Set Cloudflare Secrets

The worker needs Shopify credentials at runtime. Set via wrangler secrets on the production env:

```bash
wrangler secret put SHOPIFY_API_KEY --env production
wrangler secret put SHOPIFY_API_SECRET --env production
```

Source values from `shopify app env show` or `.env`.

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

In Shopify Partner Dashboard → Apps → select app → Test on development store. This triggers the OAuth install flow against the deployed worker URL.

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

To have a dedicated staging environment separate from production:

1. Create a second app record in Shopify Partner Dashboard
2. Link it: `shopify app config link` → creates a second toml (e.g., `shopify.app.staging.toml`)
3. Switch between configs: `shopify app config use`
4. Deploy staging toml to staging worker, production toml to production worker

Both can be tested against dev stores independently.

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
