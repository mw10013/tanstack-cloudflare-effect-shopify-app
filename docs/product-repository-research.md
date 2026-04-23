# ProductRepository Research

## Current State

`app.index.tsx` defines two wrapper schemas inline and calls `shopify.graphqlDecode` directly in the server fn:

```ts
// app.index.tsx (lines 11-20)
const ProductCreateResponse = Schema.Struct({
  productCreate: Schema.optional(
    Schema.Struct({ product: Schema.optional(Domain.Product) }),
  ),
});
const ProductVariantsBulkUpdateResponse = Schema.Struct({
  productVariantsBulkUpdate: Schema.optional(
    Schema.Struct({ productVariants: Schema.optional(Schema.Array(Domain.ProductVariant)) }),
  ),
});
```

`graphqlDecode` reads the `adminContextRef` set by `authenticateAdmin` (Shopify.ts:427), so it requires auth middleware to have run first — which `shopifyServerFnMiddleware` already guarantees.

---

## Domain.ts

Product types are already present (`Product`, `ProductVariant`, `ProductId`, `VariantId`, `ProductStatus`). No changes needed.

---

## Wrapper Schemas

`ProductCreateResponse` and `ProductVariantsBulkUpdateResponse` are GQL response envelopes — implementation details of the repository, not domain concepts. They should live as private module-level constants in `ProductRepository.ts`, co-located with their queries. They do not belong in `Domain.ts`.

---

## ProductRepository.ts Design

Follows the same `Context.Service` pattern as `Repository.ts`. Depends on `Shopify` (not `D1`). `ShopifyError` propagates naturally from `graphqlDecode` — no new error type needed.

```ts
// src/lib/ProductRepository.ts
import { Context, Effect, Layer } from "effect";
import * as Domain from "@/lib/Domain";
import { Shopify } from "@/lib/Shopify";

const ProductCreateResponse = ...;       // private
const ProductVariantsBulkUpdateResponse = ...; // private

export class ProductRepository extends Context.Service<ProductRepository>()(
  "ProductRepository",
  {
    make: Effect.gen(function* () {
      const shopify = yield* Shopify;

      const createProduct = Effect.fn("ProductRepository.createProduct")(
        function* (title: string): Effect.Effect<Domain.Product, ShopifyError> { ... }
      );

      const updateVariantsBulk = Effect.fn("ProductRepository.updateVariantsBulk")(
        function* (
          productId: Domain.ProductId,
          variants: readonly { id: Domain.VariantId; price: string }[],
        ): Effect.Effect<readonly Domain.ProductVariant[], ShopifyError> { ... }
      );

      return { createProduct, updateVariantsBulk };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
```

### Method split

The `generateProduct` server fn chains two mutations (create → get variantId → update price). These are two distinct operations. `ProductRepository` exposes them separately; the route orchestrates the chain. This keeps the repository operations composable and the orchestration visible in the route.

---

## Route Refactor

`app.index.tsx` server fn becomes:

```ts
.handler(({ context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      const products = yield* ProductRepository;
      const color = ...;
      const product = yield* products.createProduct(`${color} Snowboard`);
      const variantId = product.variants.edges[0]?.node.id;
      if (!variantId) return yield* Effect.fail(new Error("Created product has no variant"));
      const variants = yield* products.updateVariantsBulk(product.id, [{ id: variantId, price: "100.00" }]);
      return { product, variant: variants };
    }),
  ),
)
```

No more inline queries or wrapper schemas in the route.

---

## worker.ts Layer Composition

Add `productRepositoryLayer` after `shopifyLayer`, since it depends on `Shopify`:

```ts
const productRepositoryLayer = Layer.provideMerge(ProductRepository.layer, shopifyLayer);

return Layer.mergeAll(
  d1Layer,
  kvLayer,
  repositoryLayer,
  shopifyLayer,
  productRepositoryLayer,  // add
  requestLayer,
  makeLoggerLayer(env),
);
```

---

## Open Questions

1. **Wrapper schemas in Domain.ts?** Current thinking: no — they're GQL response envelopes, not domain concepts. Only `Product`, `ProductVariant`, etc. belong in `Domain.ts`. Confirm this.

2. **Combined vs. separate methods?** Keeping `createProduct` and `updateVariantsBulk` separate is more composable. A combined `populateProduct(title)` helper could go in the route or as a third method if the pattern recurs. Preference?

3. **ProductRepositoryError?** `ShopifyError` propagates unchanged through `graphqlDecode`. Adding a new error type would just be wrapping noise unless callers need to distinguish repository errors from auth errors. Current lean: let `ShopifyError` propagate.
