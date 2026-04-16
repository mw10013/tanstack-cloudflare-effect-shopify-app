# Better Auth ↔ Domain branded IDs

## Concept

Domain schemas encode/decode between **database** and **domain**. That's the job. `Domain.User` / `Domain.Session` have transforms (`intToBoolean`, `isoDatetimeToDate`) on the encoded side = D1 row. Decoded side = domain. That stays.

Better Auth's `auth.api.getSession` returns **the decoded side already** (Date, boolean, plain string id). Feeding it to `Schema.decodeUnknownEffect(Domain.User)` fails — the transforms run encoded→decoded and the input is already decoded.

The spread workaround (`{ ...user, id: brandedId }`) fakes a domain type. Not a domain type. Has to go.

## The fix: `Schema.toType`

`refs/effect4/packages/effect/src/Schema.ts:1711-1717`:

> Extracts the type-side schema: sets `Encoded` to equal the decoded `Type`, discarding the encoding transformation path.

```ts
Schema.toType(Domain.User)
// Encoded = Decoded = Domain.User["Type"]
// A validator whose input is already the decoded shape.
```

One source of truth. Two boundaries, two decoders:

```
D1 row ──decodeUnknownEffect(Domain.User)──────────▶ Domain.User
Better Auth ──decodeUnknownEffect(toType(Domain.User))──▶ Domain.User
```

Siblings `Schema.flip`, `Schema.toEncoded` exist — effect4 designs for this.

## Type alignment (going by the types)

Better Auth fields per `refs/better-auth/packages/core/src/db/schema/*.ts` + plugin types:

- `nullish` (`T | null | undefined`) — `image`, `banReason`, `banExpires`, `stripeCustomerId`, `ipAddress`, `userAgent`, `activeOrganizationId`
- `string | undefined` — `impersonatedBy` (optional, not nullable)

`Domain.*` currently uses `NullOr` for all of these. Widen to `NullishOr` (and `UndefinedOr` for `impersonatedBy`) to match Better Auth. D1 returns `null` — `NullishOr` accepts that too, so D1 decoding is unchanged.

## Callback sites

`Auth.ts:171` (`databaseHooks.session.create.before`) and `Auth.ts:302-305` (Stripe `authorizeReference`) receive Better Auth callback params by contract — not consumers of `getSession`. They still decode id fields inline. That's the correct shape for a callback boundary and is out of scope for `getSession`.

## Plan

1. Widen nullable fields in `Domain.User` / `Domain.Session` per Better Auth types.
2. Rewrite `Auth.getSession` to decode Better Auth output through `Schema.toType(Domain.User)` and `Schema.toType(Domain.Session)`. Return `Option<{ user: Domain.User; session: Domain.Session }>`. No spread.
3. Run typecheck, fix any downstream callsites.
