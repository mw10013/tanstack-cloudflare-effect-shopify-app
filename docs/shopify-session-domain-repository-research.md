# ShopifySession Domain + Repository research

## Scope

Research goals from request:

1. Should we add a `Domain` and `Repository` for `ShopifySession`?
2. Should `src/lib/Shopify.ts` stop making low-level D1 calls directly?
3. Do we need a `SchemaEx.ts`-style helper?
4. What is the safest way to handle the tricky `payload` column?

## Current state in this repo

`ShopifySession` table is compact and blob-based:

`migrations/0001_init.sql:1`

```sql
create table if not exists ShopifySession (
  id text primary key,
  shop text not null,
  payload text not null,
  createdAt text not null default (datetime('now')),
  updatedAt text not null default (datetime('now'))
);
```

Low-level SQL currently lives inside `Shopify` service:

- `src/lib/Shopify.ts:202` insert/upsert row
- `src/lib/Shopify.ts:219` load `payload` by id
- `src/lib/Shopify.ts:232` delete by `shop`
- `src/lib/Shopify.ts:257` update `payload`

Serialization strategy already used:

- write: `JSON.stringify(session.toPropertyArray(true))` (`src/lib/Shopify.ts:213`)
- read: `JSON.parse(payload)` then `Session.fromPropertyArray(..., true)` (`src/lib/Shopify.ts:120`, `src/lib/Shopify.ts:130`)

## `refs/tces` patterns (Domain + Repository + SchemaEx)

### Domain pattern

`refs/tces/src/lib/Domain.ts` centralizes runtime schemas and inferred types:

`refs/tces/src/lib/Domain.ts:88`

```ts
export const User = Schema.Struct({
  id: Schema.NonEmptyString.pipe(Schema.brand("UserId")),
  ...
});
export type User = typeof User.Type;
```

Also includes db-shape transforms (example int -> boolean, string -> Date):

`refs/tces/src/lib/Domain.ts:11`

```ts
const intToBoolean = Schema.Int.pipe(Schema.decodeTo(Schema.Boolean, ...));
```

### Repository pattern

`refs/tces/src/lib/Repository.ts` is a service that:

1. depends on `D1`
2. keeps SQL in one place
3. decodes rows via Domain schemas before returning

`refs/tces/src/lib/Repository.ts:7`

```ts
export class Repository extends Context.Service<Repository>()("Repository", {
  make: Effect.gen(function* () {
    const d1 = yield* D1;
    ...
  }),
})
```

Typical method shape:

`refs/tces/src/lib/Repository.ts:13`

```ts
const result = yield* d1.first(...);
return yield* Effect.fromOption(result).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Domain.User)),
);
```

### `SchemaEx.ts` usage pattern

`SchemaEx` is mostly for SQL that returns JSON blobs in a `{ data: string }` envelope, then decode that JSON:

`refs/tces/src/lib/SchemaEx.ts:50`

```ts
export const JsonDataField = <S extends Schema.Top>(DataSchema: S) =>
  Schema.Struct({ data: Schema.String }).pipe(
    pluck("data"),
    Schema.decodeTo(Schema.fromJsonString(DataSchema)),
  );
```

Repository uses this mainly with `json_object(...) as data` queries.

## Shopify official behavior (docs + source)

### Session contract and serialization format

Shopify `Session` persists key fields through `toPropertyArray`:

`refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:8`

```ts
const propertiesToSave = [
  'id', 'shop', 'state', 'isOnline', 'scope', 'accessToken',
  'expires', 'refreshToken', 'refreshTokenExpires', 'onlineAccessInfo',
];
```

And hydrates back with `fromPropertyArray`:

`refs/shopify-app-js/packages/apps/shopify-api/lib/session/session.ts:25`

```ts
public static fromPropertyArray(
  entries: [string, string | number | boolean][],
  returnUserData = false,
): Session
```

Shopify API docs expose same method signature:

`refs/shopify-docs/docs/api/shopify-app-react-router/v1/entrypoints/shopifyapp.md:798`

