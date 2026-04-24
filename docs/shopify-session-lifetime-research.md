# Shopify Session Lifetime And Port Parity Research

Question: for the `Session` table in [migrations/0001_init.sql](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/migrations/0001_init.sql), what is the real session lifetime model, what does `refs/shopify-app-template` actually do, how does this port differ, and what needs to be ported to achieve parity?

## Executive Summary

- The official Shopify template does not store online sessions by default.
- The template default is one offline session row per installed shop because `useOnlineTokens` defaults to `false` in the underlying library and the template does not override it.
- The template does opt into expiring offline tokens with `future: { expiringOfflineAccessTokens: true }`, so that offline row can carry `refreshToken` metadata and be refreshed in place.
- This port already matches the template's default row cardinality: one offline row per shop, upserted by stable offline session id, deleted on uninstall.
- The main parity gap is not online-session storage. The main gaps are expiring-offline-token support, offline refresh for webhook/background contexts, invalid session token retry behavior, and 401 invalidation behavior.
- Cleanup semantics flow from that: for template-default parity, keep the offline row for the life of the installation and delete by shop on `app/uninstalled`. No periodic cleanup is required for correctness.

## What Shopify Means By "Session"

The first source of confusion is that Shopify uses the word "session" for two different things.

`session token`
: short-lived App Bridge JWT sent from the browser to the app backend.

persisted `Session`
: server-side OAuth/access-token state stored in the app database.

Shopify's session-token docs say:

> "The lifetime of a session token is one minute."

> "Unlike API access tokens, session tokens can't be used to make authenticated requests to Shopify APIs."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md`

So the `Session` table is not storing one-minute browser session tokens. It stores Shopify API access-token state.

## What Shopify Says About Token Lifetime

### Offline access tokens

Shopify's offline-token docs say:

> "Offline is the default access mode when none is specified."

> "Tokens with offline access mode are meant for service-to-service requests where no user interaction is involved."

For non-expiring offline tokens:

> "No expiration: Tokens remain valid indefinitely until app is uninstalled or secret revocation."

For expiring offline tokens:

> "90-day refresh token lifetime"

> "Token refresh: Apps can refresh expired tokens without merchant intervention."

> "Only one expiring offline token can be active per app/shop combination"

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md`

Implication: the default durable installation credential is offline and shop-level. Even when offline tokens are expiring, the row should normally be refreshed in place, not churned or aggressively deleted.

### Online access tokens

Shopify's online-token docs say:

> "Tokens with online access mode are linked to an individual user on a store, where the access token's lifespan matches the lifespan of the user's web session."

> "Tokens with online access mode expire either when the user logs out or after 24 hours."

> "When a user logs out of Shopify admin, all online mode access tokens created during the same web session are revoked."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/online-access-tokens.md`

Implication: online tokens are per-user and short-lived, but that does not mean the template stores them by default.

## What The Official Template Actually Does

### Template config: offline-only by default, expiring offline tokens enabled

The template config is in [refs/shopify-app-template/app/shopify.server.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/shopify.server.ts#L10-L25):

```ts
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
});
```

Important: there is no `useOnlineTokens: true` here.

The underlying `shopify-app-react-router` config builder sets `useOnlineTokens` to `false` by default in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/shopify-app.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/shopify-app.ts#L191-L210):

```ts
useOnlineTokens: appConfig.useOnlineTokens ?? false,
```

So the template default is:

- persist offline sessions
- do not persist online sessions unless explicitly opted into
- request expiring offline tokens

### Template admin auth flow

The template exports `authenticate = shopify.authenticate`, and route loaders/actions call `authenticate.admin(request)`.

Under the hood, `authenticate.admin` does this in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts#L145-L231):

1. Handle bot/options/bounce/exit-iframe cases.
2. For document requests, ensure `shop` and `host` exist, ensure the app is embedded, and ensure an `id_token` is present.
3. Validate the session token.
4. Derive the session id:
   - offline session id when `useOnlineTokens === false`
   - online session id when `useOnlineTokens === true`
5. Load the session from storage.
6. Hand off to the token-exchange strategy if the session is missing or inactive.

The key branch is:

```ts
const sessionId = config.useOnlineTokens
  ? api.session.getJwtSessionId(shop, payload.sub)
  : api.session.getOfflineId(shop);
