# Shopify session conversion research

Scope: evaluate replacing `sessionToRow` / `rowToSession` in `src/lib/Shopify.ts:166` and `src/lib/Shopify.ts:173`, and simplify `storeSession` / `loadSession` in `src/lib/Shopify.ts:241` and `src/lib/Shopify.ts:246`.

## Ground truth from `refs/shopify-app-js`

### 1) Session APIs that actually exist

`Session` exposes:

- `toObject()`
- `toPropertyArray(returnUserData?)`
- `Session.fromPropertyArray(entries, returnUserData?)`
- `new Session(params)`

Refs:

- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:25`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:190`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:245`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:300`

There is no `fromProperties` helper in this library.

### 2) What `toPropertyArray(true)` and `fromPropertyArray(..., true)` already do

`toPropertyArray(true)`:

- converts `expires` / `refreshTokenExpires` to epoch milliseconds
- expands `onlineAccessInfo.associated_user` into flat keys (`userId`, `firstName`, `lastName`, `email`, `locale`, `emailVerified`, `accountOwner`, `collaborator`)

Refs:

- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:314`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:318`

`fromPropertyArray(entries, true)`:

- normalizes keys (`isOnline`, `accessToken`, `refreshToken`, etc.)
- converts `isOnline` from string/number/bool to boolean
- converts `expires` / `refreshTokenExpires` from epoch milliseconds to `Date`
- reconstructs `onlineAccessInfo.associated_user.*` from flat user fields when `returnUserData = true`

Refs:

- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:39`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:73`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:85`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:98`

### 3) How official storage adapters map rows

Relational adapters (flattened columns) commonly load like this after timestamp normalization:

```ts
return Session.fromPropertyArray(Object.entries(row), true);
```

Refs:

- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts:150`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-mysql/src/mysql.ts:181`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-postgresql/src/postgresql.ts:181`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-prisma/src/prisma.ts:198`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-drizzle/src/adapters/drizzle-sqlite.adapter.ts:124`

Document/JSON-style adapters store object form and reconstruct via constructor:

- `session.toObject()` + `new Session(result)` (MongoDB)
- `session.toObject()` + `new Session({...date hydration...})` (DynamoDB)

Refs:

- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-mongodb/src/mongodb.ts:48`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-mongodb/src/mongodb.ts:61`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-dynamodb/src/dynamodb.ts:105`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-dynamodb/src/dynamodb.ts:118`

## Fit for this repo

Current D1 schema is flattened (`userId`, `firstName`, `accountOwner`, etc.) and stores integer timestamp columns:

- `migrations/0001_init.sql:1`

That shape matches the relational adapter pattern, not the document/JSON pattern.

## Recommendation

### `storeSession`

Inline `repository.upsertSession({...})` inside `storeSession` and build the `Domain.Session` payload directly.

Good source for fields: `session.toPropertyArray(true)` because it already flattens user data exactly to your table columns.

Still needed inline conversions for this schema:

- booleans to ints (`isOnline`, `accountOwner`, `collaborator`, `emailVerified`)
- keep `expires` / `refreshTokenExpires` in milliseconds (Shopify-native)
- undefined to null for nullable DB columns

### `loadSession`

Use `ShopifyApi.Session.fromPropertyArray(..., true)` directly (this is the closest thing to "fromProperties").

Before calling it: drop `null` values from entries (method accepts string/number/boolean entries).

This aligns with Shopify adapters and lets Shopify own session reconstruction semantics.

## Minimal target shape (example)

```ts
const loadSession = Effect.fn("Shopify.loadSession")(function* (id: Domain.Session["id"]) {
  const storedSession = yield* repository.findSessionById(id);
  if (Option.isNone(storedSession)) return Option.none();
  const entries = Object.entries(storedSession.value).filter(
    (entry): entry is [string, string | number] => entry[1] !== null,
  );

  return Option.some(ShopifyApi.Session.fromPropertyArray(entries, true));
});
```

Net: yes, your instinct matches Shopify internals. For your schema, `fromPropertyArray(..., true)` is the intended reconstruction path; `new Session(params)` is better when persistence format is `toObject()`-like JSON.
