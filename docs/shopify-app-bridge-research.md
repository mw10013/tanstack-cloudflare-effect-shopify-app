# Shopify App Bridge Leverage Research

Question: this port aims to mirror `refs/shopify-app-template` on TanStack Start + Cloudflare + effect v4. Where is `src/` re-implementing logic that App Bridge or the Shopify libraries already provide on the client/server, and what concrete changes would let us delete that manual code without losing the template's behavior?

## Executive Summary

- App Bridge — the runtime injected by `<script src=".../app-bridge.js" data-api-key=...>` — already monkey-patches `window.fetch` for embedded apps. It auto-attaches `Authorization: Bearer <id_token>` on same-origin requests and auto-retries on `401 + X-Shopify-Retry-Invalid-Session-Request: 1`.
- TanStack server-fn RPC routes through bare `fetch` (≡ `globalThis.fetch` at call time) to a same-origin URL (`/_serverFn/<id>` by default). App Bridge intercepts that fetch the same way it would intercept a hand-rolled `fetch('/api/...')` — there is nothing TanStack-specific blocking it.
- Concrete redundancy in this port: the `client` half of `src/lib/ShopifyServerFnMiddleware.ts:38-41` (`getSessionToken` + `Authorization` header) duplicates what App Bridge already does. The server half — `authenticateAdmin` returning a 401 with the retry header — is where the value lives, and that pairs cleanly with App Bridge's auto-retry.
- Plain TanStack route `server.handlers` (already used for webhooks at `src/routes/webhooks.app.uninstalled.ts:20-35`) can stand alongside server fns for "thin JSON API" endpoints. Client calls them with regular `fetch('/app/api/...')`, App Bridge attaches the token, the server runs the same `Shopify.authenticateAdmin` flow. No client middleware needed.
- The bulk of `src/lib/Shopify.ts` (`authenticateAdmin`, bounce/exit-iframe pages, `respondToInvalidSessionToken`, `authenticateWebhook`, `unauthenticatedAdmin`) is *not* redundant with App Bridge — it ports server-side strategy from `@shopify/shopify-app-react-router/server`, which is React-Router-coupled and can't be lifted as-is. The shrinkage opportunities here are small: align edge cases with `respondToInvalidSessionToken` semantics and consider replacing the local `AppProvider` with the React-component re-exports `@shopify/app-bridge-react` already gives us.
- Recommended changes, in priority order: (1) remove client-side session-token middleware on the server-fn path; (2) add one plain API route to validate the App-Bridge-auto-fetch path end-to-end; (3) adopt `<NavMenu>` from `@shopify/app-bridge-react` to drop one local JSX augmentation; (4) leave server-side `Shopify.ts` largely as-is — it's the part App Bridge cannot replace.

## Background: How An Embedded App Authenticates Browser → Backend

The flow described in `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md`:

> "When your app first loads, it's unauthenticated and serves up the frontend code for your app. Your app renders a user interface skeleton or loading screen to the user.
> After the frontend code has loaded, your app calls a Shopify App Bridge action to get the session token. Your app includes the session token in an authorization header when it makes any HTTPS requests to its backend."

