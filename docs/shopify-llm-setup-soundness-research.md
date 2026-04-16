# Shopify LLM setup soundness review

## Input under review

# Shopify App Setup on Cloudflare + TanStack Start (non-template)

## Key Files Needed

### `shopify.app.toml` (create manually before first `shopify app dev` run)
```toml
name = "your-app-name"
application_url = "https://example.com"
embedded = true

[build]
automatically_update_urls_on_dev = true
include_config_on_deploy = true
dev_store_url = "your-store.myshopify.com"

[access_scopes]
scopes = "write_products,write_metaobjects,write_metaobject_definitions"

[auth]
redirect_urls = ["https://example.com/auth/callback"]

[webhooks]
api_version = "2026-07"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/app/uninstalled"
```
- Do NOT add `client_id` - the CLI writes it automatically on first run
- `automatically_update_urls_on_dev = true` means the CLI rewrites `application_url` and `redirect_urls` to the tunnel URL during dev, so placeholder URLs are fine

### `shopify.web.toml` (create manually)
```toml
[web]
type = "backend"

[web.commands]
dev = "npm run dev"
```
Adjust the `dev` command to match how your app starts.

---

## First Run Flow
1. Create both toml files above
2. Run `shopify app dev`
3. CLI prompts to create a new app in Partner Dashboard - say yes
4. CLI writes `client_id` into `shopify.app.toml`
5. CLI injects `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` as runtime env vars

---

## Environment Variables on Cloudflare

Cloudflare does NOT use `process.env`. Env vars come from the `env` parameter passed into your Worker handler.

