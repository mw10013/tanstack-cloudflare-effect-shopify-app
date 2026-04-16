# Shopify phase 1 research (TanStack Start + Cloudflare + D1)

## Goal for phase 1

Get this app installable in a Shopify dev store and render a simple authenticated page with static text.

Success criteria:

1. `shopify app dev` runs from this repo
2. app installs into a dev store
3. navigating to app home shows text like `Phase 1 works`

## Why this phase is auth-first

Auth is the hard part for embedded apps:

- `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant.md:111`

  > `you can't perform a redirect from inside an iframe in the Shopify admin`

- `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:19`

  > `All apps rendered in the Shopify admin need to use session tokens`

Shopify recommends token exchange for embedded apps:

- `refs/shopify-rr/packages/apps/shopify-api/docs/guides/oauth.md:19-25`

  > `strongly recommend ... Shopify managed installation with token exchange`

For a phase-1 spike, auth code grant is still acceptable to get the install loop and first page working:

- `refs/shopify-rr/packages/apps/shopify-api/docs/guides/oauth.md:81-84`

  > create endpoints for `shopify.auth.begin` and `shopify.auth.callback`

## Current repo baseline (relevant)

- Cloudflare + TanStack Start worker path already exists:
  - `wrangler.jsonc:7` -> `"main": "./src/worker.ts"`
  - `src/worker.ts:109-118` -> fetch handler wiring into `@tanstack/react-start/server-entry`
- local app dev script is already present:
  - `package.json:6` -> `vite dev --port $PORT`
- Shopify CLI config is intentionally isolated in `.shopify-cli/` and invoked with `--path .shopify-cli`:
  - `package.json:29-31`
  - `.shopify-cli/shopify.app.toml`
  - `.shopify-cli/shopify.web.toml`

## Required config files for phase 1

Shopify CLI app shape expects `shopify.app.toml` and `shopify.web.toml` in the selected app directory:

- `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:17-19`

  > `shopify.app.toml`, `shopify.web.toml`

For this repo, the selected app directory is `.shopify-cli/` (via `--path .shopify-cli`).

### 1) `.shopify-cli/shopify.app.toml`

Minimal phase-1 template:

```toml
client_id = "<from Shopify app>"
name = "tanstack-effect-shopify"
application_url = "https://example.com"
embedded = true

[build]
automatically_update_urls_on_dev = true
include_config_on_deploy = true
dev_store_url = "<your-dev-store>.myshopify.com"

[access_scopes]
scopes = "read_products"

[auth]
redirect_urls = [
  "https://example.com/auth/callback"
]

[webhooks]
api_version = "2026-07"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/app/uninstalled"
```

Why these fields matter:

- app URL + embedded:
  - `refs/shopify-docs/docs/apps/build/app-configuration.md:103-105`
- scopes required for install permissions:
  - `refs/shopify-docs/docs/apps/build/app-configuration.md:118`
- redirect URLs required for OAuth callbacks:
  - `refs/shopify-docs/docs/apps/build/app-configuration.md:145`
- `automatically_update_urls_on_dev` avoids manual tunnel URL edits during local dev:
  - `refs/shopify-docs/docs/apps/build/app-configuration.md:243`
- `dev_store_url` pins the store used during `app dev`:
  - `refs/shopify-docs/docs/apps/build/app-configuration.md:244`

Also important:

- `refs/shopify-docs/docs/apps/build/app-configuration.md:15`

  > `shopify.app.toml` changes are applied automatically during `app dev`

### 2) `shopify.web.toml` (new)

Minimal phase-1 template for this repo:

```toml
name = "TanStack Start"
roles = ["frontend", "backend"]
webhooks_path = "/webhooks/app/uninstalled"
port = 3200

[commands]
dev = "pnpm --dir .. dev"
```

Why:

- `commands.dev` is what `shopify app dev` runs:
  - `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:115`
- single-process apps should include both roles:
  - `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:130`
