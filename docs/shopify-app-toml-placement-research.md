# shopify.app.toml Placement Research

## Verdict

**The LLM's note is sound.** `shopify.app.toml` belongs at the project root, not under `.shopify-cli/`. This project currently only has it under `.shopify-cli/shopify.app.toml`, which is the CLI's runtime state/cache directory — not the intended location for the checked-in config file.

## Evidence

### Template places it at root

`refs/shopify-app-template/shopify.app.toml` is a root-level file:

```
refs/shopify-app-template/
├── shopify.app.toml        ← root-level
├── shopify.web.toml.liquid
├── app/
├── prisma/
└── ...
```

The template's `.gitignore` explicitly ignores `.shopify/*` and `.shopify.lock` (the CLI's runtime state) while committing `shopify.app.toml` at root:

```gitignore
# Ignore shopify files created during app dev
.shopify/*
.shopify.lock
```

### `.shopify-cli/` is CLI state, not project config

This project only has `shopify.app.toml` under `.shopify-cli/`:

```
.shopify-cli/
├── shopify.app.toml   ← CLI cache/state, not the real config
├── shopify.web.toml
└── extensions/
```

The `.shopify-cli/` directory is where the Shopify CLI caches runtime state. Historically, older CLI versions wrote `.shopify-cli/` as their working directory. The modern CLI (`shopify app config link`) generates `shopify.app.toml` at the project root and uses `.shopify/` (not `.shopify-cli/`) for state.

### CLI config commands target root-level file

From `refs/shopify-docs/docs/api/shopify-cli/app/app-config-link.md`:

> Pulls app configuration from the Developer Dashboard and **creates or overwrites a configuration file**.

From `refs/shopify-docs/docs/api/shopify-cli/app/app-config-pull.md`:

> Pulls the latest configuration from the already-linked Shopify app and **updates the selected configuration file**.

Both commands operate on root-level `shopify.app.toml` (or named variants like `shopify.app.staging.toml`). The `--config` flag selects among these root-level configs.

## What to Do

1. Create `shopify.app.toml` at the project root by running `shopify app config link` (which generates it from the Partner Dashboard), or manually copy and adapt from `.shopify-cli/shopify.app.toml`.
2. The `.shopify-cli/` directory should be git-ignored (it is already not committed based on `.gitignore` patterns).
3. The root `shopify.app.toml` should be committed to git — it's the app's source of truth for configuration (`include_config_on_deploy = true` in the current `.shopify-cli/` version means deploy reads from this file).

## Current State

`.shopify-cli/shopify.app.toml` (the only toml currently) contains a real `client_id` and configuration:

```toml
client_id = "9a91c9ff6ba488dafb39a7c696429753"
name = "tanstack-start"
application_url = "https://shopify.dev/apps/default-app-home"
embedded = true

[build]
automatically_update_urls_on_dev = true
include_config_on_deploy = true

[webhooks]
api_version = "2026-07"
  [[webhooks.subscriptions]]
  topics = [ "app/uninstalled" ]
  uri = "/webhooks/app/uninstalled"
  [[webhooks.subscriptions]]
  topics = [ "app/scopes_update" ]
  uri = "/webhooks/app/scopes_update"

[access_scopes]
scopes = "write_products"

[auth]
redirect_urls = [ "https://shopify.dev/apps/default-app-home/api/auth" ]
```

This content is what belongs at the project root (with `client_id` possibly kept out of git if treating it as sensitive, though Shopify treats client IDs as non-secret).
