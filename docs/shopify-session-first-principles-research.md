# Shopify Session First-Principles Research

Scanned sources:

- `refs/shopify-docs/docs/apps/build/authentication-authorization.md`
- `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md`
- `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens/set-up-session-tokens.md`
- `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md`
- `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md`
- `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/online-access-tokens.md`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session-utils.ts`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/auth/oauth/create-session.ts`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/auth/oauth/token-exchange.ts`
- `refs/shopify-app-js/packages/apps/session-storage/README.md`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/src/types.ts`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/migrations.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/create-or-load-offline-session.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-valid-offline-session.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/refresh-token.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/authenticate.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/types.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/unauthenticated/admin/types.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-express/src/app-installations.ts`
- `refs/shopify-app-template/app/shopify.server.ts`
- `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx`
- `refs/shopify-app-template/prisma/schema.prisma`
- `src/lib/Domain.ts`
- `src/lib/Repository.ts`
- `src/lib/Shopify.ts`

## Short Answer

From an app perspective, a Shopify `Session` is not a browser session and not the short-lived App Bridge JWT.

It is the app's persisted authorization record for talking to Shopify's Admin API:

- for one shop installation (`offline` session), or
- for one specific user on one shop (`online` session).

That persisted record contains the Admin API access token and related metadata. Shopify's own Node adapters store that record in flat columns, not as one JSON blob.

So if the goal is parity with Shopify's actual session model, then yes: a `payload` JSON blob is not how Shopify's official storage adapters model the data.

## The Three Different Things Shopify Calls "Session"

This is the main source of confusion.

### 1. Session token

Shopify docs are explicit:

> "A session token is a mechanism that lets your app authenticate the requests that it makes between the client side and your app's backend."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md`

This is the short-lived JWT fetched from App Bridge.

- lifetime: 1 minute
- purpose: prove the embedded frontend request really came from Shopify/admin
- used between frontend and your backend
- not used directly to call Shopify Admin API
- should not be what you store as the durable shop session record

### 2. Access token

Shopify docs distinguish authentication from authorization:

- session token authenticates the frontend request into your app
- access token authorizes your backend to call Shopify Admin API

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization.md`

The durable thing your app needs to persist is the Admin API access token, plus enough metadata to know what kind of token it is and whether it is still usable.

### 3. Persisted Shopify `Session`

In `@shopify/shopify-api`, the `Session` class is Shopify's canonical in-memory representation of that persisted authorization record.

Source: `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts`

The class comment says:

> "Stores App information from logged in merchants so they can make authenticated requests to the Admin API."

That is the conceptual model to anchor on.

## What A Shopify Session Actually Represents

Conceptually, the persisted Shopify `Session` is:

- the app installation's durable Admin API authorization for a shop, or
- the logged-in merchant user's Admin API authorization for a shop

The distinction is `isOnline`.

### Offline session

Shopify docs:

> "Offline access mode is ideal for background work in response to webhooks, or for maintenance work in backgrounded jobs."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md`

Offline session characteristics:

- shop-scoped, not user-scoped
- one logical installation/session per app+shop
- used for webhooks, background jobs, and shop-level work
- survives beyond one user's admin browser session

### Online session

Shopify docs:

> "Online access tokens are linked to an individual user on a store, where the access token's lifespan matches the lifespan of the user's web session."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/online-access-tokens.md`

Online session characteristics:

- user+shop scoped
- used when the app wants per-user permissions
- expires with the user's admin session or after 24 hours
- can vary by user permissions

## The Canonical Session Shape

Shopify's own session-storage guide defines the `Session` data model like this:

- `id`
- `shop`
- `state`
- `isOnline`
- `scope`
- `expires`
- `accessToken`
- `refreshToken`
- `refreshTokenExpires`
- `onlineAccessInfo`

Source: `refs/shopify-session-prisma/packages/apps/shopify-api/docs/guides/session-storage.md`

The actual TypeScript source matches that. `SessionParams` in `shopify-api` is:

- `id: string`
- `shop: string`
- `state: string`
- `isOnline: boolean`
- `scope?: string`
- `expires?: Date`
- `accessToken?: string`
- `refreshToken?: string`
- `refreshTokenExpires?: Date`
- `onlineAccessInfo?: OnlineAccessInfo`

Source: `refs/shopify-app-js/packages/apps/shopify-api/lib/session/types.ts`

## Session IDs: What Row Identity Actually Means

This part matters a lot for database design.

In Shopify's source:

```ts
export function getOfflineId(config: ConfigInterface) {
  return (shop: string): string => {
    return `offline_${sanitizeShop(config)(shop, true)}`;
  };
}