```ts
(returnUserData?: boolean) => [string, string | number | boolean][]
```

### Storage adapter split: relational vs schemaless

Relational adapters flatten fields into columns and run migrations when SDK/session shape changes.

Example SQLite create table with many explicit columns:

`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/sqlite.ts:126`

```sql
CREATE TABLE ... (
  id, shop, state, isOnline, expires, scope, accessToken,
  userId, firstName, ..., refreshToken, refreshTokenExpires
)
```

Example migration file adding fields over time:

`refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-sqlite/src/migrations.ts:10`

```ts
new MigrationOperation('addRefreshTokenFields', addRefreshTokenFields)
new MigrationOperation('addUserInfoColumns', addUserInfoColumns)
```

MySQL/PostgreSQL READMEs explicitly call out automatic schema migrations for expiring offline tokens:

- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-mysql/README.md:43`
- `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-postgresql/README.md:57`

Schemaless adapters (KV/Redis) store JSON of `toPropertyArray(true)` and avoid DB schema migrations:

- KV stores `JSON.stringify(session.toPropertyArray(true))`: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-kv/src/kv.ts:20`
- Redis stores same pattern: `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-redis/src/redis.ts:95`
- KV README: "No migration or schema changes are required ... JSON serialization": `refs/shopify-app-js/packages/apps/session-storage/shopify-app-session-storage-kv/README.md:43`

### Shopify docs: expiring offline tokens require storage changes

`refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md:210`

Step 1 says update session storage to persist expiration + refresh token metadata.

This reinforces: whichever storage style we choose, it must preserve `refreshToken` and `refreshTokenExpires`.

## Template pattern (`refs/shopify-app-template`)

Template uses Prisma adapter in central config:

`refs/shopify-app-template/app/shopify.server.ts:17`

```ts
sessionStorage: new PrismaSessionStorage(prisma)
```

Prisma schema has explicit session columns, including refresh token fields:

`refs/shopify-app-template/prisma/schema.prisma:16`

```prisma
model Session {
  id String @id
  ...
  refreshToken        String?
  refreshTokenExpires DateTime?
}
```

Webhook routes perform direct DB updates/deletes on session rows (not through auth helper methods):

- `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:13`
- `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:11`

## Recommendation for this repo

### 1) Use broad names: `Domain.ts` and `Repository.ts`

Yes. Keep names broad so they scale with future tables/types.

This is also exactly the `refs/tces` pattern:

- `refs/tces/src/lib/Domain.ts:77`
- `refs/tces/src/lib/Repository.ts:7`

Suggested split:

- `src/lib/Domain.ts`
  - add domain schemas following `refs/tces` style (`User`, `Session`, `Organization`)
  - for `ShopifySession`, model persisted fields we actually store (`id`, `shop`, `payload`, `createdAt`, `updatedAt`)
  - add `ShopifySessionId` / `ShopDomain` brands if helpful
  - keep `payload` as opaque `Schema.String` in domain for now
  - keep room for future domain schemas in same file (or future `*Domain.ts` modules if it grows)
- `src/lib/Repository.ts`
  - add `upsertShopifySession(session: ShopifyApi.Session)`
  - add `findShopifySessionById(id: string)` -> `Option<ShopifyApi.Session>`
  - add `deleteShopifySessionsByShop(shop: string)`
  - add `updateShopifySessionScope({ id, scope })`
  - add future repository methods for other tables in same service

Then `Shopify.ts` focuses on auth/webhook orchestration, not SQL strings.

### 2) Keep payload as the canonical JSON string of `toPropertyArray(true)`

Yes, keep this as canonical payload format.

Why:

- matches Shopify KV/Redis adapters exactly
- naturally carries newly added session fields without table migrations
- avoids re-implementing Shopify internal field map logic

Use `Session.fromPropertyArray` as the only decode path, and `session.toPropertyArray(true)` as the only encode path.

### 3) Do not model payload as a rigid object schema

Avoid a strict custom object schema for payload fields (`{ accessToken, scope, ... }`) as source of truth.