> "The lifetime of a session token is one minute. Session tokens must be fetched using Shopify App Bridge on each request to make sure that stale tokens aren't used."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md:33-45`.

So the contract is: every browser → backend hop carries a fresh JWT in `Authorization: Bearer …`, and the backend exchanges it (or a stored offline token) to talk to Shopify Admin.

## What App Bridge Auto-Handles On The Client

### Auto-attached `Authorization` header

`refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens/set-up-session-tokens.md:17`:

> "the current version of App Bridge automatically adds session tokens to requests coming from your app."

`refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md:31`:

> "Your app's frontend must acquire a session token from App Bridge. In the current version of App Bridge, this is handled automatically using `authenticatedFetch`. You must include the token in the `AUTHORIZATION` header for all requests to the app's backend."

The patch is opt-out, not opt-in. From the App Bridge config type (`node_modules/.pnpm/@shopify+app-bridge-types@0.7.0/.../shopify.ts:99-121`):

```ts
interface AppBridgeConfig {
  apiKey: string;
  /**
   * An allowlist of origins that your app can send authenticated fetch requests to.
   * This is useful if your app needs to make authenticated requests to a different
   * domain that you control.
   */
  appOrigins?: string[];
  …
  /**
   * The features to disable in your app.
   * This allows app developers to opt-out of features such as `fetch`.
   */
  disabledFeatures?: string[];
}
```

Reading: `fetch` interception is a default feature; `disabledFeatures: ['fetch']` opts out; `appOrigins` extends the allowlist beyond the app's own origin. The default-on, same-origin scope is exactly what this port needs.

### Auto-retry on `401 + X-Shopify-Retry-Invalid-Session-Request: 1`

The matching server-side trigger is implemented by every Shopify SDK that supports embedded apps. From `refs/shopify-app-js/.../authenticate/const.ts:11-13`:

```ts
export const RETRY_INVALID_SESSION_HEADER = {
  'X-Shopify-Retry-Invalid-Session-Request': '1',
};
```

And the strategy that emits it on a stale-JWT XHR (`refs/shopify-app-js/.../authenticate/helpers/respond-to-invalid-session-token.ts:11-28`):

```ts
export function respondToInvalidSessionToken({params, request, retryRequest = false}) {
  …
  const isDocumentRequest = !request.headers.get('authorization');
  if (isDocumentRequest) {
    return redirectToBouncePage({api, logger, config}, new URL(request.url));
  }
  throw new Response(undefined, {
    status: 401,
    statusText: 'Unauthorized',
    headers: retryRequest ? RETRY_INVALID_SESSION_HEADER : {},
  });
}
```

That 401-with-retry-header is the contract App Bridge listens for — not something this port invents. The unit test at `refs/shopify-app-js/.../strategies/__tests__/token-exchange/authenticate.test.ts:187-210` confirms an XHR with a bad token returns 401 + `X-Shopify-Retry-Invalid-Session-Request: 1`.

### Side benefit: the bounce page

Document requests (no `Authorization` header) get redirected to `/auth/session-token`. That route renders `<script src=".../app-bridge.js" data-api-key=...>` only — App Bridge boots, grabs a fresh `id_token` via the parent admin frame, and reloads the iframe back to the URL captured in the `shopify-reload` query param. The "bounce" is App-Bridge-driven; the server's only job is to render the script tag with the right reload target. The local implementation is at `src/lib/Shopify.ts:114-118` (`renderBouncePage`).

## Audit Of The Current Port

### Redundant: client-side `Authorization` attachment

`src/lib/ShopifyServerFnMiddleware.ts:17-41`:

```ts
const getSessionToken = async () => {
  const shopify = (globalThis as typeof globalThis & { readonly shopify?: ShopifyGlobal }).shopify;
  const token = shopify?.idToken ? await shopify.idToken() : undefined;
  if (!token) throw new TypeError("Missing Shopify App Bridge session token");
  return token;
};
…
export const shopifyServerFnMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const sessionToken = await getSessionToken();
    return next({ headers: { Authorization: `Bearer ${sessionToken}` } });
  })
  .server(/* … */);
