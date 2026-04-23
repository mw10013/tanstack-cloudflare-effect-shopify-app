import { ApiVersion } from "@shopify/shopify-api";
import { ApiType, shopifyApiProject } from "@shopify/api-codegen-preset";
import type { IGraphQLConfig } from "graphql-config";

const config: IGraphQLConfig = {
  schema: `https://shopify.dev/admin-graphql-direct-proxy/${ApiVersion.January26}`,
  documents: ["./src/**/*.{js,ts,jsx,tsx}"],
  projects: {
    default: shopifyApiProject({
      apiType: ApiType.Admin,
      apiVersion: ApiVersion.January26,
      documents: ["./src/**/*.{js,ts,jsx,tsx}"],
      outputDir: "./src/types",
    }),
  },
};

export default config;
