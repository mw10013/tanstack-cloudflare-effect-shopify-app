# Shopify auth in this repo (decision memo)

## Decision

- Keep route/document auth on `shopify.authenticateAdmin(...)`.
- Use TanStack server-function middleware for server-fn auth.
- Client middleware adds `Authorization: Bearer <session_token>` via App Bridge `shopify.idToken()`.
- Server middleware verifies with `shopify.authenticateAdmin(request)` and injects `{ admin, session }`.
- Never trust client-provided `shop` as auth proof.

## Why this is correct

- Shopify requires embedded frontend -> backend auth with session tokens.
  - Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md`
- Session tokens exist because third-party cookie auth is unreliable in embedded apps.
  - Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md`
- Current App Bridge can auto-handle token plumbing in many flows.
  - Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens/set-up-session-tokens.md`

## Why template looks simpler

- Template uses route loaders/actions + `authenticate.admin(request)` on every request.
  - Source: `refs/shopify-app-template/app/routes/app.tsx`
  - Source: `refs/shopify-app-template/app/routes/app._index.tsx`
- Shopify helper accepts both token carriers:
  - `Authorization` header (XHR/fetch)
  - `id_token` query param (document flow)
  - Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/get-session-token-header.ts`
- Missing document token triggers bounce flow to `/auth/session-token`.
  - Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/ensure-session-token-search-param-if-required.ts`

## Why we needed explicit middleware

- TanStack server-fn RPC uses dedicated URL and sends only headers you provide.
  - Source: `refs/tan-start/packages/start-client-core/src/client-rpc/createClientRpc.ts`
  - Source: `refs/tan-start/packages/start-client-core/src/client-rpc/serverFnFetcher.ts`
- So server-fn auth must explicitly attach `Authorization` in client middleware.

## Current implementation

- Route auth: `src/routes/app.tsx` + `src/lib/Shopify.ts` (document flow, bounce supported).
- Server-fn auth middleware: `src/lib/ShopifyServerFnMiddleware.ts`.
- Product server-fn now uses middleware context admin client: `src/routes/app.index.tsx`.

## `globalThis.shopify` origin

- `AppProvider` injects `https://cdn.shopify.com/shopifycloud/app-bridge.js`.
  - Source: `src/components/AppProvider.tsx`
- App Bridge exposes APIs via global `shopify`.
  - Source: `refs/shopify-docs/docs/api/app-home.md`

## Storage rules

- Session token: ephemeral, request-scoped, do not persist.
- Access tokens: persist server-side only.
  - Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md`
  - Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md`
