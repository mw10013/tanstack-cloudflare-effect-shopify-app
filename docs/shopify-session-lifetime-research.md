# Shopify Session Lifetime Research

Question: for the `Session` table in [migrations/0001_init.sql](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/migrations/0001_init.sql), when should rows be deleted, and do online sessions accumulate?

## Short Answer

For this app as currently implemented, the practical model is simple: one offline session row per installed shop, deleted on `app/uninstalled`.

The confusing part is that Shopify has two different things called "session":

`session token`
: App Bridge JWT sent from the browser to your backend. Lifetime is one minute. Not stored in your `Session` table.

`Session` row
: Server-side persisted OAuth/access-token state. This is what your `Session` table stores.

Shopify's docs make the token/session split explicit:

> "The lifetime of a session token is one minute."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md`

> "Unlike API access tokens, session tokens can't be used to make authenticated requests to Shopify APIs."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md`

## What Shopify Says

### Offline access tokens

Offline tokens are the long-lived shop-level credential.

> "Offline is the default access mode when none is specified."

> "Tokens with offline access mode are meant for service-to-service requests where no user interaction is involved."

> "Non-expiring offline tokens ... remain valid indefinitely until app is uninstalled or secret revocation."

> "Only one expiring offline token can be active per app/shop combination."

> "Acquiring offline tokens for the same shop and installation returns the same access token each time."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md`

Implication: offline sessions are not supposed to fan out over time. Conceptually, there is one shop-level installation credential.

### Online access tokens

Online tokens are user-level and short-lived.

> "Tokens with online access mode are linked to an individual user on a store, where the access token's lifespan matches the lifespan of the user's web session."

> "Tokens with online access mode expire either when the user logs out or after 24 hours."

> "Users can revoke their own access to your app at any time, without affecting the validity of other users' access tokens."

> "When a user logs out of Shopify admin, all online mode access tokens created during the same web session are revoked."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/online-access-tokens.md`

Implication: online sessions can exist for multiple users on one shop, but they are per-user, not meant to be a forever-growing stream of browser-session rows.

## What The Official Template And SDK Do

Important distinction:

the SDK can store both offline and online sessions
: but only when `useOnlineTokens` is enabled

the official template does not enable `useOnlineTokens`
: so by default it persists offline sessions, not both

The default comes from the SDK config builder:

```ts
useOnlineTokens: appConfig.useOnlineTokens ?? false,
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/shopify-app.ts`

And the template config does not set `useOnlineTokens` at all:

```ts
const shopify = shopifyApp({
  // ...
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
});
```

Source: `refs/shopify-app-template/app/shopify.server.ts`

### Uninstall cleanup

The official template deletes all sessions for a shop on uninstall:

```tsx
if (session) {
  await db.session.deleteMany({ where: { shop } });
}
```

Source: `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx`

The Shopify React Router docs also call out that webhook auth returns the offline session, and that it can already be gone after uninstall:

> "A session with an offline token for the shop. Returned only if there is a session for the shop. Webhook requests can trigger after an app is uninstalled If the app is already uninstalled, the session may be undefined."

Source: `refs/shopify-docs/docs/api/shopify-app-react-router/v1/entrypoints/shopifyapp.md`

### Session IDs explain whether rows accumulate

The SDK defines the offline session id as:

```ts
return `offline_${sanitizeShop(config)(shop, true)}`;
```

And online session ids for embedded apps as:

```ts
return `${sanitizeShop(config)(shop, true)}_${userId}`;
```

Source: `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session-utils.ts`

Then the official Prisma adapter persists sessions with an `upsert` by `id`:

```ts
await this.getSessionTable().upsert({
  where: {id: session.id},
  update: data,
  create: data,
});
```

Source: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-prisma/src/prisma.ts`

So the official behavior is:

one offline row per shop
: id looks like `offline_shop-name.myshopify.com`

one online row per shop-user pair
: id looks like `shop-name.myshopify.com_<userId>`

not one row per browser session
: repeat auth overwrites the same row id

That directly answers the "won't they accumulate?" question: not for the same shop/user pair. They only multiply across different users on the same shop.

### Token exchange behavior

The React Router package says:

> "If there's no session for the user, then the package will perform token exchange and create a new session."

Source: `refs/shopify-docs/docs/api/shopify-app-react-router/v1/guide-admin.md`

Its token-exchange strategy also stores the offline session first, and optionally stores an online session if `useOnlineTokens` is enabled:

```ts
await config.sessionStorage!.storeSession(offlineSession);

