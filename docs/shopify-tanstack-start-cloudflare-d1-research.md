# Shopify app on TanStack Start (Cloudflare + D1) research

Scanned sources:

- `refs/phc`
- `refs/shopify-docs`
- `refs/tan-start`
- supplemental implementation refs from `refs/shopify-rr` (same Shopify app SDK source used by `phc`)

## Bottom line

You can build a TanStack Start + Cloudflare + D1 Shopify app, but there is no official Shopify TanStack template path today.

The official path is React Router:

- `refs/shopify-docs/docs/apps/build/build.md:2`

  > `title: Build a Shopify app using React Router`

- `refs/shopify-docs/docs/apps/build/build.md:24`

  > `Use the @shopify/shopify-app-react-router package to authenticate users and query data.`

- `refs/shopify-docs/docs/apps/build/build.md:32`

  > `Scaffold an app that uses the React Router template`

So the practical path is: port the Shopify template patterns from `refs/phc` into TanStack Start primitives.

Community examples exist (not official Shopify-owned templates):

- `refs/phc/docs/shopify-tanstack-start-template-research.md:14-18`

  > `community-maintained ... Node examples found ... Cloudflare examples found`

## Why auth is the first stumbling block

Shopify embedded auth has iframe-specific redirects and session-token rules, not just a normal OAuth callback.

- `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant.md:111`

  > `you can't perform a redirect from inside an iframe in the Shopify admin`

- `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant.md:118-119`

  > `escape the iframe using a Shopify App Bridge redirect action ... Perform a 3xx redirect`

- `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:19`

  > `All apps rendered in the Shopify admin need to use session tokens`

- `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:45`

  > `The lifetime of a session token is one minute`

The React Router template already encodes this flow:

- `refs/phc/app/shopify.server.ts:16-17`

  ```ts
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  ```

- `refs/phc/app/routes/auth.$.tsx:6-8`

  ```ts
  export const loader = async ({ request }) => {
    await authenticate.admin(request);
  };
  ```

- `refs/phc/app/entry.server.tsx:17`

  ```ts
  addDocumentResponseHeaders(request, responseHeaders);
  ```

## TanStack Start constraints that matter for porting

- `refs/tan-start/docs/start/framework/react/guide/execution-model.md:31`

  > `Route loaders are isomorphic - they run on both server and client`

This means Shopify-secret logic should not live directly in route loaders unless wrapped in server-only boundaries.

- `refs/tan-start/docs/start/framework/react/guide/server-routes.md:6`

  > `Server routes ... useful for handling ... user authentication`

- `refs/tan-start/docs/start/framework/react/guide/middleware.md:431`

  > `Global request middleware runs before every request, including server routes, SSR and server functions`

- `refs/tan-start/docs/start/framework/react/guide/server-entry-point.md:11`

  > `supports the universal fetch handler format ... Cloudflare Workers`

So TanStack has the right building blocks for Shopify auth, but you must wire them intentionally.

## Important portability caveat from Shopify SDK internals

`@shopify/shopify-app-react-router` is not fully router-agnostic.

- `refs/shopify-rr/packages/apps/shopify-app-react-router/package.json:100-104`

  ```json
  "peerDependencies": {
    "react-router": "^7.6.2"
  }
  ```

- runtime server imports from `react-router` exist:
  - `refs/shopify-rr/packages/apps/shopify-app-react-router/src/server/authenticate/login/login.ts:1`
  - `refs/shopify-rr/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/redirect-to-shopify-or-app-root.ts:1`
  - `refs/shopify-rr/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/validate-shop-and-host-params.ts:1`

- React AppProvider is React Router-bound:

  - `refs/shopify-rr/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:2`

    ```ts
    import { useNavigate } from 'react-router';
    ```

  - `refs/shopify-rr/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:111-117`

    ```ts
    const navigate = useNavigate();
    document.addEventListener('shopify:navigate', ... navigate(href))
    ```

