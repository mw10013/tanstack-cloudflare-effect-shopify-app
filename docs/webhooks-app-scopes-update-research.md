# `app/scopes_update` Webhook Research

## Problem It Solves

Shopify's session model stores the granted access scopes alongside the access token in `ShopifySession.payload`. When a merchant's granted scopes change — either because the app requested new scopes and the merchant approved, or because the app reduced scopes — the stored session scope goes stale. The `app/scopes_update` webhook fires on every such change so the app can sync the stored scope to reality.

**`refs/shopify-docs/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes.md` (lines 88–106):**
> Subscribe to the `app/scopes_update` topic to receive webhooks when the granted scopes are updated.
> - `scopes` field change (increase): merchant is prompted to approve → webhook fires on approval
> - `scopes` field change (decrease): no prompt, webhook fires when merchant opens app
> - `optional_scopes` change: webhook fires when merchant approves a dynamic scope request

**`refs/shopify-docs/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic.md` (line 59):**
> APP_SCOPES_UPDATE: "Occurs whenever the access scopes of any installation are modified. Allows apps to keep track of the granted access scopes of their installations."

## What Happens Without It

The session's `scope` field in `ShopifySession.payload` diverges from the actual granted scopes. The `Session.isScopeIncluded()` check (used during auth to detect scope drift and trigger re-auth) reads from this stored scope:

**`refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts` (lines 224–229):**
```ts
public isScopeIncluded(scopes: AuthScopes | string | string[]): boolean {
  const requiredScopes =
    scopes instanceof AuthScopes ? scopes : new AuthScopes(scopes);
  const sessionScopes = new AuthScopes(this.scope);
  return sessionScopes.has(requiredScopes);
}
```

Without the webhook handler keeping `scope` current, `isScopeIncluded()` compares against stale data. Consequences:
- **Increased scopes not updated**: app may skip re-auth even though the newly approved scope isn't reflected, causing it to behave as if the scope wasn't granted
- **Decreased scopes not updated**: app may try to use a scope it no longer has, resulting in API errors

## Implementation Deep Dive

### Payload

The webhook delivers a JSON body with a `current` array of scope strings (the newly active scopes). The payload is validated with Effect Schema:

```ts
const ScopesUpdatePayload = Schema.Struct({
  current: Schema.Array(Schema.String),
});

const payload = yield* Schema.decodeUnknownEffect(ScopesUpdatePayload)(
  JSON.parse(result.rawBody),
);
```

`current` is required (not optional). The webhook fires specifically because scopes changed, so `current` — the new set of granted scopes — is always present (empty array if all revoked, never absent). This aligns with the template, which also treats it as required (`payload.current as string[]`, no optional guard).

`Schema.Struct` is loose by default — extra fields in the webhook body pass through without error.

A malformed payload (missing or wrong-typed `current`) fails the effect with `SchemaError`. This propagates through `makeRunEffect` (`src/worker.ts:61`), which is generic over `E` and handles all errors via `Cause.squash` — result is a thrown exception and a 500 response. Shopify retries on non-2xx, so this is the correct failure mode. `Effect.orDie` is not needed since `makeRunEffect` accepts any error type in the E channel.

### `offlineSessionId` (`src/lib/Shopify.ts:431`)

```ts
const offlineSessionId = (shop: string) =>
  Effect.succeed(shopify.session.getOfflineId(shop));
```

Thin wrapper around `shopify.session.getOfflineId(shop)`. Shopify offline session IDs follow the format `offline_${shop}` (e.g. `offline_my-shop.myshopify.com`). The webhook's `domain` header (extracted by `validateWebhook`) is the shop domain, so this maps it to the correct session key. Online session IDs are per-user and not relevant here — the offline session is what holds the persistent access token used by background jobs and webhook processing.

### `updateSessionScope` (`src/lib/Shopify.ts:225–254`)

```ts
const updateSessionScope = Effect.fn("Shopify.updateSessionScope")(
  function* ({ id, scope }: { id: string; scope: string }) {
    const row = yield* d1.first<{ payload: string }>(
      d1.prepare("select payload from ShopifySession where id = ?1").bind(id),
    );
    if (Option.isNone(row)) {
      return;
    }
    const sessionOption = yield* decodeSessionPayload(row.value.payload).pipe(
      Effect.map(Option.some),
      Effect.catchTag("ShopifyError", () => Effect.succeed(Option.none())),
    );
    if (Option.isNone(sessionOption)) {
      return;
    }
    sessionOption.value.scope = scope;
    yield* d1.run(
      d1.prepare(
        "update ShopifySession set payload = ?1, updatedAt = datetime('now') where id = ?2",
      ).bind(
        JSON.stringify(sessionOption.value.toPropertyArray(true)),
        id,
      ),
    );
  },
);
```

Steps:
1. **Load** — fetch the row by `id`; bail silently if not found (shop may have been uninstalled)
2. **Decode** — `decodeSessionPayload` deserializes the stored JSON into a `Session` object; any decode error is treated as a no-op (session may be corrupt/migrated)
3. **Mutate** — set `session.scope = scope` directly on the `Session` instance
4. **Persist** — re-serialize via `toPropertyArray(true)` (the `true` flag includes the access token) and write back with an updated `updatedAt` timestamp

`scope` is stored inside `payload` as part of the serialized session, not as a dedicated column. The DB schema (`migrations/0001_init.sql`) has `payload text not null` — scope is not queryable independently.

**`refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts` (line 168):**
```ts
public scope?: string;
// "The desired scopes for the access token, at the time the session was created."
```