```

This duplicates App Bridge's `fetch` patch. App Bridge sees the outgoing fetch to `/_serverFn/<id>` (same origin), and:

1. Calls `shopify.idToken()` itself.
2. Sets `Authorization: Bearer <token>` itself.
3. On a 401 with the retry header, re-mints and re-fetches itself.

The middleware's `client` arm runs `idToken()` *before* the fetch — App Bridge then runs it again on the actual `fetch` call. Two round-trips to the parent frame per server-fn invocation, where one suffices. Worse, removing the middleware doesn't lose the retry behavior — that's purely a function of the server returning 401 + the retry header, which `Shopify.authenticateAdmin` already does at `src/lib/Shopify.ts:403-413` and `:512`/`:556`.

Verification chain that App Bridge sees this fetch at all:

- `refs/tan-start/.../client-rpc/createClientRpc.ts:11-12`: `return serverFnFetcher(url, args, startFetch ?? fetch)` — bare `fetch` identifier; resolves to `globalThis.fetch` at call time, picking up any in-place patch.
- `refs/tan-start/.../client-rpc/serverFnFetcher.ts:60-110`: the resolved fetch is invoked exactly once per server-fn call with `(url, {method, headers, body, signal})`. No tricks (no `AbortController`-only tricks, no `XMLHttpRequest` fallback, no `navigator.sendBeacon`).
- `refs/tan-start/.../start-plugin-core/src/schema.ts:219-221`: `serverFns.base` defaults to `/_serverFn`. Same origin as the iframe document. App Bridge's same-origin allowlist catches it.

What removing the `client` arm requires at the call sites: nothing. The server arm is still needed (it runs `Shopify.authenticateAdmin`, returns admin/session into context). Removing only the client wrapper:

```ts
export const shopifyServerFnMiddleware = createMiddleware({ type: "function" })
  .server(async ({ next, context }) => {
    const auth = await context.runEffect(/* … same as today … */);
    if (auth instanceof Response) {
      const location = auth.headers.get("Location") ?? auth.headers.get("location");
      if (location) throw redirect({ href: location });
      throw new Error(`Shopify admin auth failed (${String(auth.status)})`);
    }
    return next({ context: { admin: auth, session: auth.session } });
  });
