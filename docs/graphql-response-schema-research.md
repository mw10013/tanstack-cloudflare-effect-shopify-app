# GraphQL Response Schema Research

## `generateProduct` Overview

`generateProduct` (`src/routes/app.index.tsx:39`) runs two Shopify Admin GraphQL mutations sequentially inside an Effect:

1. **`productCreate`** — creates a product, returns `Product` with first-page variants
2. **`productVariantsBulkUpdate`** — updates the first variant's price to `100.00`

Returns `GenerateProductResult = { product: GeneratedProduct, variant: readonly GeneratedVariant[] }`.

### GraphQL Request Pattern

Both mutations use `auth.graphql(query, { variables })` where `auth` is the `ShopifyAdminContext` yielded from `shopify.authenticateAdmin(request)`. Returns `Response` (fetch-style).

### Response Handling Pattern

Each response is decoded in two steps:

```ts
const json = yield* Effect.tryPromise(() => response.json()).pipe(
  Effect.map((json) => json as ShopifyGraphqlResponse<{ productCreate?: { product?: GeneratedProduct } }>),
);
const product = json.data?.productCreate?.product;
if (!product) yield* Effect.fail(new Error(json.errors?.[0]?.message ?? "Product create failed"));
```

**Problems with this pattern:**
- `json as Type` is a cast — no runtime validation. If the API shape changes, TypeScript won't catch it at runtime.
- The three-layer envelope (`data?.mutation?.field`) must be manually unwrapped each time.
- `errors` array is structurally typed but not validated.

### Current Interface Typing

All interfaces are defined at the top of the route file:

```ts
interface GeneratedVariant { id, price, barcode: string | null, createdAt }
interface GeneratedProduct { id, title, handle, status, variants: { edges: { node: GeneratedVariant }[] } }
interface ShopifyGraphqlResponse<TData> { data?: TData, errors?: { message: string }[] }
```

These are purely structural, compile-time only — no runtime guarantees.

---

## Shopify GraphQL Types (from refs/shopify-docs)

### Product fields queried

| Field | GraphQL type | Notes |
|---|---|---|
| `id` | `ID!` | non-null |
| `title` | `String` | nullable in schema but always present |
| `handle` | `String!` | non-null |
| `status` | `ProductStatus!` | `ACTIVE \| DRAFT \| ARCHIVED \| UNLISTED` |
| `variants(first: N)` | `ProductVariantConnection!` | paginated edges/node |

### ProductVariant fields queried

| Field | GraphQL type | Notes |
|---|---|---|
| `id` | `ID!` | non-null |
| `price` | `Money!` | non-null; returned as string in JSON (e.g. `"100.00"`) |
| `barcode` | `String` | nullable — must use `NullOr` |
| `createdAt` | `DateTime!` | ISO-8601 string in JSON |

### ProductStatus enum

`ACTIVE | DRAFT | ARCHIVED | UNLISTED`

---

## Effect v4 Schema Patterns (from refs/effect4)

### Decoding unknown JSON inside Effect

```ts
// Replace: json as ShopifyGraphqlResponse<T>
// With:
yield* Schema.decodeUnknownEffect(ResponseSchema)(json)
```

Or inline with pipe:

```ts
const json = yield* Effect.tryPromise(() => response.json()).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(ProductCreateResponseSchema)),
);
```

`Schema.decodeUnknownEffect` returns `Effect<A, ParseError>` — parse errors surface as typed failures.

### Nullable fields

```ts
barcode: Schema.NullOr(Schema.String)   // null | string
```

### Optional envelope fields (GraphQL `data?`, `errors?`)

```ts
Schema.Struct({
  data: Schema.optional(Schema.Struct({ ... })),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
})
```

### Branded IDs

```ts
export const ProductId = Schema.String.pipe(Schema.brand("ProductId"));
export type ProductId = typeof ProductId.Type;
```

### Literal union for enums

```ts
export const ProductStatus = Schema.Literals(["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"]);
export type ProductStatus = typeof ProductStatus.Type;
```

---

## Domain Object Design

### What belongs in `Domain.ts`

Reusable types that represent Shopify domain concepts — usable across multiple routes and server fns:

```ts
// Domain.ts additions
export const ProductId = Schema.String.pipe(Schema.brand("ProductId"));
export type ProductId = typeof ProductId.Type;

export const ProductStatus = Schema.Literals(["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"]);
export type ProductStatus = typeof ProductStatus.Type;

export const VariantId = Schema.String.pipe(Schema.brand("VariantId"));
export type VariantId = typeof VariantId.Type;

export const ProductVariant = Schema.Struct({
  id: VariantId,
  price: Schema.String,
  barcode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ProductVariant = typeof ProductVariant.Type;

export const Product = Schema.Struct({
  id: ProductId,
  title: Schema.String,
  handle: Schema.String,
  status: ProductStatus,
  variants: Schema.Struct({
    edges: Schema.Array(Schema.Struct({ node: ProductVariant })),
  }),
});
export type Product = typeof Product.Type;
```

**Reasoning:** `Product` and `ProductVariant` represent Shopify Admin API domain entities. They will be needed anywhere we query products — not just this route. `ProductStatus` is an enum shared across product mutations/queries.

`ProductId` as a branded type provides type safety when passing IDs between functions (e.g., between `productCreate` result and `productVariantsBulkUpdate` input).

### What stays in the route module

GraphQL response envelopes are mutation-specific implementation details:

```ts
// app.index.tsx — co-located with server fn
const ShopifyErrors = Schema.optional(
  Schema.Array(Schema.Struct({ message: Schema.String }))
);

const ProductCreateResponse = Schema.Struct({
  data: Schema.optional(Schema.Struct({
    productCreate: Schema.optional(Schema.Struct({
      product: Schema.optional(Domain.Product),
    })),
  })),
  errors: ShopifyErrors,
});

const ProductVariantsBulkUpdateResponse = Schema.Struct({
  data: Schema.optional(Schema.Struct({
    productVariantsBulkUpdate: Schema.optional(Schema.Struct({
      productVariants: Schema.optional(Schema.Array(Domain.ProductVariant)),
    })),
  })),
  errors: ShopifyErrors,
});
```

**Reasoning:** These response envelopes are specific to these two mutations in this server fn. The envelope structure (`data.productCreate.product`) mirrors the GraphQL selection set exactly — it's tightly coupled to the query string. If the query changes, the schema changes. Keeping them co-located avoids false reuse and makes changes easier to track.

A shared `ShopifyGraphqlResponse<T>` generic schema doesn't work well with Effect Schema because Schema generics require runtime Schema values, not TypeScript generics. Each response shape is better expressed as a concrete struct.

---

## Refactored `generateProduct` Pattern

```ts
const generateProduct = createServerFn({ method: "POST" }).handler(
  ({ context: { runEffect } }): Promise<GenerateProductResult> =>
    runEffect(
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const request = yield* AppRequest;
        const auth = yield* shopify.authenticateAdmin(request);
        if (auth instanceof Response) {
          return yield* Effect.fail(new Error(`Unexpected Shopify auth response: ${String(auth.status)}`));
        }

        const color = ["Red", "Orange", "Yellow", "Green"][Math.floor(Math.random() * 4)];
        const productCreateResponse = yield* auth.graphql(`#graphql ...`, {
          variables: { product: { title: `${color} Snowboard` } },
        });

        const productCreateJson = yield* Effect.tryPromise(
          () => productCreateResponse.json()
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ProductCreateResponse)),
        );

        const product = productCreateJson.data?.productCreate?.product;
        if (!product) {
          return yield* Effect.fail(
            new Error(productCreateJson.errors?.[0]?.message ?? "Product create failed")
          );
        }

        const variantId = product.variants.edges[0]?.node.id;
        if (!variantId) return yield* Effect.fail(new Error("Created product has no variant"));

        // ... second mutation follows same pattern
        return { product, variant };
      }),
    ),
);
```

Key change: `Effect.tryPromise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema)))` replaces the `as` cast. Parse failures become typed Effect errors.

---

## Implementation Plan

1. Add `ProductId`, `ProductStatus`, `ProductVariant`, `Product` to `src/lib/Domain.ts`
2. In `app.index.tsx`:
   - Remove `GeneratedVariant`, `GeneratedProduct`, `ShopifyGraphqlResponse`, `GenerateProductResult` interfaces
   - Add `ProductCreateResponse` and `ProductVariantsBulkUpdateResponse` Schema structs co-located with the server fn
   - Replace `as` casts with `Schema.decodeUnknownEffect`
   - Update `GenerateProductResult` to use `Domain.Product` and `Domain.ProductVariant` types
3. The `errors` field: `Schema.optional(Schema.Array(...))` — absent in success responses, present on failure

## Open Questions

- **`createdAt` as string vs DateTime**: `Schema.DateTimeUtcFromString` would give a typed `DateTime` object but adds a dependency on Effect's DateTime type in return values serialized by TanStack server fn. Keep as `Schema.String` unless datetime arithmetic is needed.