- **Local dev**: use `.dev.vars` (Cloudflare's equivalent of `.env`)
- **Production**: use `wrangler secret put SHOPIFY_API_KEY` etc.

### `.dev.vars`
```
SHOPIFY_API_KEY=your-api-key
SHOPIFY_API_SECRET=your-api-secret
SHOPIFY_APP_URL=https://your-tunnel-url
```

Get `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` from Partner Dashboard -> Apps -> your app -> API credentials after the first `shopify app dev` run. These values almost never change.

---

## Shopify.ts - Key Constraints for Cloudflare

### DO NOT use `process.env`
```ts
// Wrong - breaks on Cloudflare Workers
const value = process.env.SHOPIFY_API_KEY;

// Correct - pass env from Worker handler
const getShopifyApi = (env: Env) => { ... }
```

### DO NOT use module-level singletons
Cloudflare Workers don't guarantee instance reuse - module-level cached variables are unreliable. Initialize per-request from `env`.

```ts
// Wrong
let shopifyRuntimeConfig: ShopifyRuntimeConfig | undefined;

// Correct - initialize fresh from env each time
const getShopifyApi = (env: Env) => {
  return ShopifyApi.shopifyApi({
    apiKey: env.SHOPIFY_API_KEY,
    apiSecretKey: env.SHOPIFY_API_SECRET,
    ...
  });
};
```

### SCOPES - hardcode instead of env var
Do not read scopes from an env var. Hardcode them to avoid a second source of truth alongside `shopify.app.toml`:

```ts
// Avoid
scopes: parseScopes(process.env.SCOPES)

// Preferred
const SCOPES = ["write_products", "write_metaobjects", "write_metaobject_definitions"];
```

### No scopes needed in `shopifyApi()` config
If you're using `@shopify/shopify-api` directly (not `@shopify/shopify-app-remix`), scopes are declared in `shopify.app.toml` and managed by Shopify. You only need to pass scopes when constructing the OAuth redirect URL - not in the `shopifyApi()` initializer.

---

## Package Context
- This app uses `@shopify/shopify-api` directly (low-level)
- It does NOT use `@shopify/shopify-app-remix` (the higher-level package used in the official React Router template)
- Session storage uses Cloudflare D1 - this is correct and appropriate
- `Session.fromPropertyArray` / `toPropertyArray` for D1 serialization is correct

---

## What the Official Template Does Differently
The official Shopify React Router template (`github.com/Shopify/shopify-app-template-remix`) uses `@shopify/shopify-app-remix` which handles OAuth internally and reads `SCOPES` at runtime as an env var. Since we are NOT using that package, that pattern does not apply here.

## Soundness verdict

Mixed. Some parts are sound, several parts are outdated or too absolute for this repo.

## Sound parts

- `access_scopes.scopes` in `shopify.app.toml` as install permission source is correct (`refs/shopify-docs/docs/apps/build/cli-for-apps/app-configuration.md:118`).
- `shopify app dev` / `app config link` updating app config linkage is correct (`refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:57`).
- Template-style runtime scopes from env is real and common (`refs/phc/app/shopify.server.ts:14`, `refs/shopify-rr/packages/apps/shopify-app-react-router/src/server/shopify-app.ts:52`).

## Not sound or outdated

- `shopify.web.toml` snippet is outdated: it uses deprecated `type`; docs say `roles` replaces `type` (`refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:110`, `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:116`).
- For single-process apps, docs say include both `frontend` and `backend` roles (`refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:130`).
- `Cloudflare does NOT use process.env` is too absolute. With `nodejs_compat` + modern compatibility date, `process.env` is auto-populated (`refs/cloudflare-docs/src/content/docs/workers/runtime-apis/nodejs/process.mdx:23`). This repo has `nodejs_compat` enabled (`wrangler.jsonc:5`) and generated types include `ProcessEnv` bindings (`worker-configuration.d.ts:46`).
- `.dev.vars` guidance does not match this repo's actual runtime path. Dev server boot script explicitly sources `.env` (`package.json:6`), and shopify CLI runs that command via `.shopify-cli/shopify.web.toml` (`.shopify-cli/shopify.web.toml:7`).
- "Always run config link" is too broad for a net-new app. Shopify docs say first `app dev` or `app config link` updates `shopify.app.toml` for the linked app (`refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:57`), and scaffold docs state `app dev` can create and connect the app (`refs/shopify-docs/docs/apps/build/scaffold-app.md:97`, `refs/shopify-docs/docs/apps/build/scaffold-app.md:100`).
- `CLI injects SHOPIFY_APP_URL` is incomplete for Shopify CLI runtime env docs; docs list `HOST`/`APP_URL` (`refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:140`).

## Scope-specific call for this repo

- Your stated goal is template parity (not hard-coding yet). Template parity means keep runtime `SCOPES` env wiring, not hard-coded scopes (`refs/phc/app/shopify.server.ts:14`, `refs/shopify-rr/packages/apps/shopify-app-react-router/src/server/shopify-app.ts:52`).
- Current app code already follows this pattern (`src/lib/Shopify.ts:52`) and checks session scope drift against required scopes (`src/routes/app.ts:37`).
- Library internals for auth begin read `config.scopes` into OAuth `scope` query (`refs/shopify-rr/packages/apps/shopify-api/lib/auth/oauth/oauth.ts:102`). Removing runtime scopes now changes auth semantics unless you also migrate auth strategy.

## Managed-install nuance

- Shopify docs recommend managed install + token exchange for embedded apps (`refs/shopify-rr/packages/apps/shopify-api/docs/guides/oauth.md:19`, `refs/shopify-docs/docs/apps/build/authentication-authorization/app-installation.md:17`).
- Shopify API config types say scopes are optional when using managed installation (`refs/shopify-rr/packages/apps/shopify-api/lib/base-types.ts:30`).
- But this repo currently uses authorization-code-grant endpoints (`src/routes/auth.ts:18`, `src/routes/auth.callback.ts:10`), so "no scopes needed in `shopifyApi()`" is not a safe blanket rule for current architecture.

## Recommendation

- If the immediate goal is "port what template does," keep `SCOPES` from env for now and avoid hard-coded scopes.
- Revisit scope source-of-truth once migrating from authorization-code-grant to managed-install + token-exchange.

## What to do now for TOML files in this repo

- Keep using `.shopify-cli/shopify.app.toml` and `.shopify-cli/shopify.web.toml` because scripts run Shopify CLI with `--path .shopify-cli` (`package.json:29`, `package.json:30`).
- Keep `shopify.web.toml` in current `roles = ["frontend", "backend"]` form; do not switch to deprecated `type` (`.shopify-cli/shopify.web.toml:2`, `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:110`).
- Keep `shopify.web.toml` `commands.dev = "pnpm --dir .. dev"` so Shopify CLI starts the same app runtime (`.shopify-cli/shopify.web.toml:7`).
- Keep `shopify.app.toml` scope declaration in `[access_scopes]` as install source (`.shopify-cli/shopify.app.toml:10`, `refs/shopify-docs/docs/apps/build/cli-for-apps/app-configuration.md:118`).
- For a net-new app, do not hardcode `client_id` first. Run `pnpm shopify:dev`; first-run `app dev` can create/link the app and update the config (`refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:57`, `refs/shopify-docs/docs/apps/build/scaffold-app.md:100`).
- Use `pnpm shopify:config:link` only when you intentionally want to link another existing app, or re-link/recover a broken config (`refs/shopify-docs/docs/apps/build/cli-for-apps/manage-app-config-files.md:62`).
- While preserving template parity, keep `.env` `SCOPES` synced with TOML scopes (`.env:4`, `.shopify-cli/shopify.app.toml:11`), because runtime currently reads env scopes (`src/lib/Shopify.ts:52`).
