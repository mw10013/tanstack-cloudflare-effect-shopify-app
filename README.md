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