export function getJwtSessionId(config: ConfigInterface) {
  return (shop: string, userId: string): string => {
    return `${sanitizeShop(config)(shop, true)}_${userId}`;
  };
}
```

Source: `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session-utils.ts`

So the persisted session primary key is:

- offline: `offline_${shop}`
- online: `${shop}_${userId}`

Important implication:

- do not confuse JWT payload `sid` with persisted `Session.id`
- Shopify's Node SDK does not use JWT `sid` as the database key

## Why `state` Exists Even Though It Often Looks Useless

`state` is the OAuth state used in the auth-code flow.

But token exchange sessions still keep the field because `Session` requires it. In Shopify's token-exchange implementation:

```ts
return {
  session: createSession({
    accessTokenResponse: await postResponse.json<AccessTokenResponse>(),
    shop: cleanShop,
    state: '',
    config,
  }),
};
```

Source: `refs/shopify-app-js/packages/apps/shopify-api/lib/auth/oauth/token-exchange.ts`

So:

- `state` is part of the canonical session schema
- for token-exchange-created sessions it is often just `''`
- if you want parity with Shopify's shape, you still keep the column

## How Shopify Expects Apps To Store Sessions

Shopify made session storage app-owned as of v6.

The docs say:

> "As of v6 of the library, there are no `SessionStorage` implementations included and the responsibility for implementing session storage is now delegated to the application."

Source: `refs/shopify-session-prisma/packages/apps/shopify-api/docs/guides/session-storage.md`

But the storage contract is still standardized. The `SessionStorage` interface is:

- `storeSession(session)`
- `loadSession(id)`
- `deleteSession(id)`
- `deleteSessions(ids)`
- `findSessionsByShop(shop)`

Source: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/src/types.ts`

That means Prisma is not the model. Prisma is just one adapter implementing a generic storage contract.

### What that contract is actually for

The session-storage package README describes it as:

> "Provides the interfaces used by the app middleware packages to write custom packages."

Source: `refs/shopify-app-js/packages/apps/session-storage/README.md`

That wording matters.

`SessionStorage` is best understood as a Shopify app-framework boundary contract:

- useful to React Router / Express style framework integrations
- useful for third-party storage adapters that want to plug into those frameworks
- not necessarily the best primary abstraction for every app architecture

For a TanStack Start + Effect v4 app, this suggests a distinction:

- use SQLite adapter behavior as the storage reference
- do not automatically adopt Shopify's `SessionStorage` interface as the app's core internal design

## Serialization Helpers Shopify Gives You

There are two important serialization shapes:

### `session.toObject()` / `new Session(obj)`

This is the semantic object form.

### `session.toPropertyArray(true)` / `Session.fromPropertyArray(entries, true)`

This is Shopify's flat serde form.

From the source:

```ts
const propertiesToSave = [
  'id',
  'shop',
  'state',
  'isOnline',
  'scope',
  'accessToken',
  'expires',
  'refreshToken',
  'refreshTokenExpires',
  'onlineAccessInfo',
];
```

And for `onlineAccessInfo`, `toPropertyArray(true)` expands it into:

```ts
[
  ['userId', value?.associated_user?.id],
  ['firstName', value?.associated_user?.first_name],
  ['lastName', value?.associated_user?.last_name],
  ['email', value?.associated_user?.email],
  ['locale', value?.associated_user?.locale],
  ['emailVerified', value?.associated_user?.email_verified],
  ['accountOwner', value?.associated_user?.account_owner],
  ['collaborator', value?.associated_user?.collaborator],
]
```

Source: `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts`

That flat property-array shape is what the official relational adapters are built around.

## Important Nuance: Shopify Does Not Persist Every OAuth Response Field

This is easy to miss.

Online token exchange responses include:

- `expires_in`
- `associated_user_scope`
- `associated_user`

