# tanstack-cloudflare-effect-shopify-app

Port of the Shopify App Template to TanStack Start + Cloudflare Workers + Effect v4.

## Local development

Prerequisites: Shopify account, CLI, and dev store — see https://shopify.dev/docs/apps/build/scaffold-app

```bash
# first time
pnpm i
cp .env.example .env
# set client_id = "" in shopify.app.toml
pnpm d1:reset
shopify app dev

# every time
shopify app dev
```

## Staging deployment

```bash
pnpm deploy:staging
shopify app deploy --config staging
```

Install on dev store: Shopify Dev Dashboard → Apps → `tcesa-staging` → Test on development store.

### Initial infrastructure setup (one-time)

```bash
# create D1 database (updates database_id in wrangler.jsonc automatically)
pnpm d1:reset:staging

# set wrangler secrets from Shopify app credentials
shopify app env show --config staging
pnpm exec wrangler secret put SHOPIFY_API_KEY --env staging
pnpm exec wrangler secret put SHOPIFY_API_SECRET --env staging
```
