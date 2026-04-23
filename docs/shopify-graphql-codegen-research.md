# Shopify GraphQL Codegen Research

## Current Project State

Already configured but not running:

- `.graphqlrc.ts` — configured with `ApiType.Admin`, `ApiVersion.January26`, scans `./src/**/*.{js,ts,jsx,tsx}`, outputs to `./src/types`
- `package.json` — has `"graphql-codegen": "graphql-codegen"` script and `@shopify/api-codegen-preset@2.0.0` devDependency
- `src/lib/ProductRepository.ts` — uses `#graphql` tagged template literals (lines 28, 62)
- `./src/types` — does not exist yet; created on first codegen run

## Shopify Recommendation

`refs/shopify-docs/docs/api/shopify-app-react-router/v1/guide-graphql-types.md`:

> The GraphQL clients provided in this package can use Codegen to automatically parse and create types for your queries and mutations.
> By installing a few packages in your app, you can use the `graphql-codegen` script, which will look for strings with the `#graphql` tag and extract types from them.

Tool: `graphql-codegen` + `@shopify/api-codegen-preset`

Key constraint:
> Parsing will not work on `.graphql` documents, because the preset can only apply types from JavaScript and TypeScript const strings.

Queries must use `#graphql` tagged template literals, not `.graphql` files.

## Using Codegen as a Validation Check

The user's intent: run codegen not to use the generated types, but to **validate that GraphQL queries are correct against the schema**. If codegen fails, the query is invalid.

```bash
pnpm graphql-codegen
```

Add to CI or typecheck workflow. Codegen fetches the live Shopify Admin schema via the proxy endpoint (see below) and validates all `#graphql` strings against it.

## Getting the Shopify Admin GraphQL Schema

### Proxy endpoint (used by codegen)

```
https://shopify.dev/admin-graphql-direct-proxy/{API_VERSION}
```

Example from `.graphqlrc.ts` docs:
```ts
schema: 'https://shopify.dev/admin-graphql-direct-proxy/2023-10',
```

The `shopifyApiProject` helper in `.graphqlrc.ts` configures this automatically based on `apiVersion`.

### Introspection / SDL download

No dedicated CLI command for the Admin API schema. The proxy endpoint supports GraphQL introspection, so tools like `graphql-cli` or Apollo can download the SDL:

```bash
npx graphql-cli get-schema --endpoint https://shopify.dev/admin-graphql-direct-proxy/2024-01 --output schema.graphql
```

## GraphiQL Explorer (browser-based)

Shopify provides a hosted GraphiQL IDE:

- URL: `https://shopify.dev/docs/api/usage/api-exploration/admin-graphiql-explorer`
- Allows browsing schema, writing and testing queries/mutations against a real store
- Requires Shopify Partner account / store connection

Referenced in `refs/shopify-docs/` across multiple docs (products, webhooks, etc.) as the recommended tool for interactive schema exploration.

## .graphqlrc.ts Pattern

Current project (`/.graphqlrc.ts`) includes top-level `schema` and `documents` for IDE syntax highlighting / auto-complete, plus the `default` project for codegen:

```ts
import { ApiVersion } from "@shopify/shopify-api";
import { ApiType, shopifyApiProject } from "@shopify/api-codegen-preset";

export default {
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
```

Template (`refs/shopify-app-template/.graphqlrc.ts`) also adds extension project entries for Shopify Functions with their own `schema.graphql`.

## Summary

| Item | Value |
|------|-------|
| Tool | `graphql-codegen` + `@shopify/api-codegen-preset` |
| Query format | `#graphql` tagged template literals only |
| Config | `.graphqlrc.ts` (already present) |
| Script | `pnpm graphql-codegen` (already in package.json) |
| Schema proxy | `https://shopify.dev/admin-graphql-direct-proxy/{version}` |
| GraphiQL | https://shopify.dev/docs/api/usage/api-exploration/admin-graphiql-explorer |
| Generated types dir | `./src/types` (not yet created) |
| Validation use | Run codegen in CI; failure = invalid GraphQL |