```

Server-fn POSTs continue to carry an `Authorization` header — just put there by App Bridge instead of the middleware.

Edge case to flag: SSR. During SSR, server fns are called in-process via `__executeServer`, not through HTTP fetch (see `refs/tan-start/.../createServerFn.ts:151-183`). There is no `Authorization` header on that path because there is no real fetch. The current code only runs `getSessionToken` on `client`, so it's already SSR-safe; removing it doesn't regress.

### Necessary: server-side strategy code

`src/lib/Shopify.ts` carries a substantial port of `@shopify/shopify-app-react-router/server`'s `authStrategyFactory` + `tokenExchange` strategy. The bulk of it cannot be eliminated by leaning on App Bridge — App Bridge is a client-side runtime and has no role in token decoding, token exchange with `accounts.shopify.com`, or session storage.

What's there and why it stays:

- `src/lib/Shopify.ts:446-572` `authenticateAdmin` — bot/options short-circuits, bounce/exit-iframe rendering, embedded redirect, JWT decode, token exchange. Mirrors `refs/shopify-app-js/.../admin/authenticate.ts:145-189`.
- `src/lib/Shopify.ts:403-428` `respondToInvalidSessionToken` — 401-with-retry vs. 302-to-bounce branching. Mirrors `refs/shopify-app-js/.../helpers/respond-to-invalid-session-token.ts`.
- `src/lib/Shopify.ts:337-389` `authenticateWebhook` — HMAC validation + offline session lookup. Mirrors `refs/shopify-app-js/.../authenticate/webhooks`.
- `src/lib/Shopify.ts:274-289` `unauthenticatedAdmin` — for background contexts (cron, queue consumers). Mirrors the template's `unauthenticated.admin(shop)`.

Why we can't drop in `@shopify/shopify-app-react-router/server`: it imports `react-router` for `boundary`, `redirect`, etc., and ties into React Router's loader/action lifecycle. Lifting the strategy without lifting the framework adapter is exactly what `Shopify.ts` is doing.

Smaller cleanup opportunities inside this region — covered as recommendations later — are:
- Align `respondToInvalidSessionToken` with the upstream's "no `authorization` header ⇒ document request, bounce; otherwise 401 + retry" predicate. Current code at `src/lib/Shopify.ts:407` correctly checks `request.headers.get("authorization")`, so this is matched.
- Confirm that the server-fn handler returns the 401 Response intact so App Bridge sees it. See next section.

### Necessary verification: thrown Responses must reach the wire intact

If the server fn handler throws a `Response` (e.g., the 401 with retry header), App Bridge's auto-retry only fires if that exact status + headers reach the iframe. TanStack Start's server handler does the right thing — `refs/tan-start/.../start-server-core/src/server-functions-handler.ts:174-180`:

```ts
if (unwrapped instanceof Response) {
  if (isRedirect(unwrapped)) {
    return unwrapped
  }
  unwrapped.headers.set(X_TSS_RAW_RESPONSE, 'true')
  return unwrapped
}
```

…and the same handler's `catch` arm at `:321-324`:

```ts
} catch (error: any) {
  if (error instanceof Response) {
    return error
  }
```

Both paths return the Response as-is (with one TSS-internal header added on the success path; `X-Shopify-Retry-Invalid-Session-Request` is preserved). So a `throw new Response(undefined, {status: 401, headers: {...}})` from anywhere in the server-fn middleware chain reaches the iframe fetch unmodified, App Bridge's patched `fetch` sees status 401 + the retry header, and the retry fires.

What this port does today: `ShopifyServerFnMiddleware.ts:51-56` only catches Responses and converts redirect locations into TanStack `redirect(...)`. For the 401-with-retry case, `auth instanceof Response` would still be true, no `Location` header, and it falls into:

```ts
throw new Error(`Shopify admin auth failed (${String(auth.status)})`);
```

That converts the 401 Response into an `Error`, which TanStack serializes as JSON (`server-functions-handler.ts:348-364`) — losing the 401 status and the retry header. **App Bridge will not retry this.** The client gets a thrown Error, and the user sees a generic failure.

This is a real bug exposed by the audit. Fix: re-throw non-redirect Responses from the middleware so they propagate to the wire. Concretely:

```ts
.server(async ({ next, context }) => {
  const auth = await context.runEffect(/* … */);
  if (auth instanceof Response) {
    const location = auth.headers.get("Location") ?? auth.headers.get("location");
    if (location) throw redirect({ href: location });
    throw auth; // <- preserve status + headers; TanStack will return it intact
  }
  return next({ context: { admin: auth, session: auth.session } });
});
```

The same lesson applies to any code path that calls `Shopify.authenticateAdmin` at a route boundary (e.g., `src/routes/app.tsx:81-90` does the same wrap-and-discard).

### Minor: `AppProvider` is essentially copy-pasted

`src/components/AppProvider.tsx:50-58` matches `refs/shopify-app-js/.../components/AppProvider/AppProvider.tsx:100-108` almost line-for-line. The only difference is `useNavigate` from TanStack Router instead of React Router. There is no win in deleting it (we can't import the React-Router-coupled package), and the JSDoc on the file already explains the trade-off. Leave it.

### Minor: raw `<s-app-nav>` vs. `<NavMenu>` from `@shopify/app-bridge-react`

`src/routes/app.tsx:35-42, 126-129` declares a local JSX module augmentation for `s-app-nav` (an App Bridge element, not Polaris) and renders the raw web component:

```ts
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

…

<s-app-nav>
  <s-link href={`/app${searchStr}`}>Home</s-link>
  <s-link href={`/app/additional${searchStr}`}>Additional page</s-link>
</s-app-nav>
```

`@shopify/app-bridge-react` already exports `NavMenu` for this exact element (`refs/shopify-bridge/packages/app-bridge-react/src/components/NavMenu.tsx:24-25`). Note the upstream uses the older `ui-nav-menu` element name; the JSX augmentation in `app.tsx` is for the newer `s-app-nav`. Pre-2026-01 templates use `<NavMenu>` over `<ui-nav-menu>`; the latest template (`refs/shopify-app-template/app/routes/app.tsx:20-23`) has switched to raw `<s-app-nav>`. This port matches the latest template — no action needed unless we want to follow the template's eventual migration to `<NavMenu>` once it lands.

The same pattern applies to `<SaveBar>`, `<TitleBar>`, `<Modal>`. None of these are in use yet; if/when added, prefer the React wrappers from `@shopify/app-bridge-react` for the typed `open`/`onShow`/`onHide` props (`refs/shopify-bridge/packages/app-bridge-react/src/components/SaveBar.tsx:21-37`).

## TanStack Server Fns + App Bridge

The mental model question the user raised: does using `createServerFn` instead of plain `fetch` defeat App Bridge?

Answer: no. The whole story:

1. `createServerFn(...).handler(...)` returns a callable that, on the client, ends up at `serverFnFetcher` (`refs/tan-start/.../client-rpc/serverFnFetcher.ts:46-110`).
2. `serverFnFetcher` does `fetchImpl(url, requestInit)` where `fetchImpl = first.fetch ?? handler` and `handler = startFetch ?? fetch` (`createClientRpc.ts:11-13`). With no `serverFns.fetch` configured in `createStart`, the chain resolves to bare `fetch`, i.e. `globalThis.fetch`.
3. App Bridge's CDN script replaces `window.fetch` (≡ `globalThis.fetch`) before any user code runs — it's loaded synchronously from `<script src=".../app-bridge.js" …>` at the top of the document (`src/components/AppProvider.tsx:24`). React hydration happens later.
4. Therefore every server-fn HTTP call from the iframe goes through the patched fetch, gets the auto-attached `Authorization`, and gets the auto-retry on 401.

There is no "use App Bridge instead of server fns" — they compose. Server fns provide type-safe RPC and middleware; App Bridge provides session-token plumbing on the wire. The client-side middleware in this port is the one piece that doubles up.

## Plain API Routes Alongside Server Fns

The user wants a path to write plain JSON endpoints when server-fn ergonomics aren't needed. TanStack Start already supports this — `src/routes/webhooks.app.uninstalled.ts:20-35` uses it for webhooks:

```ts
export const Route = createFileRoute("/webhooks/app/uninstalled")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) => runEffect(/* … */),
    },
  },
});
```

A Shopify-authenticated API route would look like:

```ts
// src/routes/app/api.products.create.ts
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { ProductRepository } from "@/lib/ProductRepository";
import { Shopify } from "@/lib/Shopify";

