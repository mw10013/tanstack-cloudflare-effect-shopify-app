# Session naming + mapping research

## Scope

Questions from request:

1. Is it OK that our domain `ShopifySession` has fewer/different properties than Shopify's `Session` object?
2. What is the best way to map **Shopify API `Session` -> domain row -> Shopify API `Session`**?
3. Should we rename domain `ShopifySession` to `Session`?
4. Should we also rename DB table `ShopifySession` to `Session`?

## Repo status now

Current domain row shape is explicit/flat in `src/lib/Domain.ts:13`:

```ts
export const ShopifySession = Schema.Struct({
  id, shop, state, isOnline, scope, expires, accessToken,
  userId, firstName, lastName, email, accountOwner,
  locale, collaborator, emailVerified, refreshToken, refreshTokenExpires,
});
```

Current bidirectional mapping already exists in `src/lib/Shopify.ts`:

- `sessionToRow(session)` uses `session.toPropertyArray(true)` then decodes to `Domain.ShopifySession` (`src/lib/Shopify.ts:166-171`)
- `rowToSession(row)` encodes back and calls `ShopifyApi.Session.fromPropertyArray(..., true)` (`src/lib/Shopify.ts:173-182`)

DB table matches this flat shape in `migrations/0001_init.sql:1-19` (`ShopifySession` with same 17 columns).

## Shopify docs + source findings

### 1) Shopify canonical object is `Session`

Shopify docs (`shopify-app-react-router` API docs) define:

- `Session` fields: `id`, `shop`, `state`, `isOnline`, `scope`, `expires`, `accessToken`, `refreshToken`, `refreshTokenExpires`, `onlineAccessInfo`
- `toPropertyArray(returnUserData?)`
- `fromPropertyArray(...)`

Reference: `refs/shopify-docs/docs/api/shopify-app-react-router/v1/entrypoints/shopifyapp.md:666-804`.

Shopify source matches this exactly. `propertiesToSave` in the SDK session class:

`refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:8-19`

```ts
const propertiesToSave = [
  'id', 'shop', 'state', 'isOnline', 'scope', 'accessToken',
  'expires', 'refreshToken', 'refreshTokenExpires', 'onlineAccessInfo',
];
```

### 2) Shopify expects custom storage to store/load `Session`

`SessionStorage` interface contract is directly `Session` in/out:

`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/src/types.ts:6-41`

```ts
storeSession(session: Session): Promise<boolean>
loadSession(id: string): Promise<Session | undefined>
findSessionsByShop(shop: string): Promise<Session[]>
```

### 3) Official adapters flatten/rehydrate; they do not persist every in-memory detail

SQLite adapter table is flat columns (`id`, `shop`, `state`, `isOnline`, `...`, `refreshTokenExpires`):

`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts:126-144`

And hydration path is canonical `Session.fromPropertyArray(Object.entries(row), true)`:

`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts:150-155`.

Prisma adapter does the same conceptual mapping (`sessionToRow` / `rowToSession`):

- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-prisma/src/prisma.ts:167-196`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-prisma/src/prisma.ts:198-244`

So: having a storage/domain shape that differs from runtime class internals is normal.

### 4) Shopify `SessionParams` allows extra properties

`SessionParams` includes an index signature:

`refs/shopify-app-js/packages/apps/shopify-api/lib/session/types.ts:46-49`

```ts
[key: string]: any;
```

But persistence is still controlled by `toPropertyArray` and adapter mappings. This supports your intuition: Shopify runtime session may carry more than your row model; row model still can be correct.

### 5) Naming conventions in Shopify ecosystem are mixed

- Runtime/domain object is always named `Session`.
- Prisma model default is `Session` (`refs/shopify-app-template/prisma/schema.prisma:16`).
- SQLite adapter default table name is `shopify_sessions` (`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts:15`).
- Prisma adapter supports custom table names (`tableName` option in README: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-prisma/README.md:53-61`).

Conclusion: object name and physical table name are intentionally decoupled in Shopify's own packages.

## Trade-offs

## Option A: Keep `Domain.ShopifySession` + table `ShopifySession`

Pros:

- Maximum explicitness in app code (`Domain.ShopifySession` reads as "our persisted Shopify auth row").
- Zero migration and low churn.
- Avoids any possible confusion with other frameworks' "session" concepts.

Cons:

- Verbose to discuss (`domain ShopifySession` vs `ShopifyApi.Session`).
- Slight naming drift from Shopify SDK/docs (`Session`).

## Option B: Rename domain type to `Session`, keep table name

Pros:

- Best language match to Shopify docs/source (`Session`).
- Cleaner conversation: "domain `Session` row" vs "Shopify API `Session` object".
- No data migration needed.

Cons:

- Refactor churn in code identifiers/imports.
- In some files you must stay explicit via namespaces (`Domain.Session` vs `ShopifyApi.Session`).

## Option C: Rename domain type + rename table to `Session`

Pros:

- End-to-end naming consistency.

Cons:

- Requires SQL migration and coordinated updates across repository queries.
- Higher risk than value; no runtime behavior gain.
- Shopify's own adapters do not require object name == table name.

## Recommendation

Recommend **Option C** when DB reset is acceptable:

1. Rename domain object to `Session` (and `SessionId`) in `Domain.ts`.
2. Rename DB table to `Session` and keep SQL/query names in sync.
3. Keep conversion boundary explicit as two pure functions (`shopifySessionToDomainSession`, `domainSessionToShopifySession`) using the canonical pair:
   - `session.toPropertyArray(true)`
   - `ShopifyApi.Session.fromPropertyArray(..., true)`

Why this is the best balance in reset scenarios:

- Aligns naming across domain and persistence.
- Aligns with Shopify's canonical runtime naming.
- Removes migration-risk concerns because data reset is already accepted.

## Mapping guidance (important)

- Keep accepting that domain row stores only persistence-relevant fields.
- Do not treat "missing non-persisted Shopify object details" as correctness issue.
- Keep refresh token fields in mapping/storage; Shopify docs require this for expiring offline tokens (`refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md:210-217`).

## If you still want table rename later

Do it as a separate migration-only change, after naming settles:

1. create new table
2. copy data
3. swap reads/writes
4. remove old table

Treat as operational change, not domain-model change.
