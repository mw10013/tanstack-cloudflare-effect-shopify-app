import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { getShopifyApi, loadShopifySession } from "@/lib/Shopify";

interface GeneratedVariant {
  readonly id: string;
  readonly price: string;
  readonly barcode: string | null;
  readonly createdAt: string;
}

interface GeneratedProduct {
  readonly id: string;
  readonly title: string;
  readonly handle: string;
  readonly status: string;
  readonly variants: {
    readonly edges: readonly {
      readonly node: GeneratedVariant;
    }[];
  };
}

interface ShopifyGraphqlResponse<TData> {
  readonly data?: TData;
  readonly errors?: readonly { readonly message: string }[];
}

interface GenerateProductResult {
  readonly product: GeneratedProduct;
  readonly variant: readonly GeneratedVariant[];
}

interface AppBridgeWindow {
  readonly toast?: {
    readonly show?: (message: string) => void;
  };
  readonly intents?: {
    readonly invoke?: (
      action: "edit:shopify/Product",
      payload: { readonly value: string },
    ) => void;
  };
}

const getAppBridge = (): AppBridgeWindow | undefined =>
  typeof window === "undefined"
    ? void 0
    : (window as Window & { readonly shopify?: AppBridgeWindow }).shopify;

const generateProduct = createServerFn({ method: "POST" })
  .inputValidator((input: { readonly shop: string }) => input)
  .handler(async ({ data, context }): Promise<GenerateProductResult> => {
    const shopify = getShopifyApi();
    const shop = shopify.utils.sanitizeShop(data.shop, true);
    if (!shop) {
      throw new Error("Invalid shop");
    }

    const sessionId = shopify.session.getOfflineId(shop);
    const session = await loadShopifySession({ env: context.env, id: sessionId });
    if (!session) {
      throw new Error("App session is missing. Reinstall app to continue.");
    }

    const admin = new shopify.clients.Graphql({ session });
    const color = ["Red", "Orange", "Yellow", "Green"][Math.floor(Math.random() * 4)];

    const productCreateResponse = (await admin.request(
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
      {
        variables: {
          product: {
            title: `${color} Snowboard`,
          },
        },
      },
    )) as unknown as Response;

    const productCreateJson: ShopifyGraphqlResponse<{
      readonly productCreate?: {
        readonly product?: GeneratedProduct;
      };
    }> = await productCreateResponse.json();
    const product = productCreateJson.data?.productCreate?.product;
    if (!product) {
      throw new Error(productCreateJson.errors?.[0]?.message ?? "Product create failed");
    }

    const variantId = product.variants.edges[0]?.node.id;
    if (!variantId) {
      throw new Error("Created product has no variant");
    }

    const productVariantsBulkUpdateResponse = (await admin.request(
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
      {
        variables: {
          productId: product.id,
          variants: [{ id: variantId, price: "100.00" }],
        },
      },
    )) as unknown as Response;

    const productVariantsBulkUpdateJson: ShopifyGraphqlResponse<{
      readonly productVariantsBulkUpdate?: {
        readonly productVariants?: readonly GeneratedVariant[];
      };
    }> = await productVariantsBulkUpdateResponse.json();

    const variant = productVariantsBulkUpdateJson.data?.productVariantsBulkUpdate?.productVariants;
    if (!variant) {
      throw new Error(
        productVariantsBulkUpdateJson.errors?.[0]?.message ?? "Product variant update failed",
      );
    }

    return { product, variant };
  });

export const Route = createFileRoute("/app/")({
  component: AppIndex,
});

function AppIndex() {
  const { shop } = Route.useRouteContext();
  const [isLoading, setIsLoading] = React.useState(false);
  const [result, setResult] = React.useState<GenerateProductResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!result?.product.id) {
      return;
    }
    getAppBridge()?.toast?.show?.("Product created");
  }, [result?.product.id]);

  const generate = () => {
    setIsLoading(true);
    setError(null);
    void generateProduct({ data: { shop } })
      .then((next) => {
        setResult(next);
      })
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : "Product generation failed");
      })
      .finally(() => {
        setIsLoading(false);
      });
  };

  const editProduct = () => {
    const productId = result?.product.id;
    if (!productId) {
      return;
    }
    getAppBridge()?.intents?.invoke?.("edit:shopify/Product", {
      value: productId,
    });
  };

  return (
    <s-page heading="Shopify app template">
      <s-button slot="primary-action" onClick={generate} {...(isLoading ? { loading: true } : {})}>
        Generate a product
      </s-button>
      <s-section heading="Connected">
        <s-paragraph>
          App is installed and running for <s-text fontWeight="bold">{shop}</s-text>.
        </s-paragraph>
      </s-section>
      <s-section heading="Congrats on creating a new Shopify app">
        <s-paragraph>
          This embedded app template uses{" "}
          <s-link href="https://shopify.dev/docs/apps/tools/app-bridge" target="_blank">
            App Bridge
          </s-link>{" "}
          interface examples like an <s-link href="/app/additional">additional page in the app nav</s-link>,
          as well as an{" "}
          <s-link href="https://shopify.dev/docs/api/admin-graphql" target="_blank">
            Admin GraphQL
          </s-link>{" "}
          mutation demo, to provide a starting point for app development.
        </s-paragraph>
      </s-section>
      <s-section heading="Get started with products">
        <s-paragraph>
          Generate a product with GraphQL and get the JSON output for that product. Learn more about
          the{" "}
          <s-link
            href="https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate"
            target="_blank"
          >
            productCreate
          </s-link>{" "}
          mutation in our API references.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button onClick={generate} {...(isLoading ? { loading: true } : {})}>
            Generate a product
          </s-button>
          {result?.product && (
            <s-button onClick={editProduct} variant="tertiary">
              Edit product
            </s-button>
          )}
        </s-stack>
        {error && (
          <s-section heading="Request failed">
            <s-paragraph>{error}</s-paragraph>
          </s-section>
        )}
        {result?.product && (
          <s-section heading="productCreate mutation">
            <s-stack direction="block" gap="base">
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <pre style={{ margin: 0 }}>
                  <code>{JSON.stringify(result.product, null, 2)}</code>
                </pre>
              </s-box>
              <s-heading>productVariantsBulkUpdate mutation</s-heading>
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <pre style={{ margin: 0 }}>
                  <code>{JSON.stringify(result.variant, null, 2)}</code>
                </pre>
              </s-box>
            </s-stack>
          </s-section>
        )}
      </s-section>
      <s-section slot="aside" heading="App template specs">
        <s-paragraph>
          <s-text>Framework: </s-text>
          <s-link href="https://tanstack.com/start" target="_blank">
            TanStack Start
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Interface: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/app-home/using-polaris-components"
            target="_blank"
          >
            Polaris web components
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>API: </s-text>
          <s-link href="https://shopify.dev/docs/api/admin-graphql" target="_blank">
            GraphQL
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Runtime: </s-text>
          <s-link href="https://developers.cloudflare.com/workers/" target="_blank">
            Cloudflare Workers + D1
          </s-link>
        </s-paragraph>
      </s-section>
      <s-section slot="aside" heading="Next steps">
        <s-unordered-list>
          <s-list-item>
            <s-link
              href="https://shopify.dev/docs/apps/getting-started/build-app-example"
              target="_blank"
            >
              Build an example app
            </s-link>
          </s-list-item>
          <s-list-item>
            <s-link
              href="https://shopify.dev/docs/apps/tools/graphiql-admin-api"
              target="_blank"
            >
              Explore Shopify API with GraphiQL
            </s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}
