# Shopify session storage parity research (`refs/shopify-app-template` -> D1)

Goal: confirm how template performs session DB queries, where `SessionStorage` interface fits, and how current D1 port maps.

## 1) What template does

Template wires Shopify auth to Prisma-backed session storage:

```ts
// refs/shopify-app-template/app/shopify.server.ts
sessionStorage: new PrismaSessionStorage(prisma),
```

Ref: `refs/shopify-app-template/app/shopify.server.ts:17`

Template also exports `sessionStorage = shopify.sessionStorage`, but route code rarely calls it directly.
Ref: `refs/shopify-app-template/app/shopify.server.ts:34`

### Direct DB queries in template webhook routes

Template webhooks use Prisma model queries directly (not `sessionStorage.*`):

```ts
// refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx
if (session) {
  await db.session.deleteMany({ where: { shop } });
}
```

Ref: `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:12`

```ts
// refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx
if (session) {
  await db.session.update({
    where: { id: session.id },
    data: { scope: current.toString() },
  });
}
```

Ref: `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:10`

## 2) The session storage interface (yes, it exists)

`@shopify/shopify-app-session-storage` defines this contract:

```ts
// refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/src/types.ts
export interface SessionStorage {
  storeSession(session: Session): Promise<boolean>;
  loadSession(id: string): Promise<Session | undefined>;
  deleteSession(id: string): Promise<boolean>;
  deleteSessions(ids: string[]): Promise<boolean>;
  findSessionsByShop(shop: string): Promise<Session[]>;
}
```

Ref: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/src/types.ts:6`

Package README confirms all storage adapters implement this interface.
Ref: `refs/shopify-app-js/packages/apps/session-storage/README.md:5`

Important for dependency concern: the core interface package is lightweight and does not pull Prisma.

```json
// refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/package.json
"dependencies": {},
"peerDependencies": {
  "@shopify/shopify-api": "^13.0.0"
}
```

Ref: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage/package.json:46`

## 3) How template/auth internals use the interface

In `shopify-app-react-router`, admin auth loads/stores via `config.sessionStorage`:

```ts
// authenticate.admin
const existingSession = sessionId
  ? await config.sessionStorage!.loadSession(sessionId)
  : undefined;
```

Ref: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts:168`

```ts
// token exchange strategy
await config.sessionStorage!.storeSession(offlineSession);
...
await config.sessionStorage!.storeSession(onlineSession);
```

Ref: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts:113`

So practical pattern is:
- `loadSession(sessionId)` during request auth.
- `storeSession(...)` after token exchange/refresh.
- webhook cleanup/update can be done directly with DB model (template does this).

## 4) Current D1 port mapping

Current implementation now uses official `SessionStorage` contract in D1:

- `ShopifyD1SessionStorage implements SessionStorage`.
  Ref: `src/lib/Shopify.ts:93`
- Interface methods implemented in D1 payload-table model:
  - `storeSession`
  - `loadSession`
  - `deleteSession`
  - `deleteSessions`
  - `findSessionsByShop`
  Ref: `src/lib/Shopify.ts:100`
- `createShopifySessionStorage(env)` is the factory used by auth flow.
  Ref: `src/lib/Shopify.ts:172`
- `authenticateAdmin` now calls `sessionStorage.loadSession` and `sessionStorage.storeSession`, matching template usage pattern.
  Ref: `src/lib/Shopify.ts:360`
- Direct D1 helper for uninstall remains explicit (`delete by shop`), outside `SessionStorage`.
  Ref: `src/lib/Shopify.ts:195`

Table schema is compact payload model:

```sql
create table if not exists ShopifySession (
  id text primary key,
  shop text not null,
  payload text not null,
  createdAt text not null default (datetime('now')),
  updatedAt text not null default (datetime('now'))
);
create index if not exists idx_ShopifySession_shop on ShopifySession (shop);
```

Ref: `migrations/0001_init.sql:1`

## 5) Parity notes / gaps

Status after implementation:

- Interface parity: done.
- Dependency posture: done (`@shopify/shopify-app-session-storage` only; no Prisma adapter).
  Ref: `package.json:65`
- Auth usage parity: done (`loadSession`/`storeSession` path).
  Ref: `src/lib/Shopify.ts:362`, `src/lib/Shopify.ts:376`
- Direct webhook DB operations: kept (D1 helper for delete by shop).
  Ref: `src/lib/Shopify.ts:195`

## 6) Webhook DB parity status (current)

- `APP_UNINSTALLED`: parity on DB intent.
  - Template: `db.session.deleteMany({ where: { shop } })`
    Ref: `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:13`
  - Port: `deleteShopifySessionsByShop({ env, shop: result.domain })`
    Ref: `src/routes/webhooks.app.uninstalled.ts:18`

- `APP_SCOPES_UPDATE`: parity on DB intent now.
  - Template: update scope for current session row (`where: { id: session.id }`).
    Ref: `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:11`
  - Port: update scope for shop offline session id (`shopify.session.getOfflineId(result.domain)` + `updateShopifySessionScope`).
    Refs: `src/routes/webhooks.app.scopes_update.ts:24`, `src/lib/Shopify.ts:207`

Result: session storage and webhook DB behavior now follow the same template split: auth through `SessionStorage`, webhook mutations through direct DB operations.
