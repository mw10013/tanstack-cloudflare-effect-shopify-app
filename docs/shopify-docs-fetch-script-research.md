# Shopify docs fetch script research

## Final decisions

- fetch format: `.md` only
- no page-limit flag (`max-pages` removed)
- rollup to 3 top-level sections:
  - `graphql`
  - `app`
  - `cli`

## Clarification: `admin-ext`

- `admin-ext` means Admin UI extensions docs (`/docs/api/admin-extensions`)
- it is not GraphQL Admin API
- GraphQL Admin API is `/docs/api/admin-graphql/latest`

So grouping decision is correct:

- `admin-extensions` belongs under `app`, not `graphql`

## What is implemented

`scripts/refs-shopify-docs.ts` now implements:

- section type: `"graphql" | "app" | "cli"` (`scripts/refs-shopify-docs.ts:13`)
- source registry per section (`scripts/refs-shopify-docs.ts:21`)
- CLI args:
  - `--section <graphql|app|cli>` repeatable
  - `--section=<graphql|app|cli>`
  - `--list-sections`
  (`scripts/refs-shopify-docs.ts:304`)
- URL canonicalization now normalizes duplicate slashes (`scripts/refs-shopify-docs.ts:138`)
- de-duped writes across overlapping prefixes via `savedUrls` set (`scripts/refs-shopify-docs.ts:211`)
- user agent corrected to this repo identity (`scripts/refs-shopify-docs.ts:10`)

## Rollup mapping from requested sections

Requested leaf sections:

- `admin`
- `admin-ext`
- `react-router`
- `webhooks-api`
- `app`
- `launch`
- `app-home`
- `cli`
- `cli-app`
- `cli-core`
- `apps-store`
- `apps-deploy`
- `apps-structure`
- `apps-webhooks`

Rolled up to top-level:

- `graphql`
  - `admin` (`/docs/api/admin-graphql/latest`)
- `app`
  - `admin-ext` (`/docs/api/admin-extensions`)
  - `react-router` (`/docs/api/shopify-app-react-router`)
  - `webhooks-api` (`/docs/api/webhooks`)
  - `app` (`/docs/apps/build`)
  - `launch` (`/docs/apps/launch`)
  - `app-home` (`/docs/api/app-home`)
  - `apps-store` (`/docs/apps/store`)
  - `apps-deploy` (`/docs/apps/deployment`)
  - `apps-structure` (`/docs/apps/structure`)
  - `apps-webhooks` (`/docs/apps/webhooks`)
- `cli`
  - `cli` (`/docs/api/shopify-cli`)
  - `cli-app` (`/docs/api/shopify-cli/app`)
  - `cli-core` (`/docs/api/shopify-cli/general-commands`)

## All possible section candidates (current scan)

These are candidates from sitemap + curated docs links that can be modeled as prefix sections.

### `/docs/api/*` candidates from sitemap

- `/docs/api/admin-graphql`
- `/docs/api/storefront`
- `/docs/api/customer`
- `/docs/api/customer-account-ui-extensions`
- `/docs/api/liquid`
- `/docs/api/checkout-ui-extensions`
- `/docs/api/pos-ui-extensions`
- `/docs/api/payments-apps`
- `/docs/api/admin-extensions`
- `/docs/api/partner`
- `/docs/api/admin-rest`
- `/docs/api/shopify-app-remix`
- `/docs/api/shopify-app-react-router`
- `/docs/api/webhooks`
- `/docs/api/hydrogen`
- `/docs/api/hydrogen-react`

### Additional candidates from docs graph / llms links

- `/docs/apps/build`
- `/docs/apps/launch`
- `/docs/api/app-home`
- `/docs/api/shopify-cli`
- `/docs/api/shopify-cli/app`
- `/docs/api/shopify-cli/general-commands`
- `/docs/apps/store`
- `/docs/apps/deployment`
- `/docs/apps/structure`
- `/docs/apps/webhooks`
- `/docs/storefronts/headless`

## Discovery strategy

- `sitemap-prefix` for prefixes that are well-covered by `sitemap_standard.xml.gz`
- `crawl-prefix` for prefixes not present (or not complete) in sitemap

Current implementation split:

- `graphql`
  - sitemap: admin GraphQL latest
- `app`
  - sitemap: admin-extensions, shopify-app-react-router, api/webhooks
  - crawl: apps/build, apps/launch, api/app-home, apps/store, apps/deployment, apps/structure, apps/webhooks
- `cli`
  - crawl: shopify-cli root, app commands, general commands

## No page-limit flag rationale

No `--max-pages` flag is used.

This is not about infinite nesting.

The crawler already prevents loops with:

- `visited` set (`scripts/refs-shopify-docs.ts:260`)
- `queued` set (`scripts/refs-shopify-docs.ts:259`)

Operational worst-cases without caps still exist (large growth, prefix mistakes), but policy is to control scope by explicit section/prefix selection, not page caps.

## Usage

- all defaults (all three top-level sections):
  - `pnpm refs:shopify-docs`
- only GraphQL docs:
  - `pnpm refs:shopify-docs --section graphql`
- app + cli docs:
  - `pnpm refs:shopify-docs --section app --section cli`
- inspect section registry:
  - `pnpm refs:shopify-docs --list-sections`