But Shopify's persisted relational session shape does not create dedicated columns for all of that.

What survives the official flat serde path is:

- absolute `expires` timestamp
- user identity fields (`userId`, `firstName`, `lastName`, `email`, `locale`, `emailVerified`, `accountOwner`, `collaborator`)

What is notably not present as official flat columns:

- JWT session-token payload fields like `iss`, `dest`, `sub`, `sid`, `jti`
- raw `onlineAccessInfo` object
- `associated_user_scope`
- raw `expires_in`

So if the question is "what columns should exist if we want parity with Shopify's actual session serde?", the answer is not "every nested thing from every OAuth response". It is the much smaller official flat shape.

## How The Official Template Uses Sessions

The template wires Shopify exactly this way:

```ts
const shopify = shopifyApp({
  ...
  sessionStorage: new PrismaSessionStorage(prisma),
  future: {
    expiringOfflineAccessTokens: true,
  },
});
```

Source: `refs/shopify-app-template/app/shopify.server.ts`

That is important for two reasons:

1. The template does not treat Prisma as Shopify's session model. It treats Prisma as one storage adapter.
2. The storage shape that should drive our D1 design is still the official SQLite adapter, not the fact that the template happens to use Prisma.

### What gets stored during auth

In the auth-code flow:

```ts
const {session} = await api.auth.callback(...);
await config.sessionStorage!.storeSession(session);
```

The React Router package follows the same pattern in token-exchange auth: whenever the current row is missing or inactive, Shopify gets fresh token(s) and persists the resulting `Session` object.

In token exchange:

- offline session is stored first
- online session is also stored if `useOnlineTokens` is enabled

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts`

### Which session gets loaded later

For embedded admin requests, Shopify derives the lookup key from the session token:

```ts
const sessionId = config.useOnlineTokens
  ? api.session.getJwtSessionId(shop, payload.sub)
  : api.session.getOfflineId(shop);
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts`

So by default, if `useOnlineTokens` is false, even interactive embedded admin requests are backed by the offline shop session.

That is why webhook and unauthenticated/background flows consistently use the offline session.

### Webhooks and background work use offline sessions

The React Router webhook types say the returned webhook session is:

> "A session with an offline token for the shop."

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/types.ts`

And `unauthenticated.admin(shop)` docs say:

> "This will always be an offline session."

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/unauthenticated/admin/types.ts`

This is conceptually right:

- webhooks are about the installation/shop
- background work is about the installation/shop
- they should load `offline_${shop}`

The actual React Router helper path matches that:

```ts
const offlineSessionId = api.session.getOfflineId(shop);
const session = await config.sessionStorage!.loadSession(offlineSessionId);
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/create-or-load-offline-session.ts`

## Official Reference: SQLite Adapter

This is the adapter to treat as the canonical reference for a D1 implementation.

The official SQLite adapter creates:

```sql
CREATE TABLE ... (
  id varchar(255) NOT NULL PRIMARY KEY,
  shop varchar(255) NOT NULL,
  state varchar(255) NOT NULL,
  isOnline integer NOT NULL,
  expires integer,
  scope varchar(1024),
  accessToken varchar(255),
  userId integer,
  firstName varchar(255),
  lastName varchar(255),
  email varchar(255),
  accountOwner integer,
  locale varchar(255),
  collaborator integer,
  emailVerified integer,
  refreshToken varchar(255),
  refreshTokenExpires integer
);
```

Source: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts`

This is very close to what we want for D1:

- relational, flat columns
- integer timestamps for expiry fields
- no JSON payload column
- no `createdAt` / `updatedAt`

### Why SQLite is the right reference

- It is Shopify's official SQL adapter.
- D1 is SQLite-backed, so its column and timestamp choices are the closest storage precedent.
- The adapter's read/write logic already shows the exact serde contract Shopify expects for SQL storage.

## Secondary Reference: Template Prisma Schema

The current template still matters because it shows how Shopify's starter app uses session storage in practice.

Its Prisma schema uses the same flat session fields:

```prisma
model Session {
  id                  String    @id
  shop                String
  state               String
  isOnline            Boolean   @default(false)
  scope               String?
  expires             DateTime?
  accessToken         String
  userId              BigInt?
  firstName           String?
  lastName            String?
  email               String?
  accountOwner        Boolean?
  locale              String?
  collaborator        Boolean?
  emailVerified       Boolean?
  refreshToken        String?
  refreshTokenExpires DateTime?
}
```