Reason:

- Shopify evolves saved fields (`propertiesToSave` in SDK)
- strict object schemas create drift risk and migration churn
- `fromPropertyArray` already handles coercion and key normalization

If route/service code needs typed pieces, decode to `Session` first, then read properties from `Session` (or from `session.toObject()`).

### 4) `SchemaEx.ts` decision

Likely **not needed initially**.

Rationale:

- `SchemaEx.JsonDataField` in `refs/tces` solves a different pattern (`json_object(...) as data` then decode JSON text)
- `ShopifySession` workload is simple row read/write with one `payload` text field
- a small local payload codec in Domain or Repository is enough

Add a `SchemaEx`-style helper only if you later introduce many SQL JSON aggregation queries.

## Proposed implementation shape (minimal, incremental)

1. Add `src/lib/Domain.ts` with DB-aligned `ShopifySession` domain model (no `*Row` naming).
2. Add `src/lib/Repository.ts` service (Context.Service + Layer) with ShopifySession methods first.
3. Move SQL from `src/lib/Shopify.ts` into repository methods.
4. Keep current table shape (`id`, `shop`, `payload`, timestamps) and behavior.
5. Keep current self-heal behavior on bad payload (decode failure -> `Option.none()` -> re-auth flow).

## Effect v4 Schema research for `payload`

Scanned `refs/effect4` for the best Schema-first way to parse the session payload.

### What Effect v4 gives us directly

`fromJsonString` is exactly the primitive for "payload column is JSON text":

`refs/effect4/packages/effect/src/Schema.ts:8963`

```ts
Returns a schema that decodes a JSON string and then decodes the parsed value using the given schema.
```

And `SchemaTransformation.fromJsonString` uses `JSON.parse` / `JSON.stringify` under the hood:

`refs/effect4/packages/effect/src/SchemaTransformation.ts:1455`

```ts
- Decode: calls `JSON.parse`. Fails if the string is not valid JSON.
- Encode: calls `JSON.stringify`.
```

So we can replace manual `JSON.parse(payload)` with a Schema codec pipeline.

### Important typing detail: arrays/tuples are readonly by default

Effect v4 array and tuple schemas infer readonly output by default:

- `Schema.Array` defines `ReadonlyArray`: `refs/effect4/packages/effect/src/Schema.ts:3209`
- `Schema.Tuple` docs show fixed tuple constructor and readonly tuple typing machinery: `refs/effect4/packages/effect/src/Schema.ts:3053`

But Shopify `Session.fromPropertyArray` expects mutable `entries: [string, string | number | boolean][]`.

Effect v4 has `Schema.mutable` to remove readonly from arrays/tuples:

`refs/effect4/packages/effect/src/Schema.ts:3392`

```ts
Makes an array or tuple schema mutable, removing the `readonly` modifier.
```

This means we can get the exact Shopify parameter type without `as` casts.

### Optional future payload schema (if we later type payload entries)

```ts
const ShopifySessionEntry = Schema.mutable(
  Schema.Tuple([
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  ]),
)

const ShopifySessionEntriesFromJson = Schema.fromJsonString(
  Schema.mutable(Schema.Array(ShopifySessionEntry)),
)
```

If adopted later, decode path becomes:

1. payload text -> JSON parse + structural validation via `Schema.decodeUnknownEffect(ShopifySessionEntriesFromJson)(payload)`
2. validated entries -> `Session.fromPropertyArray(entries, true)`

### Error-channel behavior

`Schema.decodeUnknownEffect` returns `Effect<_, Issue.Issue, _>`:

`refs/effect4/packages/effect/src/SchemaParser.ts:137`

```ts
decodeUnknownEffect(schema): (input) => Effect.Effect<S["Type"], Issue.Issue, ...>
```

So in our service we should map `Issue.Issue` to `ShopifyError`, preserving current behavior (decode failure -> `Option.none()` -> re-auth).

### Practical conclusion for this repo

