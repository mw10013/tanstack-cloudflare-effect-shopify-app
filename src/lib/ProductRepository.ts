import { Context, Effect, Layer, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { ShopifyAdmin } from "@/lib/Shopify";

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

export class ProductRepository extends Context.Service<ProductRepository>()(
  "ProductRepository",
  {
    make: Effect.gen(function* () {
      const admin = yield* ShopifyAdmin;

      const createProduct = Effect.fn("ProductRepository.createProduct")(
        function* (title: Domain.Product["title"]) {
          const result = yield* admin.graphqlDecode(
            ProductCreateResponse,
            `#graphql
            mutation populateProduct($product: ProductCreateInput!) {
              productCreate(product: $product) {
                product {
                  id
                  title
                  handle
                  status
                  variants(first: 10) {
                    edges {
                      node {
                        id
                        price
                        barcode
                        createdAt
                      }
                    }
                  }
                }
              }
            }`,
            { variables: { product: { title } } },
          );
          return result.productCreate?.product;
        },
      );

      const updateVariantsBulk = Effect.fn("ProductRepository.updateVariantsBulk")(
        function* (
          productId: Domain.Product["id"],
          variants: readonly { readonly id: Domain.ProductVariant["id"]; readonly price: Domain.ProductVariant["price"] }[],
        ) {
          const result = yield* admin.graphqlDecode(
            ProductVariantsBulkUpdateResponse,
            `#graphql
            mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }`,
            { variables: { productId, variants } },
          );
          return result.productVariantsBulkUpdate?.productVariants;
        },
      );

      return { createProduct, updateVariantsBulk };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