Implication: you cannot drop in `@shopify/shopify-app-react-router/react` directly in a TanStack Router tree.

## Recommended architecture (TanStack version of `refs/phc`)

### 1) Keep Shopify auth/webhook server logic, replace router integration layer

Use Shopify server primitives for OAuth/session/webhook handling, but adapt redirect/navigation and route wiring to TanStack Start.

### 2) Build auth endpoints as TanStack server routes

Map `phc` routes to Start server handlers:

- `/auth/$` catch-all endpoint equivalent of `refs/phc/app/routes/auth.$.tsx`
- `/auth/login` endpoint equivalent of `refs/phc/app/routes/auth.login/route.tsx`
- `/webhooks/app/uninstalled` and `/webhooks/app/scopes_update` equivalents

### 3) Protect `/app/*` with server-side checks

Prefer request middleware or server routes/server functions for auth checks (not plain isomorphic loader logic).

### 4) Replace AppProvider with TanStack-native embedded bridge shell

In `phc`, embedded shell responsibilities are:

- add App Bridge + Polaris scripts
- translate `shopify:navigate` events into router navigation

You can recreate this with:

- script tags (same CDN URLs)
- TanStack `useNavigate` in a small component that listens to `shopify:navigate`

### 5) Add Shopify document headers globally

`phc` calls `addDocumentResponseHeaders` in SSR entry. TanStack equivalent can be request middleware / server entry wrapper for HTML responses.

## D1 instead of Prisma (recommended)

You do not need Prisma.

Shopify session storage is interface-driven:

- `refs/shopify-rr/packages/apps/session-storage/shopify-app-session-storage/src/types.ts:6-40`

  ```ts
  export interface SessionStorage {
    storeSession(session: Session): Promise<boolean>
    loadSession(id: string): Promise<Session | undefined>
    deleteSession(id: string): Promise<boolean>
    deleteSessions(ids: string[]): Promise<boolean>
    findSessionsByShop(shop: string): Promise<Session[]>
  }
  ```

So the clean path is a `D1SessionStorage` implementation using your existing Cloudflare Worker env and D1 access patterns.

Session schema can mirror Shopify template/session adapters:

- `refs/phc/prisma/schema.prisma:16-34`
- `refs/shopify-rr/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts:126-144`

Minimal D1 table shape to start:

```sql
create table if not exists shopify_sessions (
  id text primary key,
  shop text not null,
  state text not null,
  isOnline integer not null,
  scope text,
  expires integer,
  accessToken text,
  userId integer,
  firstName text,
  lastName text,
  email text,
  accountOwner integer,
  locale text,
  collaborator integer,
  emailVerified integer,
  refreshToken text,
  refreshTokenExpires integer
);
```

## Suggested phased plan

1. **Auth spike first**
   - implement `/auth/$` + `/auth/login` server routes
   - verify install/login works inside Shopify admin iframe
2. **Session storage next**
   - implement D1 adapter for `SessionStorage`
   - validate offline + online token reads/writes
3. **Embedded shell**
   - TanStack-native App Bridge + Polaris script wrapper
   - wire `shopify:navigate` to TanStack navigation
4. **Webhooks**
   - add webhook routes with `authenticate.webhook`
   - queue/async processing if needed (Shopify retries on 5s timeout)
5. **Then feature parity with `phc` app pages**
   - port `app._index` and additional routes

## Main risks to validate early

- Redirect semantics mismatch between Shopify React Router helpers (Response throws) and TanStack redirect handling.
- React Router peer dependency leakage if using `@shopify/shopify-app-react-router/server` directly.
- Embedded iframe bounce/session-token edge cases.

## Practical recommendation

Start with a minimal auth-only proof of concept in this repo (no Prisma, D1 session storage only). If that spike passes install/login/embed flows, the rest of a TanStack version of `refs/phc` is straightforward incremental porting.