- Yes, Effect v4 Schema can handle this payload cleanly.
- For now, keep `payload` opaque in `ShopifySession` domain.
- If we later need stronger payload typing, `Schema.fromJsonString(...)` + mutable tuple/array schemas is the clean upgrade path.

## Implementation plan

No blocking questions.

### Phase 1: add `src/lib/Domain.ts`

Define shared schemas/codecs:

- `ShopifySession` with persisted fields: `id`, `shop`, `payload`, `createdAt`, `updatedAt`
- optional payload helper only at JSON-string boundary (`Schema.UnknownFromJsonString`), not a dedicated payload domain type yet

Naming rule:

- no `*Row` naming
- `Domain` models app concepts in the same style as `refs/tces/src/lib/Domain.ts:88` (`User`) and `refs/tces/src/lib/Domain.ts:104` (`Session`)
- `ShopifySession` in domain includes persisted fields because that is the app concept we have today

Use Effect Schema APIs directly:

- decode path via `Schema.decodeUnknownEffect(...)` (`refs/effect4/packages/effect/src/SchemaParser.ts:137`)
- JSON-string codec via `Schema.fromJsonString(...)` (`refs/effect4/packages/effect/src/Schema.ts:8963`)

Concrete `Domain.ts` sketch (simplified, DB-aligned):

```ts
import { Schema } from "effect";

export const ShopifySessionId = Schema.NonEmptyString.pipe(
  Schema.brand("ShopifySessionId"),
);
export type ShopifySessionId = typeof ShopifySessionId.Type;

export const ShopDomain = Schema.NonEmptyString.pipe(Schema.brand("ShopDomain"));
export type ShopDomain = typeof ShopDomain.Type;

export const ShopifySession = Schema.Struct({
  id: ShopifySessionId,
  shop: ShopDomain,
  payload: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ShopifySession = typeof ShopifySession.Type;
```

Use inline decoding/encoding at call sites for now:

```ts
yield* Schema.decodeUnknownEffect(ShopifySession)(value)
yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(payload)
yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(json)
```

### Phase 2: add `src/lib/Repository.ts`

Create `Context.Service` repository (matching `refs/tces` style) and move SQL here:

- `upsertShopifySession(session)`
- `findShopifySessionById(id)`
- `deleteShopifySessionsByShop(shop)`
- `updateShopifySessionScope({ id, scope })`

Repository should:

- encode payload with `session.toPropertyArray(true)` + schema/codec
- decode payload through Domain codecs, then hydrate with `Session.fromPropertyArray(..., true)`
- map schema parse failures to existing `ShopifyError` path

### Phase 3: refactor `src/lib/Shopify.ts`

Replace direct D1 usage with repository calls:

- remove inline SQL at `src/lib/Shopify.ts:202`, `src/lib/Shopify.ts:219`, `src/lib/Shopify.ts:232`, `src/lib/Shopify.ts:257`
- keep auth/webhook orchestration in `Shopify` service only
- preserve current self-heal behavior (`Option.none()` on decode/load failure -> re-auth path)

### Phase 4: layer wiring

Wire `Repository.layer` where app runtime is built (`src/worker.ts`) so `Shopify.layer` can depend on `Repository` instead of raw `D1`.

### Phase 5: verify

Run project checks:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

### Acceptance criteria

- `Shopify.ts` has no low-level session SQL
- all `ShopifySession` SQL lives in `Repository.ts`
- payload parsing/stringifying uses Effect Schema JSON codec path (no manual `JSON.parse` in session repository path)
- webhook routes keep current behavior (uninstall delete by shop, scopes update mutate scope)

## Bottom line

- Add Domain + Repository: **yes**.
- Move D1 SQL out of `Shopify.ts`: **yes**.
- Add `SchemaEx.ts` now: **probably no**.
- Payload strategy: **store canonical JSON string of `session.toPropertyArray(true)`; decode only through `Session.fromPropertyArray`**.

This gives clean architecture now, preserves compatibility with Shopify session evolution, and avoids overfitting the payload to a brittle local schema.
