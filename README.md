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
# first time
# set client_id = "" in shopify.app.staging.toml
# creates tcesa-staging in Shopify Partners
shopify app config link --config staging
# fix shopify.app.staging.toml: set application_url and redirect_urls to your Workers URL,
# set automatically_update_urls_on_dev = false
# set SHOPIFY_APP_URL in wrangler.jsonc env.staging.vars to your Workers URL
# creates D1 database (skip if already exists)
pnpm d1:reset:staging
# copy API key/secret, then set as wrangler secrets
shopify app env show --config staging
pnpm exec wrangler secret put SHOPIFY_API_KEY --env staging
pnpm exec wrangler secret put SHOPIFY_API_SECRET --env staging

# every time
pnpm deploy:staging
shopify app deploy --config staging
```

Install on dev store: Shopify Dev Dashboard → Apps → `tcesa-staging` → Test on development store.
