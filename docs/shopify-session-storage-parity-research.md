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

Current implementation in `src/lib/Shopify.ts`:

- `storeShopifySession` does upsert by `id`, persists JSON payload from `session.toPropertyArray(true)`.
  Ref: `src/lib/Shopify.ts:92`
- `loadShopifySession` loads `payload` by `id`, reconstructs with `Session.fromPropertyArray(...)`.
  Ref: `src/lib/Shopify.ts:114`
- `deleteShopifySessionsByShop` deletes all rows by `shop`.
  Ref: `src/lib/Shopify.ts:138`

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

Compared to `SessionStorage` interface, current D1 code implements equivalent behavior for:
- `storeSession` (via `storeShopifySession`)
- `loadSession` (via `loadShopifySession`)

Not currently exposed as interface methods:
- `deleteSession(id)`
- `deleteSessions(ids[])`
- `findSessionsByShop(shop)`

`deleteShopifySessionsByShop(shop)` is not part of Shopify's interface, but template still does delete-by-shop directly at DB layer for uninstall (`db.session.deleteMany({ where: { shop } })`).
Ref: `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:13`

Also, template `SCOPES_UPDATE` updates the current session scope in DB, while port currently deletes all sessions by shop for both `APP_UNINSTALLED` and `APP_SCOPES_UPDATE`.
Refs: `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:11`, `src/routes/webhooks.app.scopes_update.ts:18`

## 6) Locked parity direction

If target is strict template parity, use this split:

1. Implement official `SessionStorage` interface from `@shopify/shopify-app-session-storage` in D1, no Prisma package.
2. Use storage in the same way template/auth stack uses it: primarily `loadSession` and `storeSession` for auth/token exchange flows.
3. Keep webhook DB mutations as direct D1 operations (template does direct Prisma DB operations in webhook routes).
4. Keep `delete by shop` as a direct D1 webhook operation, not part of the `SessionStorage` abstraction.

Clarification on "add queries": this does not mean adding new app-level behavior. It means implementing required methods because the official interface includes them (`deleteSession`, `deleteSessions`, `findSessionsByShop`). They can exist only for interface completeness/compatibility and remain unused by app code if not needed.

## 7) Webhook DB parity status (current)

- `APP_UNINSTALLED`: effectively parity on DB intent (delete sessions for shop), implemented in D1 via `deleteShopifySessionsByShop`.
  Refs: `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:13`, `src/routes/webhooks.app.uninstalled.ts:18`
- `APP_SCOPES_UPDATE`: not parity today.
  - Template updates scope for the authenticated offline session row (`where: { id: session.id }`).
    Ref: `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:11`
  - Port currently deletes all sessions for shop.
    Ref: `src/routes/webhooks.app.scopes_update.ts:18`

So yes: webhook DB ops are not fully parity today; `SCOPES_UPDATE` is the concrete mismatch.
