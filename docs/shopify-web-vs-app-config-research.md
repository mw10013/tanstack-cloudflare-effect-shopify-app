# Shopify Web vs App Config Research

## Questions

1. What is `shopify.web.toml` in this repo?
2. Is it related to `shopify.app.tanstack-cloudflare-effect-app.toml`?
3. Why `shopify.web.toml` (fixed name) and not `shopify.web.<config>.toml`?
4. Are we using `.env` because we are not using `.dev.vars`?

## Short answers

- `shopify.web.toml` is Shopify CLI web-process config (`roles`, `webhooks_path`, `port`, and `commands.dev`).
- `shopify.app.tanstack-cloudflare-effect-app.toml` is app-level config for one linked Shopify app (named app config file).
- They are related but different layers: app metadata/config vs web process execution.
- Yes: in current setup, `.env` is the local env file in use, and there is no `.dev.vars` file.

## Grounding: Shopify docs

From `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md`:

- App-level named config files are explicitly documented as `shopify.app.{config-name}.toml` (`:46`, `:61`).
- Web process files are explicitly documented as `shopify.web.toml` (`:18`, `:79-83`).
- Multi-process behavior is documented as creating a `shopify.web.toml` for each process (`:87`).
- Discovery is by directory location, optionally controlled with `web_directories` in app config (`:89`, `:132`).

Implication: Shopify documents a naming pattern for `shopify.app.*.toml`, but not for `shopify.web.*.toml`. For web config, multiplicity is handled by directory placement, not filename suffix.

## Grounding: Cloudflare docs

From `refs/cloudflare-docs/src/content/partials/workers/secrets-in-dev.mdx`:

- "Choose to use either `.dev.vars` or `.env` but not both" (`:16`).
- "If you define a `.dev.vars` file, then values in `.env` files will not be included" (`:16`).
- To include process env vars, "ensure there is no `.dev.vars` and then set `CLOUDFLARE_INCLUDE_PROCESS_ENV` to `\"true\"`" (`:45`).

## Grounding: this repo

- Web config exists at `shopify.web.toml` and sets:
  - `roles = ["frontend", "backend"]` (`shopify.web.toml:2`)
  - `webhooks_path = "/webhooks/app/uninstalled"` (`shopify.web.toml:3`)
  - `port = 3200` (`shopify.web.toml:4`)
  - `dev = "env CLOUDFLARE_INCLUDE_PROCESS_ENV=true pnpm dev"` (`shopify.web.toml:20`)
- App config exists as named config file: `shopify.app.tanstack-cloudflare-effect-app.toml` (`:1-20`).
- `pnpm dev` exports vars from `.env` before starting Vite: `set -a && source .env && set +a` (`package.json:9`).
- Repo scan result: `.env` exists, `.dev.vars*` not present.

## Direct answer to the two confusions

### 1) "We have `.env` since we are not using `.dev.vars`, right?"

Yes, for current local setup that is correct.

- Cloudflare docs say pick one local env source (`.env` or `.dev.vars`) and that `.dev.vars` suppresses `.env` loading.
- This repo has `.env` and no `.dev.vars`.
- `shopify.web.toml` also sets `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`, matching Cloudflare guidance for process env inclusion when no `.dev.vars`.

### 2) "Why `shopify.web.toml` not `shopify.web.tanstack-cloudflare-effect-app.toml`?"

Because Shopify CLI docs only define named-file convention for app config (`shopify.app.{config-name}.toml`), not for web config.

- Web config is expected as `shopify.web.toml`.
- If you need multiple web processes/configs, Shopify expects multiple `shopify.web.toml` files in different directories (or explicitly listed via `web_directories`), rather than filename-suffixed variants.
