# Shopify React Router template -> TanStack Start + Cloudflare D1 port arc

This doc is the high-level plan for porting the official Shopify React Router template to this repo's stack.

## Source of truth

- Official template code: `refs/shopify-app-template`
- Official docs: `refs/shopify-docs/docs/apps/build`

## Why this is the target

Shopify's official build path is React Router-first:

- `refs/shopify-docs/docs/apps/build/build.md:2` (`Build a Shopify app using React Router`)
- `refs/shopify-docs/docs/apps/build/build.md:24` (`@shopify/shopify-app-react-router` package)
- `refs/shopify-docs/docs/apps/build/build.md:32` (scaffold with React Router template)

So the porting goal is parity with `refs/shopify-app-template`, adapted to TanStack Start + Cloudflare Workers + D1.

## Official template architecture (baseline)

### App bootstrap and auth primitive

- Template centralizes auth/app config in `app/shopify.server.ts`:
  - `shopifyApp({ apiKey, apiSecretKey, scopes, appUrl, authPathPrefix, sessionStorage })`
  - `refs/shopify-app-template/app/shopify.server.ts:10-18`
- Template exports key primitives from that file:
  - `authenticate`, `login`, `addDocumentResponseHeaders`, `registerWebhooks`
  - `refs/shopify-app-template/app/shopify.server.ts:29-34`

### Auth and embedded route flow

- Auth entry route calls `authenticate.admin(request)`:
  - `refs/shopify-app-template/app/routes/auth.$.tsx:6-8`
- Login route uses `login(request)` helper:
  - `refs/shopify-app-template/app/routes/auth.login/route.tsx:9-17`
- Embedded app layout wraps routes with `AppProvider embedded apiKey={...}`:
  - `refs/shopify-app-template/app/routes/app.tsx:19`

### Document headers for embedded reliability

- Template applies Shopify response headers in SSR entry:
  - `addDocumentResponseHeaders(request, responseHeaders)`
  - `refs/shopify-app-template/app/entry.server.tsx:17`

### App-specific webhooks in TOML + handlers

- App-specific subscriptions configured in TOML:
  - `app/uninstalled`, `app/scopes_update`
  - `refs/shopify-app-template/shopify.app.toml:12-19`
- Matching webhook handlers:
  - `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:5-14`
  - `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:5-19`

### CLI process configuration

- Single-process app uses `roles = ["frontend", "backend"]`:
  - `refs/shopify-app-template/shopify.web.toml.liquid:2`
- Official docs confirm this convention:
  - `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:130`

## Shopify docs constraints that shape the port

- CLI injects runtime vars (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `HOST/APP_URL`, `SCOPES`):
  - `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:138-143`
- Embedded apps must handle iframe OAuth escape flow:
  - `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant.md:111-119`
- Embedded apps need session tokens:
  - `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:19`
- Dev Dashboard is the credential source (`Client ID` / `Client secret`):
  - `refs/shopify-docs/docs/apps/build/dev-dashboard/get-api-access-tokens.md:55-57`

## Current repo status vs template

### Phase 1 complete (foundation)

- Auth begin endpoint exists: `src/routes/auth.ts:5`
- Auth callback exists: `src/routes/auth.callback.ts:5`
- Uninstall webhook validation + cleanup exists: `src/routes/webhooks.app.uninstalled.ts:5`
- Guarded app route exists: `src/routes/app.ts:19`
- Shopify API runtime config from env exists: `src/lib/Shopify.ts:45`
- Vite tunnel host allowlist for Shopify preview exists: `vite.config.ts:31`

### Remaining gaps to parity

- No embedded `AppProvider` shell equivalent yet (template has it in `app.tsx`).
- No global Shopify document-header injection equivalent yet (template does in `entry.server.tsx`).
- No `app/scopes_update` webhook handler yet.
- Runtime currently uses `@shopify/shopify-api` directly; template uses `@shopify/shopify-app-react-router` package abstractions.

## Port arc (high-level phases)

1. **Phase 1 (done): auth/session foundation**
   - install loop, callback, D1-backed session persistence, uninstall cleanup

2. **Phase 2: embedded shell parity**
   - add TanStack-native embedded shell behavior analogous to template `AppProvider embedded`
   - add Shopify document response headers globally for HTML responses
   - ensure iframe-safe auth transitions remain correct

3. **Phase 3: app surface parity**
   - port baseline app pages and nav structure from template route set (`/app`, `/app/additional`, etc.)
   - wire server-side Admin API calls with TanStack server routes/functions

4. **Phase 4: webhook/scopes parity**
   - add `app/scopes_update` webhook route and reconcile scope/session drift behavior
   - keep app-specific subscriptions in `.shopify-cli/shopify.app.toml`

5. **Phase 5: production hardening**
   - env/secret management hardening
   - observability + retry/idempotency around webhooks
   - deployment posture checks for Cloudflare Workers runtime

## Data/storage adaptation rule

Template uses Prisma session storage:

- `refs/shopify-app-template/app/shopify.server.ts:7`

This repo keeps D1 session storage as the platform-native replacement.

## Decision log from phase 1 that remains in force

- Credentials come from Dev Dashboard Settings, not Partner `API access requests` page.
- Shopify preview can fail on rotating tunnel hostnames without `server.allowedHosts` handling.
- `SHOPIFY_APP_URL`/`APP_URL`/`HOST` must resolve at runtime or Shopify init fails.

## Active docs split

- Implementation learnings/runbook: `docs/shopify-phase-1-auth-dev-store-research.md`
- Phase 2 implementation research: `docs/shopify-phase-2-embedded-shell-research.md`
- Full-arc porting plan (this file): `docs/shopify-porting-arc-research.md`
- Shopify docs mirror script behavior: `docs/shopify-docs-fetch-script-research.md`