```

That is why the template default is one offline row per shop.

### Template token-exchange strategy

The token-exchange strategy lives in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts#L33-L176).

Two details matter most.

First, token exchange passes the future flag through to Shopify:

```ts
return await api.auth.tokenExchange({
  sessionToken,
  shop,
  requestedTokenType,
  expiring: config.future.expiringOfflineAccessTokens,
});
```

Second, offline is always stored, and online is stored only if `useOnlineTokens` is enabled:

```ts
const {session: offlineSession} = await exchangeToken({
  request,
  sessionToken,
  shop,
  requestedTokenType: RequestedTokenType.OfflineAccessToken,
});

await config.sessionStorage!.storeSession(offlineSession);

if (config.useOnlineTokens) {
  const {session: onlineSession} = await exchangeToken({
    request,
    sessionToken,
    shop,
    requestedTokenType: RequestedTokenType.OnlineAccessToken,
  });
  await config.sessionStorage!.storeSession(onlineSession);
}
```

So, again, the template default is offline-only persisted rows.

### Template webhook and background auth flow

This is the part that matters most for session lifetime parity.

`authenticate.webhook(request)` in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/authenticate.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/authenticate.ts#L19-L104):

1. validates HMAC
2. loads the shop's offline session via `ensureValidOfflineSession(params, check.domain)`
3. returns a context with `session` and `admin` if a session exists

`ensureValidOfflineSession` in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-valid-offline-session.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-valid-offline-session.ts#L6-L15) is just:

```ts
const session = await createOrLoadOfflineSession(params, shop);
if (!session) return undefined;
return ensureOfflineTokenIsNotExpired(session, params, shop);
```

And `ensureOfflineTokenIsNotExpired` in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts#L10-L31) refreshes expiring offline tokens in place:

```ts
if (
  config.future?.expiringOfflineAccessTokens &&
  session.isExpired(WITHIN_MILLISECONDS_OF_EXPIRY) &&
  session.refreshToken
) {
  const offlineSession = await refreshToken(params, shop, session.refreshToken);
  await config.sessionStorage!.storeSession(offlineSession);
  return offlineSession;
}
```

This same helper also backs `unauthenticated.admin(shop)` in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/unauthenticated/admin/factory.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/unauthenticated/admin/factory.ts#L8-L22).

That means the template has a real offline-session lifecycle outside interactive browser requests:

- webhook flows
- background flows
- unauthenticated admin contexts

all load the offline row and refresh it when needed.

### Template invalidation behavior on 401

The official strategy also handles stale tokens when Admin API calls return 401.

In [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts#L154-L170), the admin client error hook does:

```ts
if (error.response.code === 401) {
  await invalidateAccessToken({config, api, logger}, session);
  respondToInvalidSessionToken({ params: {config, api, logger}, request });
}
```

And `invalidateAccessToken` in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/invalidate-access-token.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/invalidate-access-token.ts#L5-L16) simply clears the stored token and re-stores the row:

```ts
session.accessToken = undefined;
await config.sessionStorage!.storeSession(session);
```

This matters because the template does not just rely on `session.isActive()` in the happy path. It also invalidates rows that become stale due to server-side 401s.

### Template invalid-session-token retry behavior

When a session token is invalid, the template does not just throw a generic error.

`validateSessionToken` catches decode/validation errors and calls `respondToInvalidSessionToken` in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/respond-to-invalid-session-token.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/respond-to-invalid-session-token.ts#L11-L27):

- document requests redirect to the bounce/session-token page
- XHR/fetch requests get `401 Unauthorized`, optionally with a retry header

That behavior is part of the real parity surface because it affects how expired or invalid browser session tokens recover.

## What This Port Does Today

### Session storage shape

The schema in [migrations/0001_init.sql](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/migrations/0001_init.sql) includes both online-user fields and refresh-token fields:

```sql
create table if not exists Session (
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

The repository in [src/lib/Repository.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Repository.ts#L56-L101) upserts rows by `id`, just like the official adapters:

```sql
on conflict(id) do update set
```

So the port is capable of storing both kinds of metadata, but actual behavior depends on how session ids are chosen and how tokens are requested.

### Port admin auth flow

The main port logic is in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L291-L449).

The flow is:

1. Handle `/auth/session-token` bounce page and `/auth/exit-iframe` page.
2. For document requests, require `shop` and `host`, ensure `embedded=1`, and bounce to `/auth/session-token` when `id_token` is missing.
3. Read bearer token or `id_token`.
4. Decode the session token.
5. Derive the offline session id.
6. Load the row from storage.
7. If the row is active, use it.
8. Otherwise do offline token exchange and store the new row.

The key branch is:

```ts
const sessionId = yield* offlineSessionId(sessionShop);
...
const { session } = yield* tryShopifyPromise(() =>
  shopify.auth.tokenExchange({
    shop: sessionShop,
    sessionToken,
    requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
  }),
);
```

Source: [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L351-L377)

So the port currently matches the template's default row cardinality:

- one offline row per shop
- upsert by stable offline id
- no online-session persistence by default

### Port persists refresh fields but does not use them

`storeSession` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L153-L193) persists `refreshToken` and `refreshTokenExpires`:

```ts
refreshToken: session.refreshToken ?? null,
refreshTokenExpires: session.refreshTokenExpires?.getTime() ?? null,
```

But there is no local equivalent of:

- `ensureValidOfflineSession`
- `ensureOfflineTokenIsNotExpired`
- `refreshToken`
- `unauthenticated.admin(shop)`

Search-wise, `refreshToken` is only present in schema/domain/persistence, not in runtime refresh logic.

### Port webhook behavior

The port's `validateWebhook` helper in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L262-L273) only validates HMAC and returns the validation result plus raw body:

```ts
const result = yield* tryShopifyPromise(() =>
  shopify.webhooks.validate({
    rawBody,
    rawRequest: request,
  }),
);
return { ...result, rawBody };
```

There is no port equivalent of the template's `authenticate.webhook()` that:

- loads the offline session
- refreshes it when needed
- returns `session` and `admin`

Current webhook routes are therefore manually built around HMAC validation only.

`app/uninstalled` in [src/routes/webhooks.app.uninstalled.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/webhooks.app.uninstalled.ts#L22-L38) validates HMAC and deletes all rows by shop.

`app/scopes_update` in [src/routes/webhooks.app.scopes_update.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/webhooks.app.scopes_update.ts#L12-L35) validates HMAC, derives the offline session id manually, and updates the stored scope.

Those two routes are fine for their current narrow purpose, but they are not a generic parity replacement for `authenticate.webhook()`.

### Port GraphQL client behavior

The port stores admin context in memory per request and calls Shopify GraphQL directly through `buildAdminContext(...).graphql` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L132-L147) and [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L422-L436).

That path does not currently have a `handleClientError` layer equivalent to the template's 401 invalidation behavior.

So a stored row can fail server-side with 401, but the port does not clear the bad access token the way the template does.

### Port invalid-session-token behavior

The port calls `shopify.session.decodeSessionToken(sessionToken)` directly in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L351-L356). If that fails, the error is wrapped as a generic `ShopifyError` and bubbles through the Effect runtime.

That is not parity with the template's recovery behavior, which redirects document requests back through the bounce/session-token path and returns structured 401 responses for XHR/fetch requests.