export const Route = createFileRoute("/app/api/products/create")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* CurrentRequest;
            const shopify = yield* Shopify;
            const auth = yield* shopify.authenticateAdmin(request);
            if (auth instanceof Response) return auth;
            const products = yield* ProductRepository;
            const color = ["Red", "Orange", "Yellow", "Green"][Math.floor(Math.random() * 4)];
            const product = yield* products.createProduct(`${color} Snowboard`);
            return Response.json({ product });
          }),
        ),
    },
  },
});
```

Client side, no middleware, no server-fn machinery:

```tsx
const res = await fetch("/app/api/products/create", { method: "POST" });
const { product } = await res.json();
```

App Bridge attaches `Authorization`, retries on 401 + retry header. The route returns either a JSON success body or whatever Response `Shopify.authenticateAdmin` produces (401 + retry, redirect to `/auth/login`, etc.). All of those propagate verbatim because the handler returns the Response directly — no wrapping layer to lose headers.

Trade-offs vs. server fns:

| Aspect | Server fn | Plain API route |
|---|---|---|
| End-to-end TS types | ✅ via `Awaited<ReturnType<…>>` | ❌ unless added manually (zod parse, etc.) |
| Client middleware (e.g., add headers) | ✅ via `.client()` | ❌ none, but App Bridge handles auth |
| Server middleware | ✅ via `.server()` | n/a — handler is the route |
| Serialization | seroval (Date, Map, etc.) | JSON only |
| URL is stable / shareable | ❌ generated `/_serverFn/<id>` | ✅ explicit `/app/api/...` |
| Easy to call from extensions / external | ❌ undocumented protocol | ✅ standard fetch + CORS |
| SSR call avoids HTTP | ✅ `__executeServer` | ❌ goes through fetch (or refactor) |

Recommendation: keep server fns for *typed* RPCs internal to the React app (the `generateProduct` mutation belongs here). Add plain API routes when:
- An admin UI extension needs to call back (`refs/shopify-docs/.../connect-app-backend.md:44-47` — they expect a stable URL plus `cors()`).
- Webhooks / app proxy / external integrations.
- You want the URL itself to be addressable for debugging or sharing.

## Concrete Recommendations

In rough priority order. Each is independent.

1. **Fix the silent 401 swallow.** `src/lib/ShopifyServerFnMiddleware.ts:51-56` and `src/routes/app.tsx:81-90` both convert non-redirect Responses to `Error`. That breaks App Bridge's auto-retry path because the 401 + retry header never reaches the wire. Change to `throw auth` so TanStack's server-fn handler returns the Response intact (verified by `server-functions-handler.ts:174-180` and `:321-324`). This is the single highest-impact fix in this audit — the rest of the bridge plumbing is already correct.

2. **Remove the client-side session-token middleware.** Drop the `.client(...)` arm of `shopifyServerFnMiddleware`. Document in a comment that App Bridge auto-attaches `Authorization` and auto-retries on the retry header. Rationale + citations live in this doc; in-code comment can be one line.

3. **Add one plain API route as a worked example.** Pick a real call site (e.g., move the `generateProduct` mutation to `src/routes/app/api.products.create.ts` and call via `fetch`). Validate end-to-end:
    - Headed Playwright: trigger generate, observe `Authorization: Bearer …` on the request in DevTools.
    - Force a stale token (e.g., wait past the 60-second lifetime, or mutate the JWT) and observe App Bridge re-fetching after the 401.
    - Confirm the retry happens transparently — no client-side handling needed.

   This either confirms the auto-fetch story end-to-end or surfaces the gotcha. Either way, the app gains a reference implementation for "plain API route under `/app/api/...`".

4. **Audit the rest of `src/routes/app/**` for the same Response-unwrap bug.** Anywhere `await x()` is followed by `x instanceof Response` + Error throw, replace with re-throw. Quick grep: any `instanceof Response` inside a `.handler(...)` body in `src/lib` or `src/routes` deserves a pass.

5. **Skip: replacing local `AppProvider` or `<s-app-nav>` augmentation.** No win — the local AppProvider is a 30-line React-Router-free port that already exists; the `<s-app-nav>` augmentation matches the upstream template. Revisit if the upstream template adopts `<NavMenu>` from `@shopify/app-bridge-react`.

6. **Skip: replacing `Shopify.authenticateAdmin` with a library call.** `@shopify/shopify-app-react-router` is React-Router-coupled. The strategy port in `src/lib/Shopify.ts` is the trade-off this project consciously made; see also `docs/shopify-session-lifetime-research.md`.

## Open Questions / Verify Before Acting

- App Bridge's auto-retry: how many times? On the first 401 the retry happens; on a second 401 with retry header, does it bail or loop? The Shopify docs and SDK don't answer this directly. Behavioral test (item 3 above) should observe the headed network log; if a stale-token scenario can be forced twice in a row, watch what App Bridge does.
- App Bridge's same-origin scope: the `appOrigins` config is documented but the *exact* default-allowed set isn't. Empirically: same-origin works (the template depends on it). If we ever route server fns through a non-same-origin URL (e.g., a Worker on a different domain), we'd need to set `appOrigins` on the `<script>` config — and `src/components/AppProvider.tsx:24` would need to switch from `data-api-key` to a `<script>` body that calls `createApp({apiKey, appOrigins})`. Not a current need.
- Whether `disabledFeatures: ['fetch']` is ever desirable here. If an external library wants to call a non-Shopify backend from the iframe and we don't want App Bridge wrapping its fetches, that's the lever. No current consumer of that.