if (config.useOnlineTokens) {
  await config.sessionStorage!.storeSession(onlineSession);
}
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts`

That matches the docs for `useOnlineTokens`:

> "If your app uses online tokens, then both online and offline tokens will be saved to your database. This ensures your app can perform background jobs."

Source: `refs/shopify-docs/docs/api/shopify-app-react-router/v1/entrypoints/shopifyapp.md`

So, to be precise:

template default
: offline-only persisted sessions

optional SDK mode
: offline plus online persisted sessions when `useOnlineTokens: true`

## What This Repo Actually Does

Your schema mirrors the official template/session adapter shape, including online-user fields and refresh-token fields:

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

Source: [migrations/0001_init.sql](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/migrations/0001_init.sql)

But your current app logic stores only offline sessions.

Your admin auth flow computes the offline session id and exchanges only an offline access token:

```ts
const sessionId = yield* offlineSessionId(sessionShop);

const { session } = yield* tryShopifyPromise(() =>
  shopify.auth.tokenExchange({
    shop: sessionShop,
    sessionToken,
    requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
  }),
);
```

Source: [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L332-L376)

Your repository also upserts by `id`, just like the official adapter:

```sql
on conflict(id) do update set
```

Source: [src/lib/Repository.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Repository.ts#L55-L92)

Your uninstall webhook deletes all sessions for the shop unconditionally:

```ts
yield* shopify.deleteSessionsByShop(shop);
```

Source: [src/routes/webhooks.app.uninstalled.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/webhooks.app.uninstalled.ts#L22-L37)

Your scopes-update webhook also treats the webhook session as shop-level offline state:

```ts
const id = yield* shopify.offlineSessionId(shop);
yield* shopify.updateSessionScope({
  id,
  scope: payload.current.toString(),
});
```

Source: [src/routes/webhooks.app.scopes_update.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/webhooks.app.scopes_update.ts#L21-L32)

Conclusion for this repo today: you effectively have one `Session` row per installed shop, not a growing pool of online sessions. That matches the template's default session-storage shape.

## Actual Port Gap

The real auth/session gap I found is not online-session storage. It is expiring offline token support.

The template opts into expiring offline tokens:

```ts
future: {
  expiringOfflineAccessTokens: true,
},
```

Source: `refs/shopify-app-template/app/shopify.server.ts`

In the official SDK, that flag is wired into token exchange:

```ts
return await api.auth.tokenExchange({
  sessionToken,
  shop,
  requestedTokenType,
  expiring: config.future.expiringOfflineAccessTokens,
});
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts`

This repo's port currently exchanges an offline token without passing `expiring: true`:

```ts
shopify.auth.tokenExchange({
  shop: sessionShop,
  sessionToken,
  requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
})
```

Source: [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L368-L374)

This repo also stores `refreshToken` and `refreshTokenExpires` in the schema, but I did not find the corresponding refresh path the template/SDK uses for expiring offline tokens.

So the corrected summary is:

not missed
: template storing online sessions by default

likely missed or not yet ported
: template's expiring-offline-token behavior and refresh flow

## When To Delete Or Clean Up

### Definitely delete

`app/uninstalled`
: yes, delete all sessions for the shop. This is both the official template behavior and your current implementation.

client secret revocation / deliberate credential reset
: yes, purge unusable stored sessions. Shopify explicitly says non-expiring offline tokens are revoked by uninstall or secret revocation.

### Usually keep

offline session for an installed shop
: keep it. That is the durable installation credential.

expired online sessions
: safe to clean up, but not required for correctness. The SDK already checks whether a stored session is active and re-exchanges tokens when needed.

expired expiring-offline sessions with a still-valid refresh token
: keep them. The refresh path is meant to update the same stored row.

### Reasonable housekeeping, not Shopify-mandated

delete expired online rows older than some retention window
: useful only if you choose to store online sessions and want to keep the table tidy.

delete expiring-offline rows whose `refreshTokenExpires` is in the past
: also optional housekeeping. They are no longer usable, but a merchant launching the app again can recreate them.

The SDK behavior here is "invalidate or refresh", not "auto-delete". For example, on `401` it clears the access token and stores the same session again:

```ts
session.accessToken = undefined;
await config.sessionStorage!.storeSession(session);
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/invalidate-access-token.ts`

And for expiring offline tokens it refreshes and stores the refreshed session:

```ts
if (session.isExpired(WITHIN_MILLISECONDS_OF_EXPIRY) && session.refreshToken) {
  const offlineSession = await refreshToken(...);
  await config.sessionStorage!.storeSession(offlineSession);
}
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts`

## Practical Recommendation

For this repo, keep the current model:

one offline row per shop
: keep it for the life of the installation

delete by `shop` on `app/uninstalled`
: already implemented and correct

no scheduled cleanup required right now
: because your current auth flow stores offline sessions only

If you later switch to storing online sessions too, then add optional housekeeping for expired online rows. That would be for DB hygiene, not because Shopify requires deletion on every expiry.

## Bottom Line

The `Session` table is not storing one-minute App Bridge session tokens.

In Shopify's model, offline session state is durable and shop-level. Online session state is user-level and short-lived. In the official SDK, both are keyed so they overwrite stable ids instead of accumulating endlessly.

In this repo as written today, the only persisted session that matters is the offline shop session, so rows should generally live until uninstall.
