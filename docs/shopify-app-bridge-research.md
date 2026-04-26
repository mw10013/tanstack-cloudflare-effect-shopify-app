# Shopify App Bridge Leverage Research

Question: this port mirrors `refs/shopify-app-template` on TanStack Start + Cloudflare + effect v4. Given current code, where are we still manually implementing behavior that can be leveraged from `refs/shopify-bridge` and `refs/shopify-app-js`, and what should we do next?

## Executive Summary

- Keep server functions + middleware as the default for app-internal RPC. Current implementation is viable and aligned with App Bridge behavior.
- Plain `/app/api/...` routes are optional, not required for auth correctness. Use them only when you need a stable public URL shape (extensions/external callers/debug endpoints).
- Client auth duplication is already removed: `shopifyServerFnMiddleware` is server-only (`src/lib/ShopifyServerFnMiddleware.ts:31-51`).
- Retry contract propagation is already correct: non-redirect `Response` values are preserved in middleware and route boundary (`src/lib/ShopifyServerFnMiddleware.ts:39-43`, `src/routes/app.tsx:81-85`).
- The largest manual area is still `src/lib/Shopify.ts` admin auth strategy. This is expected because the Shopify server adapter in `shopify-app-js` is React Router coupled.

## Current State

### Server function auth path

`src/lib/ShopifyServerFnMiddleware.ts:31-43`:

```ts
export const shopifyServerFnMiddleware = createMiddleware({ type: "function" })
  .server(({ next, context }) =>
    context.runEffect(
      Effect.gen(function* () {
        const auth = yield* shopify.authenticateAdmin(request);
        if (auth instanceof Response) {
          const location = auth.headers.get("Location") ?? auth.headers.get("location");
          if (location) return yield* Effect.fail(redirect({ href: location }));
          return yield* Effect.fail(auth);
        }
        return yield* Effect.tryPromise({
          try: () => next({ context: { admin: auth, session: auth.session } }),
          catch: (cause) => cause,
        });
      }),
    ),
  );
```

What this means:

- No manual client-side token attachment.
- Redirect Responses are mapped to TanStack `redirect(...)`.
- Non-redirect Responses (including `401 + X-Shopify-Retry-Invalid-Session-Request`) are passed through intact.

### `/app` route boundary auth path

`src/routes/app.tsx:81-85` matches the same pass-through pattern:

```ts
if (auth instanceof Response) {
  const location = auth.headers.get("Location") ?? auth.headers.get("location");
  if (location) return yield* Effect.fail(redirect({ href: location }));
  return yield* Effect.fail(auth);
}
```

### App Bridge runtime assumptions (still correct)

- App Bridge injects auth into global `fetch` and removed `useAuthenticatedFetch` for that reason (`refs/shopify-bridge/packages/app-bridge-react/CHANGELOG.md:177`).
- Session-token docs still describe automatic token attachment in current App Bridge (`refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens/set-up-session-tokens.md:17`).
- Shopify server strategy still uses `401` plus `X-Shopify-Retry-Invalid-Session-Request: 1` as retry trigger (`refs/shopify-app-js/packages/apps/shopify-app-remix/src/server/authenticate/const.ts:7-9`).

## Do We Need Plain API Routes?

Short answer: no, not for auth.

Given current refactor, server fn + middleware is a solid default:

- App Bridge handles browser token attachment/retry at `fetch` boundary.
- Middleware handles server auth context injection (`admin`, `session`).
- Server fn transport preserves raw `Response` values when thrown/failed.

When plain API routes are still useful:

- You need stable path contracts for extensions or external integrations.
- You want endpoints that are easy to hit manually (curl/devtools/bookmarks).
- You do not need server-fn RPC serialization/type transport on that path.

Recommendation: keep server functions as primary path; add plain API routes only for explicit URL-contract requirements.

## Duplication / Manual Implementation Audit (Current)

### Already leveraged from Shopify libraries

- `@shopify/app-bridge-react` is used directly in UI (`src/routes/app.index.tsx:2`, `useAppBridge`).
- App Bridge script bootstrapping is in place (`src/components/AppProvider.tsx:24`).
- Shopify API client/token exchange/session decode are used from `@shopify/shopify-api` inside `src/lib/Shopify.ts`.

### Manual code that remains, with current value

1. `src/lib/Shopify.ts` admin auth strategy (high value, expected)
   - Includes `authenticateAdmin`, token decode/exchange branch logic, bounce/exit iframe rendering, retry response creation (`src/lib/Shopify.ts:403-428`, `src/lib/Shopify.ts:446-572`).
   - This remains necessary because `@shopify/shopify-app-react-router/server` is framework-adapter code tied to React Router lifecycle.

2. `src/components/AppProvider.tsx` TanStack navigation bridge (medium value, expected)
   - Local adapter listens to `shopify:navigate` and routes through TanStack `navigate` (`src/components/AppProvider.tsx:10-21`).
   - Needed because Shopify's packaged provider assumes React Router hooks.

3. JSX augmentation for `s-app-nav` (low value, optional cleanup)
   - Local module augmentation in `src/routes/app.tsx:35-42` keeps typecheck clean with current template element usage.
   - Can be revisited if/when we prefer `@shopify/app-bridge-react` wrappers for nav elements.

## Forward Plan

1. Keep server fn + `shopifyServerFnMiddleware` as the default app RPC path.
2. Add/keep integration tests that assert retry-header propagation through server fn middleware and `/app` boundary.
3. Continue using plain API routes only when URL-stability needs are explicit.
4. Re-check `shopify-app-js` adapter surface periodically; if Shopify ships a framework-agnostic server auth core, migrate `src/lib/Shopify.ts` toward it.

## Bottom Line

- Yes: with the current refactor, it is viable to stick with middleware + server functions.
- Main duplication risk that remains is not token header handling; it is the unavoidable local framework adapter surface in `src/lib/Shopify.ts` and `src/components/AppProvider.tsx`.
- Focus next on hardening tests and minimizing adapter surface area, not on replacing server functions with plain API routes.
