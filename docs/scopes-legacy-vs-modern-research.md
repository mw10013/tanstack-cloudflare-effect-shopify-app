# Shopify Scopes: Legacy vs Modern Approach

## Question

Why does this codebase have a `SCOPES` env var? When the app registers with Shopify, don't we already declare scopes in `shopify.app.toml`?

## Short Answer

**Yes — scopes belong in `shopify.app.toml`, not in env vars.** The `SCOPES` env var is a legacy carry-over. With the modern "Shopify managed installation" flow, scopes are declared once in TOML and Shopify handles them automatically. The env var is unnecessary and should be removed.

---

## Legacy Flow (authorization code grant)

Scopes are passed as a URL parameter during the OAuth redirect:

```
https://{shop}/admin/oauth/authorize?client_id={id}&scope={scopes}&redirect_uri=...
```

The app runtime must know the desired scopes to construct this URL, hence `SCOPES` in the env. This is what the app template's `shopify.server.ts` still does:

```ts
// refs/shopify-app-template/app/shopify.server.ts
const shopify = shopifyApp({
  scopes: process.env.SCOPES?.split(","),  // legacy: scopes sent as OAuth URL param
  ...
});
```

**Problem:** Each installation can end up with different scopes depending on what the app passed at OAuth time.

---

## Modern Flow (Shopify managed installation)

Scopes are declared in `shopify.app.toml` under `[access_scopes]`:

```toml
# shopify.app.toml
[access_scopes]
scopes = "read_products,write_products"
optional_scopes = ["read_discounts"]
```

From `refs/shopify-docs/docs/apps/build/cli-for-apps/app-configuration.md` (line 120):

> When omitted or `false`, scopes are saved in your app's configuration, and are automatically requested when the app is installed on a store or when you update the `scopes` value. This is referred to as **Shopify managed installation**. When `true`, the legacy installation flow requests scopes through a URL parameter during the OAuth flow. **The legacy installation flow is still supported, but isn't recommended because your app can end up with different scopes for each installation.**

From `refs/shopify-docs/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes.md`:

> `scopes` — Mandatory when merchants install your app with Shopify managed install. Merchants **must** grant access before your app can be installed. Your app is guaranteed to have these access scopes after it's installed.
>
> `optional_scopes` — Can only be requested by the app post-installation. Merchants can grant or decline them.

**With modern flow:**
- No scopes URL param in OAuth
- No `SCOPES` env var needed
- All installs get identical scopes
- Scope changes deployed via `shopify app deploy` → merchants prompted to re-approve

---

## Scope Update Webhook

When `scopes` in TOML change and are deployed:
- Merchants are prompted to approve on next app open
- `app/scopes_update` webhook fires when they approve (or immediately for scope reductions)

This is why the app handles `webhooks/app/scopes_update` — it's part of the modern flow, not legacy.

---

## Current State of This Codebase

`src/lib/Shopify.ts` reads `SCOPES` from env and passes to `shopifyApi()`:

```ts
scopes: Config.option(Config.nonEmptyString("SCOPES")).pipe(...)
// ...
ShopifyApi.shopifyApi({ scopes, ... })
```

`.shopify-cli/shopify.app.toml` already has scopes declared:

```toml
[access_scopes]
scopes = "write_products"
```

`use_legacy_install_flow` is **not set** in the TOML (defaults to `false`) — meaning the app is already configured for modern managed installation.

---

## Recommendation

Remove `SCOPES` from:
1. `.env.example`
2. `src/lib/Shopify.ts` — `ShopifyConfig.scopes`, the `Config` reader, and the `ShopifyApi.shopifyApi({ scopes })` field

Scopes are fully managed by `shopify.app.toml` + `shopify app deploy`. Passing them at runtime is redundant and conflicts with the modern approach.

> **Note:** `shopify.app.toml` should live in the project root (not `.shopify-cli/`). Currently this project only has it under `.shopify-cli/` which is the CLI cache — a proper root-level `shopify.app.toml` should be created when setting up the app config properly.
