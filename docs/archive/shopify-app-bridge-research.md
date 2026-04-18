# Shopify App Bridge research

Grounds the port's App Bridge setup against the template it mirrors (`refs/shopify-app-template`) and the upstream packages (`refs/shopify-bridge`, `refs/shopify-app-js`).

## What is App Bridge

- JS SDK that lets an embedded app (iframe under `admin.shopify.com`) talk to Shopify admin (outside the iframe).
- Exposed as a `window.shopify` global once the CDN script is loaded; apps call APIs like `shopify.toast.show`, `shopify.intents.invoke`, `shopify.idToken`, `shopify.resourcePicker`.
- Also ships App Bridge web components (`ui-nav-menu`, `ui-title-bar`, `ui-modal`, `ui-save-bar`) that render chrome outside the iframe.
- Source of truth: `refs/shopify-docs/docs/api/app-home.md:42-44`, `refs/shopify-docs/docs/api/app-home.md:80-88`, `refs/shopify-docs/docs/api/app-home/apis/toast.md:15-17`.

## What problem does it solve

- The App Home is rendered inside an iframe hosted by Shopify admin (`refs/shopify-docs/docs/api/app-home.md:42`). Same-origin APIs can't reach the parent admin.
- App Bridge bridges that iframe boundary without the app managing postMessage, auth tokens, or CSRF itself.
- Specifically it enables:
  - UI outside the iframe (title bar, nav menu, modals, save bar, toasts).
  - Session-token auth for backend calls (`shopify.idToken()` short-lived JWTs; `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:33,45`).
  - Direct authenticated Admin GraphQL from the browser via `fetch('shopify:admin/api/graphql.json', ...)` (`refs/shopify-docs/docs/api/app-home.md:155-161`).
  - Navigation events (`shopify:navigate`) the app router can listen to.

## How the template sets it up

Three pieces do all the work.

### 1. Scope the App Bridge script to the embedded subtree

`refs/shopify-app-template/app/routes/app.tsx:15-27` wraps the `/app` tree in `AppProvider` from `@shopify/shopify-app-react-router/react` with `embedded` + `apiKey`. Root layout (`refs/shopify-app-template/app/root.tsx`) intentionally does not load App Bridge — only embedded routes do.

```tsx
<AppProvider embedded apiKey={apiKey}>
  <s-app-nav>...</s-app-nav>
  <Outlet />
</AppProvider>
```

### 2. AppProvider renders the CDN scripts and a navigate bridge

`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:100-138`:

- Injects `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey}>` when `embedded`.
- Always injects Polaris: `<script src="https://cdn.shopify.com/shopifycloud/polaris.js">`.
- Registers a DOM listener for `shopify:navigate` and calls React Router `navigate(href)` so App Bridge nav links drive SPA navigation.

The `data-api-key` attribute is how App Bridge discovers the app's API key (Partner Dashboard Client ID; `refs/shopify-app-js/.../AppProvider.tsx:20-27`).

### 3. `useAppBridge` exposes the `shopify` global

`refs/shopify-bridge/packages/app-bridge-react/src/hooks/useAppBridge.ts:44-54`:

- Returns `window.shopify` on the client; throws on server with a helpful message.
- Typed as `ShopifyGlobal` from `@shopify/app-bridge-types` (types fetched from CDN, see `refs/shopify-bridge/packages/app-bridge-types/README.md:20-26`).

Consumers call it like `refs/shopify-app-template/app/routes/app._index.tsx:90-99,150-155`:

```tsx
const shopify = useAppBridge();
shopify.toast.show("Product created");
shopify.intents.invoke?.("edit:shopify/Product", { value: id });
```

`@shopify/app-bridge-react` also ships thin wrappers for App Bridge web components (`NavMenu`, `TitleBar`, `Modal`, `SaveBar`; `refs/shopify-bridge/packages/app-bridge-react/src/index.ts:1-15`) — just custom-element aliases with typed attributes.

## How the port sets it up

### Parity pieces (correct)

- Scripts scoped to `/app` subtree via a local `AppProvider`: `src/routes/app.tsx:58-68` wraps children in `<AppProvider embedded apiKey>`.
- `src/components/AppProvider.tsx:1-47` mirrors the upstream AppProvider structurally:
  - Injects `app-bridge.js` with `data-api-key` when `embedded`.
  - Injects `polaris.js`.
  - Listens for `shopify:navigate` and calls TanStack Router `useNavigate()` — the TanStack-correct swap for React Router `navigate`.
- `src/routes/app.index.tsx:2,141-178` uses upstream `useAppBridge()` from `@shopify/app-bridge-react` (same pattern as template) instead of hand-rolled `window.shopify` typing.
- `apiKey` sourced server-side via `beforeLoad` context (`src/routes/app.tsx:40-56`) instead of a React Router loader — same net effect, wired the TanStack way.
- Root route does not load App Bridge (`src/routes/__root.tsx:19-38`), matching template's decision to load only on embedded routes.
- Document headers for `preconnect`/`preload` of the App Bridge CDN + CSP `frame-ancestors` are set in the worker response (`src/lib/Shopify.ts:156-167`, `src/worker.ts:125`), matching the upstream `addDocumentResponseHeaders` contract (`refs/shopify-app-template/app/shopify.server.ts:29`).

### Drift from the template (intentional)

1. We still keep a local `AppProvider` shim instead of importing `@shopify/shopify-app-react-router/react` `AppProvider` directly.
   - Reason: upstream provider is wired to React Router hooks; this port uses TanStack Router.
   - The local intent is now documented in JSDoc at `src/components/AppProvider.tsx:31-38`.

## Are we doing it correctly?

Yes. Current setup is now aligned on the important App Bridge integration points:

- Uses upstream `useAppBridge()` for typed access to `shopify` global APIs.
- Preserves route-scoped script injection and `shopify:navigate` bridge behavior.
- Keeps a local provider only where framework adaptation is required (TanStack Router vs React Router), with JSDoc documenting why.

## Grounded references

- Template shell: `refs/shopify-app-template/app/routes/app.tsx:1-37`
- Template AppProvider impl: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:100-138`
- `useAppBridge` impl: `refs/shopify-bridge/packages/app-bridge-react/src/hooks/useAppBridge.ts:44-54`
- App Bridge React package surface: `refs/shopify-bridge/packages/app-bridge-react/src/index.ts:1-15`
- App Home overview: `refs/shopify-docs/docs/api/app-home.md:15-88`
- Toast API: `refs/shopify-docs/docs/api/app-home/apis/toast.md:15-44`
- Port's AppProvider: `src/components/AppProvider.tsx:1-47`
- Port's App Bridge usage: `src/routes/app.index.tsx:2,141-178`
- Port's iframe headers: `src/lib/Shopify.ts:156-167`