For server functions, [src/lib/ShopifyServerFnMiddleware.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/ShopifyServerFnMiddleware.ts#L41-L58) converts any `Response` returned by `authenticateAdmin` into a thrown `Error`, which is another sign that invalid-token recovery behavior is not yet aligned with the template's expected control flow.

## Parity Assessment

### Already at parity or close enough

One offline row per installed shop
: yes. The port uses the stable offline session id and upserts by `id`.

No default online-session persistence
: yes. The port behaves like the template default here.

Delete all rows by shop on `app/uninstalled`
: yes. The port even simplifies the template's conditional delete into an unconditional idempotent delete, which is acceptable.

Update offline session scope on `app/scopes_update`
: yes, for the current offline-only model.

### Missing parity

Request expiring offline tokens during token exchange
: missing. The template passes `expiring: config.future.expiringOfflineAccessTokens`; the port does not.

Refresh offline tokens for webhook/background contexts
: missing. The template has `ensureValidOfflineSession -> ensureOfflineTokenIsNotExpired -> refreshToken`; the port has no equivalent.

Generic webhook auth helper returning `session` and `admin`
: missing. The port only has HMAC validation.

Background or unauthenticated admin helper backed by offline-session refresh
: missing. No port equivalent of `unauthenticated.admin(shop)`.

401 invalidation of stale access tokens
: missing. The template clears `session.accessToken` and re-stores the row when Admin API returns 401.

Invalid session token recovery behavior
: missing. The template retries through bounce/401 control flow; the port currently turns this into generic errors.

### Not a parity requirement

Persist online sessions by default
: not required. That is not what the template does.

Periodic cleanup of expired online rows
: not required for template-default parity because online rows are not persisted by default.

## What Parity Should Mean For Session Lifetime

Once the missing expiring-offline-token behavior is ported, the session lifetime model should be:

- Browser session tokens remain one-minute JWTs and are never stored in `Session`.
- The database stores one offline row per installed shop.
- That offline row lives for the installation lifetime.
- If the access token is expiring, the row is refreshed in place using the stored refresh token.
- The row is deleted on `app/uninstalled`.
- If a stored token is invalidated by a 401, clear the access token and let the next auth flow re-exchange or refresh it.

Under that model, no periodic cleanup job is required for correctness.

Optional housekeeping is still possible:

- prune rows whose `refreshTokenExpires` is long past
- prune expired online rows if the app ever deliberately enables `useOnlineTokens`

But those are DB-hygiene decisions, not required Shopify semantics for the template default.

## Recommended Port Plan

To reach parity with the template without adding unnecessary complexity:

1. Keep the current offline-only persisted session model.
2. Add an explicit local config/constant equivalent to `expiringOfflineAccessTokens: true`.
3. Pass `expiring: true` when exchanging offline tokens in `authenticateAdmin`.
4. Add a local `ensureValidOfflineSession(shop)` helper:
   - derive offline session id
   - load the stored row
   - if the row is expired or near expiry and has a `refreshToken`, call `shopify.auth.refreshToken({ shop, refreshToken })`
   - upsert the refreshed row and return it
5. Add a local `authenticateWebhook(request)` helper that mirrors the template contract:
   - validate HMAC
   - load/refresh offline session
   - return `payload`, `shop`, `topic`, `session?`, `admin?`
6. Add a local `unauthenticatedAdmin(shop)` helper for background work, backed by `ensureValidOfflineSession`.
7. Wrap Admin API calls with a 401 handler that invalidates the stored token, similar to the template.
8. Replace generic invalid-session-token failures with template-like recovery:
   - document requests bounce back through `/auth/session-token`
   - XHR/server-function requests get structured 401 behavior instead of opaque errors

## Bottom Line

The important correction is:

- I was wrong that the template stores online sessions by default.
- The template default is offline-only persisted sessions.

The deeper parity result is:

- this port already matches the template's default row cardinality and uninstall cleanup model
- the real missing parity is expiring offline token request/refresh and the surrounding auth helpers that make that lifecycle work in webhooks, background contexts, and 401 recovery

That is the behavior to port if the goal is real session/auth parity with `refs/shopify-app-template`.