Source: `refs/shopify-app-template/prisma/schema.prisma`

## The Flat Columns We Should Care About

If the goal is D1 storage that matches Shopify's own relational session adapters, the important flat columns are:

| Column | Meaning | Notes |
| --- | --- | --- |
| `id` | Session primary key | `offline_${shop}` or `${shop}_${userId}` |
| `shop` | Shop domain | e.g. `example.myshopify.com` |
| `state` | OAuth state | Often `''` for token-exchange sessions |
| `isOnline` | Offline vs online | `0/1` in SQLite-style storage |
| `scope` | Granted app scopes | Text, not 255-capped in practice |
| `expires` | Access-token expiry | Absolute time, not `expires_in` duration |
| `accessToken` | Admin API access token | Nullable is safer in SQLite/D1 because Shopify can invalidate it |
| `userId` | Shopify user id | Only meaningful for online sessions |
| `firstName` | User first name | Online only |
| `lastName` | User last name | Online only |
| `email` | User email | Online only |
| `accountOwner` | User is account owner | Online only |
| `locale` | User locale | Online only |
| `collaborator` | User is collaborator | Online only |
| `emailVerified` | User email verified | Online only |
| `refreshToken` | Refresh token for expiring offline tokens | Optional |
| `refreshTokenExpires` | Refresh-token expiry | Optional |

## Why Flat Columns Are A Better Fit Than One JSON Blob

### 1. This is what Shopify's own adapters do

Both official relational adapters are flat-column models:

- SQLite adapter: flat columns
- template Prisma schema: same flat field set

Neither stores the whole session as one opaque JSON payload.

### 2. Shopify has already had to migrate session schema over time

The official SQLite adapter ships migrations for:

- increasing `scope` width to 1024
- adding `refreshToken` and `refreshTokenExpires`
- expanding old user info into explicit user columns

Source: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/migrations.ts`

That tells us Shopify treats session persistence as a relational schema that evolves deliberately, not as "just dump a blob and forget it".

### 3. Flat columns let you do the useful queries the interface already expects

The `SessionStorage` interface explicitly includes `findSessionsByShop(shop)`.

That is a strong hint the storage model is expected to support shop-level lookup naturally.

With flat columns, it is trivial.
With a JSON blob, you keep needing bespoke app-side decode logic for anything beyond primary-key reads.

### 4. The serde path is already designed for flat storage

Shopify gives you `toPropertyArray(true)` and `fromPropertyArray(..., true)` specifically so a storage layer can flatten and reconstruct the session.

That is the storage contract to align with.

## Session Cleanup And Stale Rows

This was missing from the first draft and it matters.

### Can sessions pile up in the database?

Yes.

The schema and session-id rules imply two different accumulation patterns:

- offline sessions: at most one logical row per app+shop, keyed as `offline_${shop}`
- online sessions: potentially many rows per shop, one per user, keyed as `${shop}_${userId}`

So if `useOnlineTokens` is enabled, a shop can accumulate multiple historical online-session rows over time as different staff users access the app.

### Does Shopify automatically garbage collect them?

I did not find any official SQLite-adapter or React Router logic that performs periodic expiry-based deletion.

What the official code does have:

- `loadSession`
- `deleteSession`
- `deleteSessions`
- `findSessionsByShop`

Source: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/src/types.ts`

And the SQLite adapter implements those methods, but no background janitor or TTL cleanup loop.

So the official storage story is:

- session storage must support deletion
- Shopify app code uses validity checks at read time
- cleanup policy beyond explicit deletes is up to the app

### What happens when a stored session is expired or invalid?

For embedded admin requests in the React Router package, the auth strategy checks the loaded row:

```ts
if (!session || !session.isActive(undefined, WITHIN_MILLISECONDS_OF_EXPIRY)) {
  ... request new token(s) ...
  await config.sessionStorage!.storeSession(...)
}
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts`

So stale rows are tolerated functionally:

- they are loaded
- checked for usability
- replaced or refreshed when needed

For offline sessions with expiring offline tokens, React Router refreshes lazily on use:

```ts
if (session.isExpired(...) && session.refreshToken) {
  const offlineSession = await refreshToken(...)
  await config.sessionStorage!.storeSession(offlineSession)
}
```

Sources:

- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-valid-offline-session.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/refresh-token.ts`

That means unused expired rows can remain in storage until:

- they are used again and refreshed/replaced, or
- the app deletes them

### What cleanup guidance did I find from Shopify docs?

The clearest official guidance is uninstall cleanup.

Shopify's session-token guide says:

> "To ensure OAuth continues to work with session tokens, your app must update its shop records when a shop uninstalls your app."

Source: `refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens/set-up-session-tokens.md`

That guidance is phrased in terms of shop records, not strictly session rows, but from the app-template and storage interface it clearly maps to clearing installation/session state on uninstall.

### How does the template handle cleanup?

The template subscribes to `app/uninstalled` and deletes every session for that shop:

```ts
if (session) {
  await db.session.deleteMany({ where: { shop } });
}
```

Source: `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx`

That is the key cleanup behavior to mirror.

Conceptually, this is right because uninstall invalidates the app installation itself, so both:

- the offline session, and
- any online user sessions for that shop

should be treated as dead.

### Why does Shopify expose `findSessionsByShop` and `deleteSessions`?

Because shop-wide cleanup is a first-class use case.

The clearest code proof is the Express `AppInstallations` helper:

```ts
const shopSessions = await this.sessionStorage.findSessionsByShop!(shopDomain);
await this.sessionStorage.deleteSessions!(shopSessions.map((session) => session.id));
```

Source: `refs/shopify-app-js/packages/apps/shopify-app-express/src/app-installations.ts`

That helper is not D1-specific, but it shows Shopify's intended storage contract:

- list sessions by shop
- delete them all when the installation is gone

### What I did not find

I did not find official guidance saying:

- "run a cron job to purge expired online sessions daily"
- "delete expired offline sessions proactively"
- "keep audit/history rows for old sessions"

So the strongest documented guidance is:

- required: uninstall cleanup
- supported: explicit delete by id or by shop
- app-defined: periodic janitor for old expired rows, if desired

### Practical takeaway for D1

For our D1 implementation:

- we should definitely support `findSessionsByShop(shop)` semantics
- we should definitely delete all rows for a shop on `app/uninstalled`
- we do not need `createdAt` / `updatedAt` to match Shopify's session model
- we may optionally add a janitor later for expired online rows, but that is an app hygiene choice, not the core Shopify contract

## TanStack Start + Effect Perspective

This is the main architectural conclusion for this repo.

### Should we implement Shopify's `SessionStorage` interface directly?

Probably not as the primary abstraction.

Reasons:

- it is Promise-based, while this app is already Effect-first
- it is storage-centric, while our actual workflows are auth-centric and shop-centric
- it pushes `ShopifyApi.Session` to the center of the persistence boundary
- it is mainly designed so Shopify app-framework packages can call `storeSession` / `loadSession`

For this stack, the more idiomatic shape is:

- `Repository`: raw D1 queries over flat session rows
- Effect service: session persistence and lifecycle operations
- Shopify integration layer: token exchange, webhook auth, offline-session refresh, uninstall cleanup

### Why this is already closer to our current architecture

Today the repo already has this shape, even though it is still using the JSON blob storage model.

`src/lib/Repository.ts` is the DB layer.

It currently exposes row-oriented operations such as:

- `findShopifySessionById`
- `upsertShopifySession`
- `deleteShopifySessionsByShop`
- `updateShopifySessionPayload`

Source: `src/lib/Repository.ts`

`src/lib/Shopify.ts` is already acting like an Effect-native session/auth service.

It currently wraps repository access with higher-level operations such as:

- `storeSession`
- `loadSession`
- `deleteSessionsByShop`
- `updateSessionScope`

and uses them inside the admin auth flow.

Source: `src/lib/Shopify.ts`

So the natural direction is not "make Repository implement Shopify's interface".

The natural direction is:

- make Repository better at flat-row persistence
- make the Effect service own Shopify session lifecycle
- optionally add a tiny `SessionStorage` adapter later only if some external Shopify package truly needs it

### Why not couple internal design to Shopify app frameworks

This repo explicitly does not want a React Router dependency.

That means the value of `SessionStorage` here is:

- as a compatibility contract to understand
- as a checklist of useful operations
- as supporting evidence for flat columns and shop-wide cleanup

But not:

- as the main internal abstraction around which TanStack Start + Effect code should be organized

## Recommended Internal Architecture

Two layers only: Repository and Shopify.

### 1. Flat row schema in Domain

Replace the current payload-centric domain model in `src/lib/Domain.ts` with a flat row schema matching the official SQLite column set.

Instead of:

- `payload`
- `createdAt`
- `updatedAt`

the canonical session row should model fields like:

- `id`
- `shop`
- `state`
- `isOnline`
- `scope`
- `expires`
- `accessToken`
- `userId`
- `firstName`
- `lastName`
- `email`
- `accountOwner`
- `locale`
- `collaborator`
- `emailVerified`
- `refreshToken`
- `refreshTokenExpires`

with D1/SQLite-friendly scalar types.

### 2. Repository stays low-level

Repository should expose D1-shaped operations, for example:

- `findShopifySessionById(id)`
- `findShopifySessionsByShop(shop)`
- `upsertShopifySession(row)`
- `deleteShopifySessionById(id)`
- `deleteShopifySessionsByShop(shop)`
- `deleteShopifySessionsByIds(ids)`

This keeps Repository free of Shopify auth workflow decisions.

No separate session-store service. Shopify owns session lifecycle directly.

### 3. Shopify owns both session persistence and auth workflow

`src/lib/Shopify.ts` continues to own everything above Repository.

Session persistence methods (keep on Shopify, not extracted):

- `storeSession(session: ShopifyApi.Session)` — converts to flat row, calls `upsertShopifySession`
- `loadSession(id: string)` — reads flat row, converts seconds back to ms, calls `Session.fromPropertyArray`
- `deleteSessionsByShop(shop: string)` — delegates to Repository
- `updateSessionScope({ id, scope })` — targeted UPDATE via Repository, no load required

Auth workflow methods (unchanged in shape):

- derive offline session id from shop
- load current session for request
- if missing or inactive, do token exchange
- if offline token expired and refresh token exists, refresh it lazily
- delete all sessions for a shop on uninstall
- patch scope on `app/scopes_update`

Internally, the serde boundary lives inside the `storeSession` / `loadSession` pair in Shopify, not in a separate service. `Repository` only sees flat primitive rows.

## Sketch For This Repo

This is not final API design, but it is the shape I would start moving toward.

### Domain

`src/lib/Domain.ts`

Replace the current blob-based `ShopifySession` with a flat row schema:

```ts
export const ShopifySession = Schema.Struct({
  id: ShopifySessionId,
  shop: ShopDomain,
  state: Schema.String,
  isOnline: Schema.Boolean,
  scope: Schema.NullOr(Schema.String),
  expires: Schema.NullOr(Schema.Number),
  accessToken: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.Number),
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  accountOwner: Schema.NullOr(Schema.Boolean),
  locale: Schema.NullOr(Schema.String),
  collaborator: Schema.NullOr(Schema.Boolean),
  emailVerified: Schema.NullOr(Schema.Boolean),
  refreshToken: Schema.NullOr(Schema.String),
  refreshTokenExpires: Schema.NullOr(Schema.Number),
})
```

Remove `ShopifySessionPayload`. No JSON blob columns remain.

The exact `NullOr` vs optional choice should follow what D1 actually returns for nullable columns.

### Repository

`src/lib/Repository.ts`

Move toward methods like:

```ts
findShopifySessionById(id)
findShopifySessionsByShop(shop)
upsertShopifySession(row)
deleteShopifySessionById(id)
deleteShopifySessionsByIds(ids)
deleteShopifySessionsByShop(shop)
```

At this layer, no `ShopifyApi.Session` construction — only flat primitive row values.

Remove `updateShopifySessionPayload`. Scope updates will use a targeted query at this layer.

### Shopify

`src/lib/Shopify.ts` owns both persistence semantics and auth workflow directly.

Session persistence (private to the service):

```ts
const storeSession = (session: ShopifyApi.Session) =>
  // toPropertyArray → map into flat columns → upsertShopifySession

