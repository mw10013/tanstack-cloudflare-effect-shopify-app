# Shopify App Env Pull Research

## What is `shopify app env pull`?

From `refs/shopify-docs/docs/api/shopify-cli/app/app-env-pull.md`:

> Creates or updates an `.env` files that contains app and app extension environment variables.

## Does it preserve other env vars?

**Yes.** Per line 16 of the same doc:

> When an existing `.env` file is updated, changes to the variables are displayed in the terminal output. **Existing variables and commented variables are preserved.**

So running `shopify app env pull` will NOT overwrite your other env vars.

## What env var names does it use?

Based on `refs/shopify-app-template/app/shopify.server.ts:11-15`:

| Variable | Description |
|----------|-------------|
| `SHOPIFY_API_KEY` | Client ID of the app |
| `SHOPIFY_API_SECRET` | Client secret of the app |
| `SHOPIFY_APP_URL` | URL origin where the app is accessed |
| `SCOPES` | App's access scopes (comma-separated) |
| `SHOP_CUSTOM_DOMAIN` | Optional custom shop domains |

Additional vars from `refs/shopify-app-template/vite.config.ts`:

| Variable | Description |
|----------|-------------|
| `PORT` | Port for the app (defaults to 3000) |
| `HOST` | Host URL (used to set SHOPIFY_APP_URL) |
| `FRONTEND_PORT` | Port for frontend dev server |

## How to use

```bash
# Pull env vars from Shopify CLI into .env
shopify app env pull

# Or show them without writing
shopify app env show
```

## First-time setup

When running `shopify app dev` for the first time:

1. Shopify CLI logs into your account
2. Creates/appends to an app record in the Dev Dashboard
3. Provides `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` directly to your dev server
4. Creates/updates `.env` file with these values

This means you don't need to manually obtain the keys from the dashboard - Shopify CLI handles it.
