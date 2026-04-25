# Shopify App Template Parity: Deep Dive And Port Plan

Question: is `tanstack-cloudflare-effect-shopify-app` actually at parity with `refs/shopify-app-template`, and if not, what is missing and how do we close each gap the effect v4 / TanStack Start way?

Short answer: the port is at parity on the **default session storage shape** (one offline row per shop, upsert by id, delete by shop on uninstall), but it is **not at parity** on the live auth lifecycle that surrounds that storage. Eight concrete behaviors the template provides are absent in the port today. This doc enumerates each gap with excerpts from both sides and proposes a concrete port plan.

## Scope: What "parity" means here

The port target is the template's actual default configuration, not the whole `@shopify/shopify-app-react-router` feature surface. That default is:

- [refs/shopify-app-template/app/shopify.server.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/shopify.server.ts#L10-L25):
  - `distribution: AppDistribution.AppStore`
  - `future: { expiringOfflineAccessTokens: true }`
  - `useOnlineTokens`: not set → default `false` in [refs/shopify-app-js/.../shopify-app.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/shopify-app.ts#L198)
  - `sessionStorage: new PrismaSessionStorage(prisma)`

Non-goals, explicitly out of scope for this parity pass:

- persisting online sessions (template does not do this by default)
- `ShopifyAdmin` / merchant-custom distribution (template uses `AppStore`)
- billing, fulfillment-service, POS, flow, public auth strategies
- the `scopes` client API (`authenticate.admin(...).scopes`)
- periodic cleanup jobs (not needed under template semantics)

## Status

- [x] **Step 1** — `expiring: true` forwarded to `tokenExchange` ([src/lib/Shopify.ts:374](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L374))
- [x] **Step 2** — `refreshOfflineToken` + `ensureValidOfflineSession` added ([src/lib/Shopify.ts:218-237](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L218-L237))
- [x] **Step 3** — `authenticateWebhook` added ([src/lib/Shopify.ts:274-304](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L274-L304)); `validateWebhook` removed; both webhook routes migrated; return shape expanded to include `apiVersion`, `webhookType`, `triggeredAt`, `eventId` (see [docs/shopify-authenticate-webhook-explainer.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/docs/shopify-authenticate-webhook-explainer.md))
- [x] **Step 5** — 401 invalidation on admin GraphQL ([src/lib/Shopify.ts:179-221](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L179-L221)); `buildAdminContext` moved inside service closure
- [x] **Step 6** — structured invalid-session-token recovery ([src/lib/Shopify.ts:341-381](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L341-L381)); `respondToInvalidSessionToken` helper + `InvalidJwtError` / `invalid_subject_token` handling in `decodeSessionToken` and `tokenExchange`; middleware redirect-throws Location-bearing Responses
- [x] **Step 4** — `unauthenticatedAdmin(shop)` ([src/lib/Shopify.ts:262-289](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L262-L289))
- [x] **Infra** — `[[webhooks.subscriptions]]` blocks added to both shopify.app tomls
- [ ] Step 7 — error boundary headers (optional)

## Verified gaps

Each gap below is verified by reading both the template implementation and the current port.

### G1. `expiring` flag is not forwarded to token exchange — FIXED (Step 1)

Template passes the future flag straight through:

```ts
// refs/shopify-app-js/.../authenticate/admin/strategies/token-exchange.ts:49-54
return await api.auth.tokenExchange({
  sessionToken,
  shop,
  requestedTokenType,
  expiring: config.future.expiringOfflineAccessTokens,
});
```

And the underlying `tokenExchange` sends `expiring: '1'` when true, which is the gate for getting back a `refresh_token` + `refresh_token_expires_in`:

```ts
// refs/shopify-app-js/.../lib/auth/oauth/token-exchange.ts:41-49
const body = {
  client_id: config.apiKey,
  ...
  requested_token_type: requestedTokenType,
  expiring: expiring ? '1' : '0',
};
```

Shopify docs:

> "`expiring` — `0` (default) for requesting a non-expiring offline token; `1` for requesting an expiring offline token"
> — [refs/shopify-docs/.../access-tokens/offline-access-tokens.md:62-63](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md#L62-L63)

Port now forwards it ([src/lib/Shopify.ts:369-376](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L369-L376)):

```ts
const { session } = yield* tryShopifyPromise(() =>
  shopify.auth.tokenExchange({
    shop: sessionShop,
    sessionToken,
    requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
    expiring: true,
  }),
);
```

Before the fix: token exchange defaulted `expiring` to `'0'`, the server never returned `refresh_token` / `refresh_token_expires_in`, and the DB columns `refreshToken` / `refreshTokenExpires` were always stored as `null` — so the "refresh in place" lifecycle the template relies on was structurally impossible.

After the fix: the persistence path in `storeSession` ([src/lib/Shopify.ts:182-183](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L182-L183)) now receives real `refreshToken` / `refreshTokenExpires` values for each new exchange. Existing non-expiring rows are migrated transparently on the next `authenticateAdmin` fall-through per [shopify-docs/.../offline-access-tokens.md:226-232](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md#L226-L232). Refresh itself is still not wired — Step 2 turns the stored refresh metadata into actual refresh behavior.

### G2. No offline refresh helper for stale sessions — FIXED (Step 2)

Template chain for "give me a usable offline session for this shop, refreshing if needed":

```ts
// refs/shopify-app-js/.../helpers/ensure-valid-offline-session.ts:6-15
export async function ensureValidOfflineSession(params, shop) {
  const session = await createOrLoadOfflineSession(params, shop);
  if (!session) return undefined;
  return ensureOfflineTokenIsNotExpired(session, params, shop);
}
```

```ts
// refs/shopify-app-js/.../helpers/ensure-offline-token-is-not-expired.ts:10-31
if (
  config.future?.expiringOfflineAccessTokens &&
  session.isExpired(WITHIN_MILLISECONDS_OF_EXPIRY) &&
  config.distribution !== AppDistribution.ShopifyAdmin &&
  session.refreshToken
) {
  const offlineSession = await refreshToken(params, shop, session.refreshToken);
  await config.sessionStorage!.storeSession(offlineSession);
  return offlineSession;
}
return session;
```

```ts
// refs/shopify-app-js/.../helpers/refresh-token.ts:15-20
const {session} = await api.auth.refreshToken({
  shop,
  refreshToken,
});
return session;
```

Port now has both helpers on the `Shopify` service ([src/lib/Shopify.ts:218-237](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L218-L237)):

```ts
const refreshOfflineToken = Effect.fn("Shopify.refreshOfflineToken")(
  function* (shop: Domain.Shop, refreshToken: string) {
    const { session } = yield* tryShopifyPromise(() =>
      shopify.auth.refreshToken({ shop, refreshToken }),
    );
    yield* storeSession(session);
    return session;
  },
);
const ensureValidOfflineSession = Effect.fn("Shopify.ensureValidOfflineSession")(
  function* (shop: Domain.Shop) {
    const loaded = yield* loadSession(yield* offlineSessionId(shop));
    if (Option.isNone(loaded)) return Option.none();
    const session = loaded.value;
    return session.isExpired(WITHIN_MILLISECONDS_OF_EXPIRY) && session.refreshToken
      ? Option.some(yield* refreshOfflineToken(shop, session.refreshToken))
      : Option.some(session);
  },
);
```

Returns `Option<Session>` — idiomatic effect v4, consistent with `loadSession`. Refresh-and-store is wrapped in a single helper because template callers always pair them ([ensure-offline-token-is-not-expired.ts:22-28](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts#L22-L28)).

Note: `authenticateAdmin` is unchanged by design. The template's admin strategy falls through to `tokenExchange` (not refresh) when the stored session is inactive, since a fresh browser session token is always available in that path. Refresh is reserved for webhook / background contexts where there is no session token — which is exactly where Step 3 and Step 4 will plug `ensureValidOfflineSession` in.

### G3. No `authenticate.webhook(request)` equivalent — FIXED (Step 3)

Template contract:

```ts
// refs/shopify-app-js/.../authenticate/webhooks/authenticate.ts:35-52
const check = await api.webhooks.validate({ rawBody, rawRequest: request });
if (!check.valid) { /* 401 or 400 */ }
const session = await ensureValidOfflineSession(params, check.domain);
```

Usage in template routes:

```ts
// refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:6
const { shop, session, topic } = await authenticate.webhook(request);
// refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:6
const { payload, session, topic, shop } = await authenticate.webhook(request);
```

Port now has the helper and both webhook routes were migrated:

```ts
// src/lib/Shopify.ts:274-304
const authenticateWebhook = Effect.fn("Shopify.authenticateWebhook")(
  function* (request: Request) {
    if (request.method !== "POST") return new Response(undefined, { status: 405 });
    const rawBody = yield* tryShopifyPromise(() => request.text());
    const check = yield* tryShopifyPromise(() =>
      shopify.webhooks.validate({ rawBody, rawRequest: request }),
    );
    if (!check.valid) {
      return new Response(undefined, {
        status: check.reason === ShopifyApi.WebhookValidationErrorReason.InvalidHmac ? 401 : 400,
      });
    }
    const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(check.domain);
    const session = Option.getOrUndefined(yield* ensureValidOfflineSession(shop));
    return {
      shop,
      topic: check.topic,
      payload: JSON.parse(rawBody) as unknown,
      session,
      admin: session ? buildAdminContext(shopify, session) : undefined,
    } as const;
  },
);
```

The old `validateWebhook` was deleted — every caller is now on `authenticateWebhook`. The webhook routes collapsed to their essential body:

```ts
// src/routes/webhooks.app.uninstalled.ts
const result = yield* shopify.authenticateWebhook(request);
if (result instanceof Response) return result;
yield* shopify.deleteSessionsByShop(result.shop);
return new Response();
```

```ts
// src/routes/webhooks.app.scopes_update.ts
const result = yield* shopify.authenticateWebhook(request);
if (result instanceof Response) return result;
const payload = yield* Schema.decodeUnknownEffect(ScopesUpdatePayload)(result.payload);
if (result.session) {
  yield* shopify.updateSessionScope({
    id: yield* Schema.decodeUnknownEffect(Domain.SessionId)(result.session.id),
    scope: payload.current.toString(),
  });
}
return new Response();
```

The scopes_update route now guards on `result.session` to match the template's `if (session) { ... }` semantics ([refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:10-19](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx#L10-L19)) — no-op when the session doesn't exist instead of issuing a no-op UPDATE. Session id is decoded to `Domain.SessionId` for branded-type safety.

What parity with the template now covers:

- refreshed offline session available to webhook handlers (via `ensureValidOfflineSession`)
- admin GraphQL client available via `result.admin` (pending Step 5 for 401 invalidation)
- no per-route duplication of body parse / shop decode / session id derivation
- 405 / 401 / 400 distinguished at the helper boundary

### G4. No `unauthenticated.admin(shop)` equivalent — FIXED (Step 4)

Template:

```ts
// refs/shopify-app-js/.../unauthenticated/admin/factory.ts:9-22
const session = await ensureValidOfflineSession(params, shop);
if (!session) throw new SessionNotFoundError(...);
return { session, admin: adminClientFactory({params, session}) };
```

This is how background jobs, crons, and non-request flows get an authenticated admin client for a given shop. The port has no equivalent. Today, any background work would have to re-implement the load-or-refresh logic inline — and since G1/G2 block refresh, it cannot work correctly in any realistic multi-day-old row.

### G5. Admin GraphQL client has no 401 invalidation hook — FIXED (Step 5)

Template wraps every GraphQL call with `handleClientError`, and on 401 invalidates the stored access token:

```ts
// refs/shopify-app-js/.../authenticate/admin/strategies/token-exchange.ts:154-171
function handleClientError(request: Request): HandleAdminClientError {
  return handleClientErrorFactory({
    request,
    onError: async ({session, error}: OnErrorOptions) => {
      if (error.response.code === 401) {
        await invalidateAccessToken({config, api, logger}, session);
        respondToInvalidSessionToken({ params: {config, api, logger}, request });
      }
    },
  });
}
```

```ts
// refs/shopify-app-js/.../authenticate/helpers/invalidate-access-token.ts:13-16
session.accessToken = undefined;
await config.sessionStorage!.storeSession(session);
```

Port now installs an equivalent hook inside `buildAdminContext` ([src/lib/Shopify.ts:179-221](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L179-L221)):

```ts
Effect.tapError((cause) =>
  cause instanceof ShopifyApi.HttpResponseError && cause.response.code === 401
    ? Effect.gen(function* () {
        session.accessToken = undefined;
        yield* Effect.ignore(storeSession(session));
      })
    : Effect.void,
),
```

`buildAdminContext` was also relocated from module scope into the service closure so it can read `storeSession` from the same lexical frame. The three call sites (two in `authenticateAdmin`, one in `authenticateWebhook`) dropped the `shopify` argument accordingly.

Behavior: on 401 the stored `accessToken` is cleared best-effort (store failures are ignored so the original 401 still propagates). The current request still fails — the 401 is not rescued — but the next `authenticateAdmin` browser request now sees `isActive() === false` and falls through to token exchange with the fresh session token. Matches the template's `handleClientError` → `invalidateAccessToken` pattern ([token-exchange.ts:154-171](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts#L154-L171)).

Webhook handlers get this automatically via `result.admin` from `authenticateWebhook` since both paths go through the same `buildAdminContext`.

### G6. Invalid session token → structured bounce / 401 recovery is missing — FIXED (Step 6)

Template: on decode failure, document requests bounce through `/auth/session-token`; XHR/fetch requests get a typed 401 with a retry header that App Bridge understands:

```ts
// refs/shopify-app-js/.../authenticate/helpers/validate-session-token.ts:33-39
} catch (error) {
  logger.debug(`Failed to validate session token: ${error.message}`, {shop});
  throw respondToInvalidSessionToken({params, request, retryRequest});
}
```

```ts
// refs/shopify-app-js/.../authenticate/helpers/respond-to-invalid-session-token.ts:18-27
const isDocumentRequest = !request.headers.get('authorization');
if (isDocumentRequest) {
  return redirectToBouncePage({api, logger, config}, new URL(request.url));
}
throw new Response(undefined, {
  status: 401,
  statusText: 'Unauthorized',
  headers: retryRequest ? RETRY_INVALID_SESSION_HEADER : {},
});
```

The retry header is `X-Shopify-Retry-Invalid-Session-Request: 1`, and it pairs with `X-Shopify-API-Request-Failure-Reauthorize-Url` for App Bridge recovery — both defined in [refs/shopify-app-js/.../authenticate/const.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/const.ts).

Port: `shopify.session.decodeSessionToken(sessionToken)` is wrapped in generic try/catch and produces a `ShopifyError` with no recovery semantics:

```ts
// src/lib/Shopify.ts:351-353
const payload = yield* tryShopifyPromise(() =>
  shopify.session.decodeSessionToken(sessionToken),
);
```

And the server-fn middleware maps any `Response` — including ones that could be bounces — into an opaque thrown Error:

```ts
// src/lib/ShopifyServerFnMiddleware.ts:49-56
if (auth instanceof Response) {
  const location = auth.headers.get("Location") ?? auth.headers.get("location");
  throw new Error(
    location
      ? `Shopify admin auth redirect required: ${location}`
      : `Shopify admin auth failed (${String(auth.status)})`,
  );
}
```

Consequence: an expired browser session token (one-minute lifetime per [shopify-docs/.../session-tokens.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md)) surfaces to the user as an error toast instead of an auto-retry.

### G7. `invalid_subject_token` + `InvalidJwtError` from token exchange are not recognized — FIXED (Step 6)

Template distinguishes a token exchange failure caused by a bad session token from a general server error, and retries the session-token bounce:

```ts
// refs/shopify-app-js/.../authenticate/admin/strategies/token-exchange.ts:55-73
} catch (error) {
  if (
    error instanceof InvalidJwtError ||
    (error instanceof HttpResponseError &&
      error.response.code === 400 &&
      error.response.body?.error === 'invalid_subject_token')
  ) {
    throw respondToInvalidSessionToken({
      params: {api, config, logger},
      request,
      retryRequest: true,
    });
  }
  throw new Response(undefined, { status: 500, statusText: 'Internal Server Error' });
}
```

Port: the token exchange call is wrapped in generic `tryShopifyPromise` with no error-shape inspection ([src/lib/Shopify.ts:369-375](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L369-L375)). `InvalidJwtError` and `invalid_subject_token` HTTP 400 responses both collapse into a generic `ShopifyError`.

### G8. Error boundary headers (`boundary.error`, `boundary.headers`) have no port analog

Template requires app routes to wire `boundary.error` / `boundary.headers` so CSP + Reauthorize-Url headers survive into error responses:

```ts
// refs/shopify-app-template/app/routes/app.tsx:29-36
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
```

The port does not wire anything equivalent. Its current `withShopifyDocumentHeaders` ([src/lib/Shopify.ts:230-253](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L230-L253)) applies headers at the worker level for every text/html response, which partially compensates, but it does not carry `X-Shopify-API-Request-Failure-Reauthorize-Url` into error responses from server functions.

### Summary of gaps

| Gap | Template location | Port state |
| --- | --- | --- |
| G1 | `token-exchange.ts:49-54` passes `expiring: true` | ✅ fixed in `Shopify.ts:374` |
| G2 | `ensureValidOfflineSession`, `ensureOfflineTokenIsNotExpired`, `refreshToken` | ✅ fixed in `Shopify.ts:218-237` |
| G3 | `authenticateWebhookFactory` returns `{payload, shop, topic, session, admin}` | ✅ fixed in `Shopify.ts:274-304`; both webhook routes migrated |
| G4 | `unauthenticatedAdminContextFactory(shop)` | ✅ fixed in `Shopify.ts:262-289` |
| G5 | `handleClientError` clears `session.accessToken` on 401 | ✅ fixed in `Shopify.ts:179-221` |
| G6 | `respondToInvalidSessionToken` bounce vs 401 + retry header | ✅ fixed in `Shopify.ts:341-381` |
| G7 | `InvalidJwtError` / `invalid_subject_token` triggers bounce retry | ✅ fixed in `Shopify.ts` (decode + tokenExchange call sites) |
| G8 | `boundary.error` + `boundary.headers` | not ported |

## What is already at parity

For completeness, these are confirmed aligned:

- one offline session row per shop, keyed by `api.session.getOfflineId(shop)`; upsert by id — [src/lib/Shopify.ts:357-376](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L357-L376) vs [authenticate.ts:216-218](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts#L216-L218)
- no online sessions persisted by default — `useOnlineTokens` not read in port, not set in template
- bounce page renders `<script data-api-key src=app-bridge.js>` — [src/lib/Shopify.ts:114-118](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L114-L118) vs [render-app-bridge.ts:40-46](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/render-app-bridge.ts#L40-L46)
- embedded gate + bounce to `/auth/session-token` when `id_token` missing — [src/lib/Shopify.ts:319-344](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L319-L344) vs [ensure-session-token-search-param-if-required.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/ensure-session-token-search-param-if-required.ts) + [redirect-to-bounce-page.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/redirect-to-bounce-page.ts)
- `app/uninstalled` deletes all rows by shop — [src/routes/webhooks.app.uninstalled.ts:37](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/webhooks.app.uninstalled.ts#L37) (unconditional, single query — simplification of the template's conditional delete, which is acceptable)
- `app/scopes_update` updates stored scope — [src/routes/webhooks.app.scopes_update.ts:28-33](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/webhooks.app.scopes_update.ts#L28-L33)
- document response CSP / preconnect headers applied at worker boundary — [src/lib/Shopify.ts:95-104](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L95-L104)

## Effect v4 / TanStack idioms to use

Before sketching the port plan, confirm the idioms that should shape each helper.

### Service + `Effect.fn` with named spans

Per [refs/effect4/ai-docs/src/01_effect/01_basics/02_effect-fn.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/ai-docs/src/01_effect/01_basics/02_effect-fn.ts), helpers should use `Effect.fn("Name")(function* (...) { ... })`, which double-dips as a name and a tracing span. The existing `Shopify` service uses this pattern — new methods must match.

### Tagged errors for failure channel

Per [refs/effect4/ai-docs/src/01_effect/02_services/01_service.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/ai-docs/src/01_effect/02_services/01_service.ts), errors should be `Schema.TaggedErrorClass`. The port already has `ShopifyError`. For parity recovery behavior (G6/G7), add a second tag so callers can `Effect.catchTag` the recoverable cases:

```ts
// sketch
export class ShopifyInvalidSessionTokenError extends Schema.TaggedErrorClass<ShopifyInvalidSessionTokenError>()(
  "ShopifyInvalidSessionTokenError",
  { retryRequest: Schema.Boolean },
) {}
```

Why a dedicated tag: the template threads recovery by throwing a specific `Response`. In effect v4, `Response` objects flow through the success channel (they are valid return values), so the recovery signal belongs in the **error** channel where `catchTag` can fan it out at the route boundary — one place to convert the tag into either a `Response` (server route) or a `redirect(...)` throw (TanStack `beforeLoad`).

### Layer composition and per-request runtime

Per [refs/effect4/ai-docs/src/01_effect/02_services/20_layer-composition.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/ai-docs/src/01_effect/02_services/20_layer-composition.ts) and the current [src/worker.ts:13-33](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/worker.ts#L13-L33), the port already builds services per request via `ManagedRuntime`. New helpers belong inside the existing `Shopify` service (or a new `ShopifyAuth` service that depends on `Shopify`) so they share the same per-request `Ref` / config.

### TanStack Start redirect discipline

Per [refs/tan-start/.../server-functions.md:218-234](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/tan-start/docs/start/framework/react/guide/server-functions.md), the canonical way to bounce a server function is `throw redirect({ to, href })` from `@tanstack/react-router`. The port's worker already bridges this correctly ([src/worker.ts:80-90](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/worker.ts#L80-L90)): `redirect`/`notFound` placed in `Effect.die` / the defect channel are re-thrown as-is.

So: recovery-producing Effects should `Effect.die(redirect(...))` (or fail a tag the route converts into a thrown `redirect`). Server routes should still return `Response`.

### `createMiddleware` split for server fn vs server route

Per [refs/tan-start/.../middleware.md:190-269](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/tan-start/docs/start/framework/react/guide/middleware.md):

- server functions use `createMiddleware({ type: "function" })` with `.client` + `.server` (port already has `shopifyServerFnMiddleware`)
- server routes use `createMiddleware()` with `.server` and are attached via `server.middleware` on the file route

The webhook helper (G3) should be both: a webhook **request middleware** to run validation + offline session load, plus a context extension that hands `{ payload, shop, topic, session, admin }` to the route handler.

## Port plan

Ordered by blast radius. Each step is independently shippable and testable.

### Step 1. Wire `expiring: true` (unblocks G2–G5) — DONE

Landed at [src/lib/Shopify.ts:369-376](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L369-L376):

```ts
shopify.auth.tokenExchange({
  shop: sessionShop,
  sessionToken,
  requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
  expiring: true,
})
```

Parity note: the template reads the flag via `config.future.expiringOfflineAccessTokens`. The port does not expose a `future` config object. Hardcoded `expiring: true` for template-default parity. If the app ever needs to toggle it, add a single config const in `Shopify.ts` and read from it — no need to replicate the full future-flag machinery.

Verification: `pnpm typecheck` and `pnpm lint` clean. Effect at runtime: new token exchanges now return `refresh_token` + `refresh_token_expires_in`, which the existing `storeSession` already persists ([src/lib/Shopify.ts:182-183](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L182-L183)). Until Step 2 lands, those values are stored but unused on read.

### Step 2. Add `ensureValidOfflineSession(shop)` (closes G2) — DONE

Landed at [src/lib/Shopify.ts:218-237](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L218-L237). Both `refreshOfflineToken` and `ensureValidOfflineSession` are exposed on the `Shopify` service. No callers yet — Step 3 (`authenticateWebhook`) and Step 4 (`unauthenticatedAdmin`) will consume them.

Migration behavior: with Step 1 done, existing non-expiring rows get migrated transparently the next time `authenticateAdmin` falls through to `tokenExchange` — per Shopify docs: "The migration can be done via a background job or during the next app launch. The original non-expiring token will be revoked upon successful exchange." ([offline-access-tokens.md:226-232](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md#L226-L232)). Until they migrate, `ensureValidOfflineSession` on a non-expiring row returns the row unchanged (no refresh path because `refreshToken` is null on pre-Step-1 rows) — correct behavior, since non-expiring tokens do not need refresh.

Verification: `pnpm typecheck` and `pnpm lint` clean.

### Step 3. Add `authenticateWebhook` (closes G3) — DONE

Landed at [src/lib/Shopify.ts:274-304](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L274-L304). `validateWebhook` was removed — it had exactly two callers, both of which now use `authenticateWebhook`. Both webhook routes collapsed to their essential bodies (see the G3 excerpts above).

Minor deviations from the sketch:

- omitted `apiVersion`, `webhookId`, `subTopic` from the return shape — current callers don't use them; add if a future route needs them (YAGNI)
- scopes_update decodes `result.session.id` through `Domain.SessionId` to enforce the branded-type invariant end-to-end rather than re-deriving the id from the shop

Verification: `pnpm typecheck` and `pnpm lint` clean. The minimum viable webhook contract (shop + topic + payload + optional session/admin) is now identical to the template.

### Step 4. Add `unauthenticatedAdmin(shop)` (closes G4) — DONE

Landed at [src/lib/Shopify.ts:262-289](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L262-L289). Thin wrapper over `ensureValidOfflineSession` + `buildAdminContext`: on `Option.None` (no stored offline row for the shop), fails with `ShopifyError`. On `Option.Some`, returns a `ShopifyAdminContext` with the 401-invalidation behavior already attached via Step 5.

No callers yet — this is a capability hook for scheduled tasks, durable object workflows, and queue consumers. Verification: `pnpm typecheck` and `pnpm lint` clean.

### Step 5. 401 invalidation on admin GraphQL (closes G5) — DONE

Landed at [src/lib/Shopify.ts:179-221](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L179-L221). `buildAdminContext` moved from module scope into the service closure to gain access to `storeSession`; its signature dropped the `shopify` parameter (now closed over).

Diverged from the original sketch in two places:

- used `Effect.tapError` + `Effect.ignore` instead of `Effect.catchIf` + a new `ShopifyInvalidSessionTokenError`. Rationale: Step 5's job is purely the invalidation-and-store side effect. Introducing a new error tag and recovery-flow semantics is Step 6's job. `tapError` cleanly runs the side effect and re-raises the original error, which then gets mapped to `ShopifyError` for the caller. When Step 6 lands, the error tag can be introduced as a separate mapped output.
- swallowed store failures with `Effect.ignore` so the original 401 always propagates — matches the template's "invalidate best-effort, always throw the upstream error" pattern ([invalidate-access-token.ts:5-16](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/invalidate-access-token.ts#L5-L16)).

Verification: `pnpm typecheck` and `pnpm lint` clean.

### Step 6. Structured invalid-session-token recovery (closes G6 + G7) — DONE

Landed across three spots:

1. `respondToInvalidSessionToken` helper added at [src/lib/Shopify.ts:341-381](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L341-L381). Pure function, closes over `config.appUrl`. Produces a 302 to `/auth/session-token` for document requests (with the `shopify-reload` param App Bridge expects), or a 401 with `X-Shopify-Retry-Invalid-Session-Request` for XHR requests.
2. `decodeSessionToken` and `tokenExchange` calls in `authenticateAdmin` now `Effect.catchIf` on `InvalidJwtError` (both) and `HttpResponseError` with `response.body.error === "invalid_subject_token"` (tokenExchange only). The catch branch lifts a `Response` into the success channel; the caller does `if (result instanceof Response) return result` before unwrapping.
3. `ShopifyServerFnMiddleware` now throws `redirect({ href: location })` on Location-bearing Responses instead of a generic Error. Matches the template's control flow: document requests bounce through `/auth/session-token`, and TanStack's router handles the 302.

Diverged from the sketch:

- used `Effect.catchIf` + `Effect.succeed(...)` instead of a custom `ShopifyInvalidSessionTokenError` tag. Rationale: the recovery Response is a legitimate success-channel value (like other Response-returning branches in `authenticateAdmin`). A custom error tag would have added ceremony without changing behavior — the route boundary already handles the Response branch.
- for 401 Responses without Location in the middleware, kept the `throw new Error(...)` path rather than `throw auth`. Throwing a raw `Response` through TanStack's server fn machinery is not documented to preserve status/headers, and the current `generateProduct` caller reads `.message` off the error. Preserving the error path keeps the client-side error surface unchanged; a future "App Bridge retry on 401" pass can introduce a typed error if needed.

Verification: `pnpm typecheck`, `pnpm lint`, and `pnpm test` all clean.

### Step 7. Error boundary headers (closes G8, optional)

The port already applies document headers at the worker boundary via `withShopifyDocumentHeaders` ([src/worker.ts:141-148](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/worker.ts#L141-L148)), which covers the parity surface for successful responses. The remaining delta is `X-Shopify-API-Request-Failure-Reauthorize-Url` on error responses — needed if the app ever uses server-side billing redirects or reauthorization, not strictly required for template-default auth.

Recommended: skip initially, revisit if App Bridge starts surfacing stale token errors that should trigger reauthorize-url recovery.

## Non-parity items (explicitly skip)

These are template features worth naming so they don't creep into the port by accident:

- **Online sessions**: requires a second `tokenExchange` call with `OnlineAccessToken` and storing a separate row with `isOnline=1`, `userId`, `onlineAccessInfo`. Template does not do this by default; port should not either.
- **`afterAuth` hook**: [trigger-after-auth-hook.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/helpers/trigger-after-auth-hook.ts) runs on newly-exchanged sessions. The template does not configure one. Add only when actually needed.
- **`IdempotentPromiseHandler`**: prevents multiple concurrent `afterAuth` calls in a single request. Only relevant if Step 7a (afterAuth) is adopted.
- **`scopes` API**: `authenticate.admin(...).scopes.query/request`. Used only for mid-session scope upgrades.
- **Billing / flow / POS / fulfillment-service**: out of scope for session parity.

## Sequencing and shipping

Minimum viable parity:

1. ~~**Step 1** (one-line `expiring: true`) — ships on its own, immediately unblocks refresh~~ ✅
2. ~~**Step 2** (`ensureValidOfflineSession`) — private helper; no public API impact yet~~ ✅
3. ~~**Step 3** (`authenticateWebhook`) — swap the two webhook routes to use it; measurable line-count reduction~~ ✅
4. ~~**Step 5** (401 invalidation) — small, isolated to `buildAdminContext`~~ ✅
5. ~~**Step 6** (structured recovery + middleware redirect) — user-visible improvement for expired browser session tokens~~ ✅
6. ~~**Step 4** (`unauthenticatedAdmin`) — only when the first background/cron consumer needs it~~ ✅
7. **Step 7** (boundary headers) — defer unless reauthorize UX regresses

Steps 1–6 together restore real template parity for the session lifetime model. After Step 1, the schema in [migrations/0001_init.sql](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/migrations/0001_init.sql) is actually used as designed: `refreshToken`/`refreshTokenExpires` columns stop being permanently null for freshly-exchanged sessions.

## Bottom line

The prior research was correct in substance: the port matches the template on **storage shape** but diverges on the **live auth lifecycle** in exactly the places where expiring-offline-token support needs to live. The port today does not refresh, does not invalidate on 401, does not recover from expired browser session tokens, and offers only raw HMAC for webhooks. Closing those gaps is a ~6-step change, each small and independently shippable, all inside `src/lib/Shopify.ts` plus narrow edits to `ShopifyServerFnMiddleware.ts` and the two webhook routes.