const loadSession = (id: string) =>
  // findShopifySessionById → multiply expiry seconds by 1000 → Session.fromPropertyArray
```

Auth workflow (unchanged in shape):

```ts
const existingSession = yield* loadSession(sessionId)

if (Option.isSome(existingSession) && existingSession.value.isActive(...)) {
  return buildAdminContext(shopify, existingSession.value)
}

const { session } = yield* tokenExchange(...)
yield* storeSession(session)
return buildAdminContext(shopify, session)
```

### Optional Compatibility Adapter

Only if ever needed, add a tiny boundary adapter implementing Shopify's `SessionStorage` interface.

That adapter would wrap Repository-level ops and expose:

- `storeSession`
- `loadSession`
- `deleteSession`
- `deleteSessions`
- `findSessionsByShop`

But it should remain an edge adapter, not the core design.

## One Important D1/SQLite Nuance

The official SQLite adapter converts date values to epoch seconds on write and back to milliseconds on read:

```ts
const entries = session
  .toPropertyArray(true)
  .map(([key, value]) =>
    key === 'expires' || key === 'refreshTokenExpires'
      ? [key, Math.floor((value as number) / 1000)]
      : [key, value],
  );
```

And on load:

```ts
if (row.expires) row.expires *= 1000;
if (row.refreshTokenExpires) row.refreshTokenExpires *= 1000;
return Session.fromPropertyArray(Object.entries(row), true);
```

Source: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts`

