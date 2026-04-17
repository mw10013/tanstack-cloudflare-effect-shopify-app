# Phase 1 realignment: align with refs/shopify-app-template from first principles

## Problem

Current phase 1 implementation diverges from the template in fundamental ways. The index route (`src/routes/index.tsx`) has manual "Start auth" and "Open app route" buttons that don't exist in the template, cause errors, and misrepresent how Shopify apps actually work. The auth flow uses the wrong grant type entirely.

## Decisions

- Token exchange + managed install only, no authorization code grant fallback (matching template exactly).
- Use `@shopify/app-bridge-react` for React hooks/components (matching template).
- `AppProvider` from `@shopify/shopify-app-react-router/react` for App Bridge + Polaris script injection (or replicate it since we can't use that package directly — see client packages section).

## How Shopify loads an embedded app (the `?shop=` bootstrapping problem)

Shopify admin always provides `?shop=` and `?host=` — these are not for "non-embedded" scenarios.

1. Merchant clicks app in Shopify admin sidebar
2. Admin renders an iframe pointing to: `https://{app-url}/?shop={shop}.myshopify.com&host={base64-admin-host}&embedded=1`
3. Server receives a plain GET — **no session token yet** because App Bridge JS hasn't loaded
4. Server serves HTML, App Bridge JS loads in the iframe, extracts a session token (JWT) from the iframe context
5. App Bridge provides the session token to the server (via URL param `id_token` on redirect, or `Authorization` header on fetch requests)
6. Server exchanges that JWT for an access token via token exchange

So `?shop=` solves the bootstrapping problem: the server needs to know which shop before App Bridge exists. After bootstrap, the shop is embedded in the JWT's `dest` claim.

`?host=` is the base64-encoded Shopify admin host (e.g. `admin.shopify.com/store/my-store`). Needed so the server can redirect back into the admin context, and so App Bridge knows where it's embedded. The embedded app URL is `https://{base64_decode(host)}/apps/{api_key}/` (`refs/shopify-docs/.../authorization-code-grant.md:382`).

## Template route inventory (what we're porting to)

| Template route | Purpose |
|---|---|
| `_index/route.tsx` | Landing page. If `?shop=` present (Shopify admin iframe load), redirects to `/app`. Otherwise shows a shop domain form for manual install. |
| `auth.login/route.tsx` | Login route. Calls `shopify.login(request)` on GET and POST. On POST, validates shop, redirects to Shopify's managed install URL. |
| `auth.$.tsx` | Splat route catches all `/auth/*` paths. Calls `authenticate.admin(request)` which handles bounce/exit-iframe scenarios. Not for manual OAuth. |
| `app.tsx` | **Layout** for all `/app/*` routes. Calls `authenticate.admin(request)` in loader. Wraps children in `<AppProvider embedded apiKey={...}>` with `<s-app-nav>`. |
| `app._index.tsx` | Embedded app home page (inside Shopify admin iframe). Calls `authenticate.admin(request)`, renders Polaris web components. |
| `app.additional.tsx` | Second nav page demo. Pure UI, no loader. |
| `webhooks.app.uninstalled.tsx` | Webhook handler. |
| `webhooks.app.scopes_update.tsx` | Webhook handler. |

Source: `refs/shopify-app-template/app/routes/`

## Template auth architecture (what `authenticate.admin` actually does)

The template delegates **all** auth complexity to `shopify.authenticate.admin(request)` from `@shopify/shopify-app-react-router/server`. This single function handles:

1. **Document request (no session token header)**: validates `?shop=` and `?host=` params, redirects to login if missing (`refs/shopify-app-js/.../validate-shop-and-host-params.ts:13-28`)
2. **Not embedded**: if `?embedded` !== `1`, redirects into Shopify admin via `api.auth.getEmbeddedAppUrl()` (`refs/shopify-app-js/.../ensure-app-is-embedded-if-required.ts:14-21`)
3. **Missing session token in embedded context**: redirects to bounce page that uses App Bridge to extract the session token from the iframe context (`refs/shopify-app-js/.../ensure-session-token-search-param-if-required.ts:18-28`)
4. **Token exchange**: exchanges session token for offline (and optionally online) access token, stores session (`refs/shopify-app-js/.../token-exchange.ts:92-152`)
5. **Session active**: returns admin context with GraphQL client, billing helpers, etc.

The template uses **token exchange** (not authorization code grant):
- App Bridge in the iframe provides a session token (JWT) automatically
- Server exchanges that JWT for an access token via `api.auth.tokenExchange()` — a single HTTP POST to `https://{shop}/admin/oauth/access_token` (`refs/shopify-docs/.../token-exchange.md:43-44`)
- No redirect-based OAuth begin/callback dance needed

The `auth.$.tsx` splat route exists as a **fallback** — `authenticate.admin` throws redirects to it when it needs to render App Bridge for bounce/exit-iframe scenarios, not for a manual OAuth code flow.

## Template login flow (how merchants enter)

`shopify.login(request)` (`refs/shopify-app-js/.../login.ts:10-57`):

- **GET without `?shop=`**: returns empty errors (renders the login form)
- **GET with `?shop=`**: template's `_index/route.tsx` catches this and redirects to `/app?shop=...` before login even runs
- **POST with `shop` form field**: sanitizes shop, then redirects to `https://{shop}/admin/oauth/install?client_id={apiKey}`

This install URL is Shopify's managed install — it shows the OAuth consent screen, installs the app, then redirects back into the app inside the admin iframe. After install, subsequent loads go through the token exchange path in `authenticate.admin`.

## Template client-side packages

### `@shopify/shopify-app-react-router/react` — `AppProvider`

This is a thin component from the framework package. Source: `refs/shopify-app-js/.../AppProvider.tsx`

What it does:
- **`embedded={true}`**: injects App Bridge CDN script (`https://cdn.shopify.com/shopifycloud/app-bridge.js`) with `data-api-key={apiKey}`, plus Polaris CDN script (`https://cdn.shopify.com/shopifycloud/polaris.js`), plus a `useEffect` that listens for `shopify:navigate` events and calls React Router's `navigate()`
- **`embedded={false}`**: injects only the Polaris CDN script (for non-embedded pages like the login form)

This component has a React Router dependency (`useNavigate` from `react-router`). For TanStack Start, we need to replicate this with TanStack Router's `useNavigate` instead. The component is ~40 lines — straightforward to port.

### `@shopify/app-bridge-react`

Template uses this in `app._index.tsx:8` for `useAppBridge()`. Source: `refs/shopify-bridge/packages/app-bridge-react/src/hooks/useAppBridge.ts`

This hook just returns `window.shopify` (the global set by the App Bridge CDN script). It also exports React components: `Modal`, `NavMenu`, `TitleBar`, `SaveBar`.

**We should use `@shopify/app-bridge-react` directly** — it has no framework dependency (no React Router imports). It's pure React + the `window.shopify` global. The template uses it (`refs/shopify-app-template/package.json:32`).

### Summary of client packages

| Package | Template uses? | Can we use directly? | Notes |
|---|---|---|---|
| `@shopify/app-bridge-react` | Yes (hooks, components) | **Yes** — no framework dependency | `useAppBridge()`, `Modal`, `NavMenu`, `TitleBar`, `SaveBar` |
| `@shopify/shopify-app-react-router/react` | Yes (`AppProvider`) | **No** — imports `useNavigate` from `react-router` | Port the ~40 line component to use TanStack Router's `useNavigate` |
| `@shopify/shopify-app-react-router/server` | Yes (`authenticate`, `login`, `boundary`) | **No** — imports from `react-router`, assumes Node runtime | Build equivalent using `@shopify/shopify-api` directly |

## Current implementation: status and gaps

### 1) Index route is mostly aligned

Current `src/routes/index.tsx`:
- Redirects to `/app` when `?shop=` is present
- Otherwise renders a shop domain form posting to `/auth/login`

Gap vs template:
- UI is still custom inline HTML/CSS and does not use the same React + Polaris composition as template login.

### 2) Auth architecture is now token exchange based

Current implementation:
- Uses `authenticateAdmin()` in `src/lib/Shopify.ts` for token exchange and session persistence
- Uses `src/routes/auth.$.tsx` as auth splat endpoint for bounce/exit-iframe handling

Gap vs template:
- Need parity cleanup around document headers and login rendering behavior.

### 3) `/app` is now an embedded layout route

Current `src/routes/app.tsx`:
- Layout route with `AppProvider` and `<Outlet />`
- Uses `authenticateAdmin` equivalent path for route authentication

Template `app.tsx`:
- Layout route with `authenticate.admin(request)` in loader
- Renders `<AppProvider embedded apiKey={...}>` + `<s-app-nav>` + `<Outlet />`

### 4) `/auth/login` is still a raw HTML string, not a React component

Current `src/routes/auth.login.ts`:
- Server handler returning an HTML string with inline CSS
- Manual form validation and redirect

Template `auth.login/route.tsx`:
- React component using `<AppProvider embedded={false}>` and Polaris web components
- Calls `shopify.login(request)` which handles validation and redirect

### 5) Redirect behavior for `/` in Shopify admin is fixed

Shopify admin iframe loads `/?shop=...&host=...&embedded=1`. Current `_index` now redirects to `/app` when `?shop=` is present.

## What alignment looks like

### Route mapping (template → this repo)

| Template | This repo equivalent | Status |
|---|---|---|
| `_index/route.tsx` | `src/routes/index.tsx` | **Done** (functional parity) |
| `auth.login/route.tsx` | `src/routes/auth.login.ts` | **Partial**: login logic exists, React route parity pending |
| `auth.$.tsx` | `src/routes/auth.$.tsx` | **Done** |
| `app.tsx` (layout) | `src/routes/app.tsx` | **Done** |
| `app._index.tsx` | `src/routes/app.index.tsx` | **Done** |
| `webhooks.app.uninstalled.tsx` | `src/routes/webhooks.app.uninstalled.ts` | OK (minor differences) |

### Auth strategy: token exchange only

Token exchange (`api.auth.tokenExchange()`) is a simple HTTP POST to Shopify — works fine on Cloudflare Workers.

What token exchange needs:
- A session token JWT from the request (provided by App Bridge via `id_token` URL param or `Authorization` header)
- `@shopify/shopify-api` configured with `isEmbeddedApp: true` (already done in `src/lib/Shopify.ts:67`)
- Session storage (already done with D1)

What we can delete:
- `src/routes/auth.ts` (OAuth begin)
- `src/routes/auth.callback.ts` (OAuth callback)

### What we need to build

1. **`authenticate.admin` equivalent** in `src/lib/Shopify.ts` using `@shopify/shopify-api`:
   - Validate `?shop=` and `?host=` on document requests → redirect to login if missing
   - Redirect non-embedded requests into Shopify admin via `api.auth.getEmbeddedAppUrl()`
   - Handle bounce page for missing session token in embedded context (render App Bridge script to extract token)
   - Exchange session token for access token via `api.auth.tokenExchange()`
   - Load/store sessions in D1

2. **`AppProvider` port** (~40 lines): replicate `refs/shopify-app-js/.../AppProvider.tsx` with TanStack Router's `useNavigate` instead of React Router's

3. **Route rewrites**: index, app layout, app index, auth splat, auth login (see route mapping above)

### Remaining for phase 1 completion

1. Rewrite `src/routes/auth.login.ts` as a React route using `AppProvider embedded={false}` + Polaris web components
2. Ensure document response headers (`Content-Security-Policy`, `Link`) are applied consistently to all HTML document responses
3. Add integration tests for embedded bootstrap redirects (`/`, `/app`, `/auth/session-token`)

## Bounce page mechanism (researched)

The bounce page is how the server gets a session token on the initial document load (before App Bridge is running on the client).

### Flow

1. Shopify admin iframe → `GET /app?shop=foo.myshopify.com&host=...&embedded=1`
2. `authenticate.admin` sees: document request (no `Authorization` header), `embedded=1`, but no `id_token` param
3. Server redirects to bounce page URL: `/auth/session-token?shop=...&host=...&embedded=1&shopify-reload={original-url}`
4. Bounce page responds with minimal HTML containing just the App Bridge script tag:
   ```html
   <script data-api-key="{apiKey}" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
   ```
5. App Bridge CDN script loads inside the Shopify admin iframe, detects the `shopify-reload` query param, extracts the session token (JWT) from the iframe context, and redirects to the `shopify-reload` URL with `&id_token={jwt}` appended
6. Server receives the reload request, now with `?id_token={jwt}`, validates the JWT, and exchanges it for an access token

### Implementation details from source

**`redirectToBouncePage`** (`refs/shopify-app-js/.../redirect-to-bounce-page.ts`):
- Strips any existing `id_token` from search params
- Sets `shopify-reload` param to `{appUrl}{pathname}?{remaining-params}` — the URL to return to after token extraction
- Redirects to `{patchSessionTokenPath}?{searchParams}` (default: `/auth/session-token`)

**`renderAppBridge` / bounce page handler** (`refs/shopify-app-js/.../render-app-bridge.ts`):
- When the URL matches `patchSessionTokenPath` (default `/auth/session-token`), `authenticate.admin` renders the bounce page
- Response is `text/html;charset=utf-8` with just `<script data-api-key="{apiKey}" src="{APP_BRIDGE_URL}"></script>`
- Also sets document response headers: `Content-Security-Policy` (frame-ancestors for the shop), `Link` (preconnect/preload for CDN assets)
- Confirmed by test: `refs/shopify-app-js/.../patch-session-token-path.test.ts:30-32`

**`shopify-reload` handling**: Built into the App Bridge CDN script (not in open source). When App Bridge loads and sees `?shopify-reload={url}`, it extracts the session token from the iframe context and redirects to that URL with `&id_token={jwt}`.

**Exit iframe page** (`/auth/exit-iframe`): Similar mechanism but for navigating out of the iframe (e.g. for billing redirects). Renders App Bridge script + `window.open(destination, '_top')`.

### What this means for our implementation

The bounce page is **not** a React route — it's a raw HTML response. It bypasses the normal app rendering entirely. In TanStack Start, the auth splat route handler should:
1. Check if the path matches `/auth/session-token` → return raw HTML Response with App Bridge script
2. Check if the path matches `/auth/exit-iframe` → return raw HTML Response with App Bridge script + redirect script
3. Otherwise, let `authenticate.admin` handle normally

This is straightforward: no React rendering needed, just a `new Response(html, { headers })` from a server handler.

## Document response headers

Template uses `addDocumentResponseHeaders` in `entry.server.tsx` to set headers on every HTML response:

- **`Content-Security-Policy`**: `frame-ancestors https://{shop} https://admin.shopify.com https://*.spin.dev ...` — required for the iframe to load
- **`Link`**: preconnect/preload hints for `cdn.shopify.com`, `app-bridge.js`, `polaris.js`

Source: `refs/shopify-app-js/.../add-response-headers.ts:24-46`

For TanStack Start, we need to find where to inject these headers on HTML responses. This is a phase 2 (embedded shell) concern but worth noting — without the CSP header, some browsers may block the iframe.

## Env ownership on Cloudflare (local vs production)

This was the missing piece behind `SHOPIFY_APP_URL or APP_URL or HOST is required`.

### What owns which env vars

- **Local (`shopify app dev`)**: Shopify CLI injects app vars into the spawned process, including `HOST/APP_URL` and credentials (`refs/shopify-docs/docs/apps/structure.md:136-143`).
- **Production deploy**: Shopify docs are explicit that env vars must be set in the hosting provider; CLI does not inject them in production (`refs/shopify-docs/docs/apps/launch/deployment/deploy-to-hosting-service.md:153-166`).
- **Cloudflare runtime**: Worker config values come from bindings (`vars`/secrets) on the runtime `env` object (`refs/cloudflare-docs/src/content/docs/workers/configuration/environment-variables.mdx:12-19`, `refs/cloudflare-docs/src/content/docs/workers/configuration/secrets.mdx:12-19`).

### Why this app fails locally today

- Runtime config currently hard-requires `SHOPIFY_APP_URL`/`APP_URL`/`HOST` (`src/lib/Shopify.ts:35-52`).
- Cloudflare local dev can use `.env` (not only `.dev.vars`), but inherited process env is not included unless explicitly enabled (`refs/cloudflare-docs/src/content/partials/workers/secrets-in-dev.mdx:9-17`, `refs/cloudflare-docs/src/content/partials/workers/secrets-in-dev.mdx:41-46`).
- Net: Shopify CLI can have the tunnel URL in parent process env, but Worker runtime still misses it.

### Local solutions (no hardcoded tunnel URL)

1. **Recommended now: include parent process env during local dev**
   - Set `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` in the command that runs `vite dev` under Shopify CLI.
   - Keeps tunnel URL dynamic from Shopify CLI.
   - Source: `refs/cloudflare-docs/src/content/partials/workers/secrets-in-dev.mdx:45-46`.

2. **Keep `.env` flow and normalize at command runtime**
   - Keep static credentials in `.env`.
   - During local dev, map dynamic `HOST/APP_URL` to `SHOPIFY_APP_URL` in the dev command (no file regeneration):
     - `SHOPIFY_APP_URL=${SHOPIFY_APP_URL:-${APP_URL:-$HOST}}`
   - This mirrors template compatibility behavior while preserving dynamic tunnel URLs.

3. **Parity hardening: normalize `HOST -> SHOPIFY_APP_URL` like template**
   - Template does this in Vite startup (`refs/shopify-app-template/vite.config.ts:6-16`).
   - Keep as compatibility shim in local dev.

### Production rule (non-negotiable)

- Set `SHOPIFY_APP_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` in Cloudflare (vars/secrets), and keep Shopify app config `application_url` aligned with deployed URL (`refs/shopify-docs/docs/apps/launch/deployment/deploy-to-hosting-service.md:165-183`).
- Shopify request params (`shop`, `host`) are auth context, not deployment/runtime configuration.

### Open questions

- TanStack Start equivalent of React Router's `entry.server.tsx` for injecting response headers on all document requests. Likely a middleware or server handler concern.