- environment variables injected by Shopify CLI to this process include `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `HOST/APP_URL`, `PORT`, `SCOPES`:
  - `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:138-143`

## Auth/server route design for phase 1

Use TanStack Start server routes for OAuth endpoints:

- `refs/tan-start/docs/start/framework/react/guide/server-routes.md:6`

  > server routes are useful for handling authentication

And keep Shopify-sensitive logic server-only:

- `refs/tan-start/docs/start/framework/react/guide/execution-model.md:31`

  > route loaders are isomorphic

So, move auth calls into server routes / server functions, not client-side route code.

Initialize Shopify API for web runtime semantics (Workers-style request/response):

- web adapter usage pattern is shown in Shopify code:
  - `refs/shopify-rr/packages/apps/shopify-app-react-router/src/server/shopify-app.ts:1`
    - `import '@shopify/shopify-api/adapters/web-api';`
- auth begin/callback Cloudflare examples return `Response` objects:
  - `refs/shopify-rr/packages/apps/shopify-api/docs/reference/auth/begin.md:22-35`
  - `refs/shopify-rr/packages/apps/shopify-api/docs/reference/auth/callback.md:26-42`

### Recommended endpoint map

1. `GET /auth`
   - call `shopify.auth.begin(...)`
   - Cloudflare workers return `Response` directly
   - reference: `refs/shopify-rr/packages/apps/shopify-api/docs/reference/auth/begin.md:22-35`

2. `GET /auth/callback`
   - call `shopify.auth.callback(...)`
   - persist returned `session` to D1 session storage
   - return redirect response with callback headers
   - reference: `refs/shopify-rr/packages/apps/shopify-api/docs/reference/auth/callback.md:26-42`

3. `GET /app`
   - server-side session check
   - if valid: render text page (`Phase 1 works`)
   - if missing: redirect to `/auth?shop=...`

4. `POST /webhooks/app/uninstalled` (optional in phase 1 but recommended)
   - validate webhook HMAC
   - delete shop sessions from D1

### Session persistence approach

Implement a D1-backed session storage adapter (no Prisma).

Evidence:

- session storage is app responsibility:
  - `refs/shopify-rr/packages/apps/shopify-api/docs/guides/session-storage.md:3`
- required interface methods:
  - `refs/shopify-rr/packages/apps/session-storage/shopify-app-session-storage/src/types.ts:6-40`

Minimal table for phase 1 can mirror Shopify SQLite adapter structure:

- `refs/shopify-rr/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts:126-144`

## CSP / embedded response headers

For embedded app reliability, include frame-ancestor CSP for Shopify admin contexts.

Shopify React Router library does this via `addDocumentResponseHeaders`:

- `refs/shopify-rr/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/add-response-headers.ts:39-40`

  > `frame-ancestors https://{shop} https://admin.shopify.com ...`

In TanStack Start, attach equivalent headers via request middleware for document responses.

- `refs/tan-start/docs/start/framework/react/guide/middleware.md:431`

  > global request middleware runs before SSR/server routes/server functions

## How to get it visible in a dev store (runbook)

### Critical rule before running

Do not run this repo and `refs/phc` against the same Shopify app at the same time.

Reason:

- app config changes are applied automatically on `app dev`:
  - `refs/shopify-docs/docs/apps/build/cli-for-apps/app-configuration.md:96`

If both projects share one `client_id`, whichever `shopify app dev` runs last overwrites app URL/redirect/webhook config for that app.

### One-by-one checklist (safe path)

1. **Create a second Shopify app (dedicated to this repo)**
   - do not reuse the `phc` app
   - if this repo uses a different `client_id` than `phc`, both can run side-by-side
   - Shopify supports multiple configs/apps per codebase:
     - `refs/shopify-docs/docs/apps/build/cli-for-apps/manage-app-config-files.md:60-63`

### Click-by-click: create the second app in Dev Dashboard