For D1, that is the closest official precedent.

So if we want strongest parity with Shopify's SQLite storage model:

- store `expires` and `refreshTokenExpires` as integer epoch seconds
- hydrate with `Session.fromPropertyArray(Object.entries(row), true)` after converting seconds back to milliseconds

## Recommended D1 Table Shape

If we were redesigning this table for D1 with Shopify parity in mind, this is the shape I would anchor on:

```sql
create table if not exists ShopifySession (
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

create index if not exists ShopifySessionShopIndex on ShopifySession (shop);
```

Notes:

- no `createdAt` / `updatedAt`; official SQLite storage does not use them
- `accessToken` nullable matches the official SQLite adapter better than Prisma does
- `scope` as `text` avoids old varchar width issues

## Recommended Read/Write Mental Model

For a custom D1 implementation, the cleanest mental model is:

### Write

1. Start from Shopify `Session`
2. Convert to a flat row
3. Persist columns

Use the SQLite/property-array style, not the Prisma manual-row style, as the primary reference.

### Read

1. Load row by `id`
2. Convert date columns from seconds to milliseconds if using SQLite-style ints
3. Call `Session.fromPropertyArray(Object.entries(row), true)`

That keeps Shopify's own `Session` class as the authority for hydration.

## Practical Recommendation For This Repo

Research conclusion:

- conceptually, the durable Shopify session should be treated as a typed authorization record, not a JSON payload blob
- Shopify's official SQLite adapter is the right reference for D1
- for D1, the official SQLite adapter is the best reference shape
- the template's Prisma schema is only a secondary confirmation of the same flat fields
- Shopify's `SessionStorage` interface is useful as a reference contract, but should not be the primary internal abstraction for a TanStack Start + Effect app

So if we want to move this repo toward Shopify-native session semantics, the direction should be:

1. Replace `payload text` with flat session columns.
2. Keep `id` exactly in Shopify's official formats.
3. Model offline and online rows in the same table.
4. Use SQLite-style integer timestamps for expiry fields.
5. Keep Repository as a low-level D1 row layer with no `ShopifyApi.Session` knowledge.
6. Put session serde and lifecycle directly in Shopify (no separate session-store service).
7. Hydrate/dehydrate through Shopify's `Session` helpers instead of making our JSON blob the source of truth.
8. Delete all sessions for a shop on `app/uninstalled`.
9. Only add a literal `SessionStorage` adapter later if an external Shopify package truly requires it.

## Bottom Line

A Shopify `Session` is the persisted Admin API authorization state for a shop or shop+user.

It is not:

- the App Bridge session token JWT
- a browser cookie session
- an arbitrary app-defined payload blob

If we want to align with Shopify's actual model, the database should store a flat session record with the official session fields, and then reconstruct a `Session` instance from those columns.
