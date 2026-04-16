# Shopify docs fetch script research

## Scope

Analyze `scripts/refs-shopify-docs.ts` and answer:

- what it does
- whether `USER_AGENT` is correct
- where current `DocSection` values come from
- what other sections we could add
- how to add a CLI option for section selection

## What the script does

Code signals:

- `type DocSection = "admin-graphql" | "apps-build"` (`scripts/refs-shopify-docs.ts:13`)
- seeds:
  - `ADMIN_PREFIX = https://shopify.dev/docs/api/admin-graphql/latest` (`scripts/refs-shopify-docs.ts:8`)
  - `APPS_BUILD_PREFIX = https://shopify.dev/docs/apps/build` (`scripts/refs-shopify-docs.ts:9`)
- output root: `refs/shopify-docs` (`scripts/refs-shopify-docs.ts:7`)

Flow:

1. Download + gunzip `https://shopify.dev/sitemap_standard.xml.gz` (`scripts/refs-shopify-docs.ts:10`, `scripts/refs-shopify-docs.ts:87`).
2. Parse `<loc>` URLs and keep only URLs under admin GraphQL prefix (`scripts/refs-shopify-docs.ts:102`).
3. For each doc URL, fetch `${docUrl}.md`, save to `refs/shopify-docs/...` (`scripts/refs-shopify-docs.ts:116`).
4. Crawl `apps/build` recursively:
   - start queue at `https://shopify.dev/docs/apps/build`
   - fetch `.md`
   - extract markdown links + raw Shopify doc URLs
   - enqueue only links still under `/docs/apps/build`
   (`scripts/refs-shopify-docs.ts:141`).

Net: deterministic admin GraphQL harvest from sitemap + bounded BFS crawl for apps/build.

## Is `USER_AGENT` off?

Yes.

Current value is:

- `product-health-check/refs-shopify-docs` (`scripts/refs-shopify-docs.ts:11`)

This appears copied from another repo (commit introducing this file: `913ccd1`, message includes "from product-health-check").

Recommended:

```ts
const USER_AGENT = "tanstack-cloudflare-effect-shopify-app/refs-shopify-docs (+https://github.com/mw10013/tanstack-cloudflare-effect-shopify-app)";
```

Why:

- identifies actual caller/project
- includes purpose token
- includes operator/contact URL (crawler best practice)

Note: Shopify `robots.txt` explicitly mentions LLM crawling guidance and `llms.txt`:

> "For any LLM training, we have implemented https://shopify.dev/llms.txt ... You can append .txt to the end of any URL to get the raw text version of the page."

So `.txt` endpoints are officially documented; `.md` currently works but `.txt` is the explicit documented path in robots guidance.

## How were current two DocSections determined?

Not via `llms.txt` in current implementation.

Evidence:

- no fetch/read of `/llms.txt` anywhere in script
- only discovery source in code is `sitemap_standard.xml.gz` + in-page link crawl

Interpretation:

- `admin-graphql` = hardcoded seed + sitemap filter source
- `apps-build` = hardcoded seed + recursive link source

So these two sections are manually chosen seeds, not dynamically derived from a section manifest.

## What other doc sections could there be?

### From sitemap (high-confidence, machine discoverable)

Quick parse of `sitemap_standard.xml.gz` (today) shows docs are concentrated under `/docs/api/*` and include at least:

- `/docs/api/storefront`
- `/docs/api/customer`
- `/docs/api/customer-account-ui-extensions`
- `/docs/api/liquid`
- `/docs/api/checkout-ui-extensions`
- `/docs/api/pos-ui-extensions`
- `/docs/api/admin-extensions`
- `/docs/api/payments-apps`
- `/docs/api/shopify-app-react-router`
- `/docs/api/shopify-app-remix`
- `/docs/api/hydrogen`
- `/docs/api/hydrogen-react`
- `/docs/api/admin-rest`
- `/docs/api/partner`

### From apps docs graph (crawl-discoverable, not in sitemap)

From `/docs/apps/build(.md|.txt)` links:

- `/docs/apps/store`
- `/docs/apps/deployment`
- `/docs/apps/structure`
- `/docs/apps/webhooks`

From `llms.txt` links (not exhaustive, but useful curated seed list):

- `/docs/apps/build`
- `/docs/apps/launch`
- `/docs/storefronts/headless`
- plus many `/docs/api/*` pages

## CLI option for section selection

Recommended UX:

- `pnpm refs:shopify-docs --section admin-graphql`
- `pnpm refs:shopify-docs --section apps-build`
- `pnpm refs:shopify-docs --section api-storefront`
- `pnpm refs:shopify-docs --section admin-graphql --section apps-build`
- `pnpm refs:shopify-docs --list-sections`

Behavior:

- default with no `--section`: current behavior (all default sections)
- `--section` repeatable
- unknown section -> fail fast with valid section list

Implementation shape:

1. Replace union-only branching with section registry map, e.g. `Record<DocSection, { kind, seedPrefix, discover }>`.
2. Parse args (`node:util` `parseArgs` or lightweight `process.argv`).
3. For each requested section, run its discovery strategy:
   - sitemap-filter strategy for `/docs/api/...` sections
   - bounded BFS strategy for `/docs/apps/...` sections
4. Reuse `saveMarkdown` and shared canonicalization.

Low-risk first increment:

- keep existing two sections
- add `--section` + `--list-sections`
- then add 1-2 new sections (suggest: `api-storefront`, `apps-launch`) after validating output volume.

## Open decisions

- keep `.md` fetches or switch to `.txt` fetches per robots guidance
- choose section naming convention (`api-admin-graphql` vs `admin-graphql`)
- cap crawl size/depth for large sections to avoid unexpectedly huge syncs
