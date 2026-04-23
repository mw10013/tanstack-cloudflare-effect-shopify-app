# tanstack-cloudflare-effect-shopify-app

Port of the Shopify App Template to TanStack Start + Cloudflare Workers + Effect v4.

## Local development

- Go through https://shopify.dev/docs/apps/build/scaffold-app to ensure Shopify account, cli, and store are set up.

```bash
# first time
pnpm i
cp .env.example .env
shopify app config link --config staging
#  - App name: tanstack-start-app-staging
pnpm d1:reset

# every time
shopify app dev
```

## Staging Deployment

One-time setup:

```bash
# create D1 database, updates database_id in wrangler.jsonc automatically
pnpm d1:reset:staging

# get credentials from Shopify CLI, then set as wrangler secrets
shopify app env show --config staging
wrangler secret put SHOPIFY_API_KEY --env staging
wrangler secret put SHOPIFY_API_SECRET --env staging
```

Update `SHOPIFY_APP_URL` in `wrangler.jsonc` `env.staging.vars` with the actual workers.dev URL after first deploy.

Deploy:

```bash
pnpm deploy:staging
shopify app deploy --config staging
```

Install on dev store: Shopify Dev Dashboard → Apps → `tanstack-start-app-staging` → Test on development store.