The conversion from `string[]` → `string` uses `payload.current.toString()` which produces a comma-separated string (e.g. `"read_products,write_orders"`), matching Shopify's internal scope format.

## Payload Schema Drift

### The library

Session serialization is owned entirely by `@shopify/shopify-api` v13.0.0 (pinned exactly — no `^` or `~` in `package.json`). The `Session` class in this package provides:
- `toPropertyArray(returnUserData: boolean): [string, string | number | boolean][]` — serializes to a key-value pair array
- `static fromPropertyArray(entries, returnUserData): Session` — deserializes back

We store `JSON.stringify(session.toPropertyArray(true))` and restore via `Session.fromPropertyArray(JSON.parse(payload), true)`.

### How official adapters handle this differently

The official `shopify-app-session-storage-sqlite` (`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts`) uses **flat columns** — one column per session field — and has a **built-in migration system**:

```ts
// storeSession: flat INSERT with dynamic column list from toPropertyArray
const entries = session.toPropertyArray(true).map(...)
const query = `INSERT OR REPLACE INTO ${table} (${entries.map(([key]) => key).join(', ')}) VALUES (...)`

// loadSession: SELECT * → Object.entries(row) → fromPropertyArray
return Session.fromPropertyArray(Object.entries(rawResult), true);
```

The official Prisma adapter (`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-prisma/src/prisma.ts`) also uses flat columns with manual `sessionToRow`/`rowToSession` mapping.

Neither official adapter uses a JSON blob. Both require DB schema migrations when the `Session` field set changes.

### Historical migrations prove drift happens

The SQLite adapter has shipped 3 migrations (`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/migrations.ts`):

1. **`migrateScopeFieldToVarchar1024`** — `scope` column changed from `varchar(255)` to `varchar(1024)` (scopes can be long)
2. **`addRefreshTokenFields`** — added `refreshToken` and `refreshTokenExpires` columns
3. **`addUserInfoColumns`** — replaced a single `onlineAccessInfo` column (JSON blob) with individual columns: `userId`, `firstName`, `lastName`, `email`, `accountOwner`, `locale`, `collaborator`, `emailVerified`

Migration 3 is directly analogous to our approach: Shopify previously stored `onlineAccessInfo` as a blob and had to migrate to individual fields. We store the entire session as a blob.

### Drift scenarios for our blob

| Change in SDK | Flat columns (official) | Our blob |
|---|---|---|
| New field added to `propertiesToSave` | **Breaking** — INSERT fails on missing column; needs `ALTER TABLE` migration | **Safe** — blob grows, `fromPropertyArray` reads new field, old blobs just lack the field (undefined) |
| Field renamed | **Breaking** — migration needed | **Breaking** — old blobs have old key name; `fromPropertyArray` switch won't match; field silently lost |
| Encoding change (e.g. `expires` format) | **Breaking** — migration needed | **Breaking** — old blobs have old encoding; deserializes to wrong value silently |
| `onlineAccessInfo` blob → individual fields | Required migration 3 above | Already resolved: we pass `returnUserData=true` which already expands it to individual pairs |

Our blob approach is strictly better only for additive changes. For renames or encoding changes it's equally breaking but **harder to detect** — no DB error, just silent data loss.

### Recovery: hard failures self-heal

`decodeSessionPayload` wraps `Session.fromPropertyArray` in `tryShopify`. If the new SDK throws `InvalidSession` on a stale blob, the error becomes a `ShopifyError`, which `loadSession` catches (`Effect.catchTag("ShopifyError", ...)`) and converts to `Option.none()`. Auth sees no session → OAuth redirect → `storeSession` writes a fresh blob in the new format. The dead row is overwritten and the merchant continues normally.

Silent corruption (wrong values without a throw) cannot be detected at runtime — the session appears valid but carries bad data. This is why the exact version pin is the primary mitigation.

### Upgrade procedure

`"@shopify/shopify-api": "13.0.0"` — exact pin, no range. Before bumping the version, audit:

```
node_modules/@shopify/shopify-api/lib/session/session.ts
```

Specifically:
- `propertiesToSave` array — new or removed fields
- `toPropertyArray` switch cases — encoding changes (e.g. how `expires` is stored)
- `fromPropertyArray` switch cases — key normalization or type coercion changes

If any of these changed, add a D1 migration file (e.g. `migrations/XXXX_clear_sessions.sql`) with:

```sql
delete from ShopifySession;
```

All merchants will re-authenticate on next app open and receive a fresh blob in the current format. This is safe — Shopify embedded apps re-auth transparently via OAuth redirect.

## Alignment with Refs

### `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx`

```ts
const current = payload.current as string[];
if (session) {
  await db.session.update({
    where: { id: session.id },
    data: { scope: current.toString() },
  });
}
return new Response();
```

The template uses Prisma with `scope` as a dedicated DB column. The logic is otherwise identical: extract `current`, call `.toString()`, write to `session.scope`. Our implementation is equivalent — differing only in storage mechanism (embedded in `payload` JSON vs. dedicated column) and effect plumbing.

**Key difference**: the template relies on `authenticate.webhook()` resolving the session directly and guards on `if (session)`. Our implementation uses `offlineSessionId` + explicit lookup and guards with `Option.isNone` — functionally equivalent, adapted to our D1/Effect stack.

### `refs/shopify-app-template/shopify.app.toml` (lines 16–19)

```toml
# Handled by: /app/routes/webhooks.app.scopes_update.tsx
[[webhooks.subscriptions]]
topics = [ "app/scopes_update" ]
uri = "/webhooks/app/scopes_update"
```

Our TOML should mirror this. The handler at `/webhooks/app/scopes_update` matches the file route `webhooks.app.scopes_update.ts`.
