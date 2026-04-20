# Shopify Session Payload Schema Research

## Question

For [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L118-L136), should `Domain.ts` define a `ShopifySessionPayload` schema that matches the first argument of `ShopifyApi.Session.fromPropertyArray`, and should `Domain.ShopifySession.payload` use that schema instead of raw `Schema.String`?

## Current State

`Domain.ShopifySession` currently treats `payload` as an opaque string:

```ts
export const ShopifySession = Schema.Struct({
  id: ShopifySessionId,
  shop: ShopDomain,
  payload: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
```

`Repository` validates only the row shape, then `Shopify.ts` parses and hydrates the payload later:

```ts
const parsed = yield* tryShopify(() => JSON.parse(payload) as unknown);
if (!Array.isArray(parsed)) {
  ...
}
return yield* tryShopify(() =>
  ShopifyApi.Session.fromPropertyArray(
    parsed as [string, string | number | boolean][],
    true,
  ),
);
```

That is the messy part you called out.

## Shopify's Actual Contract

In Shopify's source, the read and write sides are symmetric:

```ts
public static fromPropertyArray(
  entries: [string, string | number | boolean][],
  returnUserData = false,
): Session

public toPropertyArray(
  returnUserData = false,
): [string, string | number | boolean][]
```

`toPropertyArray(true)` also flattens `onlineAccessInfo` into user-data tuples:

```ts
return [
  ['userId', value?.associated_user?.id],
  ['firstName', value?.associated_user?.first_name],
  ['lastName', value?.associated_user?.last_name],
  ['email', value?.associated_user?.email],
  ['locale', value?.associated_user?.locale],
  ['emailVerified', value?.associated_user?.email_verified],
  ['accountOwner', value?.associated_user?.account_owner],
  ['collaborator', value?.associated_user?.collaborator],
];
```

So the stable schema shape is not a strict object. It is the generic tuple array:

```ts
[string, string | number | boolean][]
```

## Recommendation

Yes, this direction makes sense.

The clean version is:

1. Define an inner schema for the tuple array.
2. Wrap it in a JSON-string transform schema.
3. Use that transform schema for `Domain.ShopifySession.payload`.

Suggested shape:

```ts
const ShopifySessionPayloadEntries = Schema.Array(
  Schema.Tuple(
    Schema.String,
    Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
  ),
);

export const ShopifySessionPayload = Schema.fromJsonString(
  ShopifySessionPayloadEntries,
);
export type ShopifySessionPayload = typeof ShopifySessionPayload.Type;
```

With that, `payload` stays a JSON `text` column in D1, but the decoded domain value becomes the tuple array.

## Why This Is Better

- Matches Shopify's real serialization contract exactly: `session.toPropertyArray(true)`.
- Keeps the persisted DB format unchanged: still `JSON.stringify(...)` of the tuple array.
- Moves `JSON.parse` and tuple validation into the schema boundary instead of hand-rolling it in `Shopify.ts`.
- Lets `Repository` return a validated `ShopifySession` row whose `payload` is already decoded.
- Removes the most suspicious cast in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L129-L132).

## What It Does Not Solve

It does not replace `ShopifyApi.Session.fromPropertyArray`.

That SDK method still owns:

- key normalization (`isOnline`, `accessToken`, `refreshTokenExpires`, etc.)
- coercion (`String`, `Number`, `Boolean`, `Date`)
- online session user-data hydration

So the right split is still:

- `Domain`: validate `string <-> tuple[]`
- `Repository`: decode DB row into domain row
- `Shopify`: hydrate tuple array into `ShopifyApi.Session`

## Suggested End State

`Domain.ts`:

```ts
const ShopifySessionPayloadEntries = Schema.Array(
  Schema.Tuple(
    Schema.String,
    Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
  ),
);

export const ShopifySessionPayload = Schema.fromJsonString(
  ShopifySessionPayloadEntries,
);

export const ShopifySession = Schema.Struct({
  id: ShopifySessionId,
  shop: ShopDomain,
  payload: ShopifySessionPayload,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
```

`Repository.ts` read side:

```ts
Schema.decodeUnknownEffect(Domain.ShopifySession)(row)
```

`Shopify.ts` read side becomes conceptually:

```ts
ShopifyApi.Session.fromPropertyArray(row.value.payload, true)
```

No `JSON.parse`. No tuple cast.

## Write Path Options

Two reasonable write choices:

1. Keep `JSON.stringify(session.toPropertyArray(true))` for now.
2. Encode through the schema for symmetry.

Example of the symmetric version:

```ts
Schema.encodeSync(Domain.ShopifySessionPayload)(session.toPropertyArray(true))
```

I would treat that as optional. The main win is on the read side.

## Risks And Limits

- Do not tighten this into a strict per-key object schema. Shopify can add fields, and `toPropertyArray(true)` already uses flattened user keys instead of nested `onlineAccessInfo`.
- The schema validates tuple structure, not business semantics. That is fine; Shopify's own `fromPropertyArray` remains the semantic authority.
- Existing rows should remain compatible because the stored bytes do not change.

## Answer

Yes. I think this makes sense, and this is likely the cleanest next step before a fuller cleanup of [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L118-L136).

The only real question is boundary choice:

- Should `Repository` start returning decoded payload tuples?
- Or should `ShopifySessionPayload` exist only as a helper used inside `Shopify.ts` first?

My recommendation: let `Repository` return decoded payload tuples. That keeps the DB/string boundary in one place and makes `Shopify.ts` only about Shopify session hydration, which is a cleaner separation.
