# tanstack-cloudflare-effect-shopify-app

Port of the Shopify App Template to TanStack Start + Cloudflare Workers + Effect v4.

## Local development

- Go through https://shopify.dev/docs/apps/build/scaffold-app to ensure Shopify account, cli, and store are set up.

```bash
pnpm i
cp .env.example .env
pnpm d1:reset

# first time
#  - Create this project as a new app on Shopify? y
#  - App name: tanstack-cloudflare-effect-app
#  - Configuration file name: tanstack-cloudflare-effect-app
shopify app dev --reset

# otherwise
shopify app dev
```