1. Open `https://dev.shopify.com/dashboard/`
2. In left nav, click **Apps**
3. Click **Create app** (top-right)
4. Click **Start from Dev Dashboard**
5. Enter app name, click **Create**

Source:

- `refs/shopify-docs/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard.md:44-47`

### Click-by-click: get Client ID + Client secret

1. Open the new app in Dev Dashboard
2. Click **Settings**
3. Copy **Client ID** and **Client secret**

Source:

- `refs/shopify-docs/docs/apps/build/dev-dashboard/get-api-access-tokens.md:55-57`

### If you don't have a dev store yet

1. Open `https://dev.shopify.com/dashboard/`
2. Click **Stores**
3. Click **Create store**
4. Enter store name and choose plan
5. Click **Create store**

Source:

- `refs/shopify-docs/docs/apps/build/dev-dashboard/development-stores.md:27-45`

### Continue in terminal (this repo)

2. **Link `.shopify-cli` config to the new app**
   - run:

```bash
shopify app config link --path .shopify-cli --client-id <NEW_CLIENT_ID>
```

   - Shopify CLI docs: this command fetches/creates linked config:
     - `refs/shopify-docs/docs/apps/build/cli-for-apps/manage-app-config-files.md:62-68`
   - if CLI says config is already linked or stale, run with reset:

```bash
shopify app config link --path .shopify-cli --client-id <NEW_CLIENT_ID> --reset
```

3. **Ensure CLI uses isolated config dir**
   - run Shopify commands only through scripts using `--path .shopify-cli`:
     - `package.json:29-31`
   - this avoids scanning `refs/phc` web config and backend-role conflicts
   - docs: CLI search paths for web files can be constrained (`web_directories`) and defaults to app root:
     - `refs/shopify-docs/docs/apps/build/cli-for-apps/app-configuration.md:106`
     - `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:89`

4. **Pull env vars directly into `.env` (no manual copy mistakes)**
   - run:

```bash
shopify app env pull --path .shopify-cli --client-id <NEW_CLIENT_ID> --env-file .env
```

   - this updates `.env` with `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`
   - command capability docs (`app env pull`):
     - `shopify app env pull --help`

5. **Confirm app ID actually changed**
   - verify `.shopify-cli/shopify.app.toml` has the new `client_id`
   - verify env with:

```bash
shopify app env show --path .shopify-cli --client-id <NEW_CLIENT_ID>
```

6. **Verify auth callback path matches this implementation**
   - `.shopify-cli/shopify.app.toml:15` should include `/auth/callback`
   - handler exists at `src/routes/auth.callback.ts`

7. **Reset/apply D1 migrations**
   - run: `pnpm d1:reset`
   - confirms `ShopifySession` table from `migrations/0001_init.sql`

8. **Start Shopify dev**
   - run: `pnpm shopify:dev`

9. **Install from preview**
   - in terminal, press `p`
   - click **Install app** in dev store admin

10. **Verify success**
   - expected final response from `GET /app`:
     - `Phase 1 works for <shop>`
     - implemented at `src/routes/app.ts:40`

### If you intentionally share one app with `phc` (not recommended)

Run only one dev server at a time.

- Stop `shopify app dev` in project A before starting project B.
- Expect app URL/redirect/webhook config to flip to whichever project started last.

## Phase-1 scope boundaries

In scope:

- install + auth loop works
- D1 session save/load
- minimal embedded page text

Out of scope (phase 2+):

- token exchange migration
- Polaris/App Bridge component parity
- advanced webhooks/billing/scopes management UI

## Practical recommendation

For this repo, phase 1 should be implemented as:

1. Add Shopify TOMLs
2. Add `shopify-api` auth endpoints (`/auth`, `/auth/callback`)
3. Add D1 session storage table + adapter
4. Add `/app` text page with server-side session guard
5. Run through `shopify app dev`, install in dev store, confirm visible text

That gives a concrete, low-risk checkpoint before attempting full `refs/phc` parity.
