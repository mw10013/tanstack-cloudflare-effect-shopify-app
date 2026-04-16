# Shopify docs fetch script research

## Update made

- Updated `USER_AGENT` in `scripts/refs-shopify-docs.ts:11` to:

```ts
const USER_AGENT =
  "tanstack-cloudflare-effect-shopify-app/refs-shopify-docs (+https://github.com/mw10013/tanstack-cloudflare-effect-shopify-app)";
```

Reason: current value (`product-health-check/refs-shopify-docs`) was copied from another repo (`git show 913ccd1 -- scripts/refs-shopify-docs.ts`).

## What the script does now

From `scripts/refs-shopify-docs.ts`:

- sections are hardcoded: `type DocSection = "admin-graphql" | "apps-build"` (`scripts/refs-shopify-docs.ts:14`)
- `admin-graphql` source is sitemap filter:
  - fetch + gunzip `https://shopify.dev/sitemap_standard.xml.gz` (`scripts/refs-shopify-docs.ts:10`, `scripts/refs-shopify-docs.ts:88`)
  - keep only URLs under `https://shopify.dev/docs/api/admin-graphql/latest` (`scripts/refs-shopify-docs.ts:8`, `scripts/refs-shopify-docs.ts:109`)
- `apps-build` source is bounded crawl:
  - seed `https://shopify.dev/docs/apps/build` (`scripts/refs-shopify-docs.ts:9`, `scripts/refs-shopify-docs.ts:142`)
  - fetch page markdown, extract links, enqueue only links still under `/docs/apps/build` (`scripts/refs-shopify-docs.ts:155`, `scripts/refs-shopify-docs.ts:164`)
- save format is `${docUrl}.md` into `refs/shopify-docs/...` (`scripts/refs-shopify-docs.ts:7`, `scripts/refs-shopify-docs.ts:122`)

## MD vs TXT decision

Decision: use `.md` only.

Evidence:

- sampled pages are byte-identical for `.md` and `.txt`:
  - `https://shopify.dev/docs/api/admin-graphql/latest`
  - `https://shopify.dev/docs/apps/build`
- current script already fetches `${docUrl}.md` (`scripts/refs-shopify-docs.ts:122`)

Note:

- Shopify `robots.txt` says `.txt` is available for raw text (`https://shopify.dev/robots.txt`), but this plan intentionally standardizes on `.md`.

## How current DocSections were determined

Not from `llms.txt`.

Evidence in code:

- no fetch of `/llms.txt`
- only discovery sources are sitemap + in-page link crawl

So current sections are manual seeds:

- `admin-graphql`: seeded by `ADMIN_PREFIX` + sitemap filter
- `apps-build`: seeded by `APPS_BUILD_PREFIX` + recursive crawl

## Naming convention recommendation (short)

Use short CLI keys. Proposed mapping:

- `admin-graphql` -> `admin`
- `apps-build` -> `apps`
- `shopify-cli-app` -> `cli-app`
- `shopify-cli-general` -> `cli-core`
- `app-home` stays `app-home`
- `admin-extensions` -> `admin-ext`
- `checkout-ui-extensions` -> `checkout-ui`
- `customer-account-ui-extensions` -> `customer-account-ui`
- `shopify-app-react-router` -> `react-router`
- `shopify-app-remix` -> `remix`

## All possible sections (so you can pick)

This list is constrained to sections discoverable via current script mechanics (prefix filter + prefix crawl), plus Shopify `llms.txt` curated links.

### A) `/docs/api/*` sections from sitemap (complete current set)

Source: `https://shopify.dev/sitemap_standard.xml.gz` parsed today.

| key (short) | path prefix | urls in sitemap | fit for your goals |
|---|---|---:|---|
| `admin` | `/docs/api/admin-graphql` | 3880 | yes, core for admin/product data |
| `storefront` | `/docs/api/storefront` | 434 | usually no for embedded admin apps |
| `customer-api` | `/docs/api/customer` | 363 | maybe |
| `customer-account-ui` | `/docs/api/customer-account-ui-extensions` | 360 | maybe |
| `liquid` | `/docs/api/liquid` | 328 | maybe (theme app extensions) |
| `checkout-ui` | `/docs/api/checkout-ui-extensions` | 242 | maybe |
| `pos-ui` | `/docs/api/pos-ui-extensions` | 172 | maybe |
| `payments-apps` | `/docs/api/payments-apps` | 163 | maybe |
| `admin-ext` | `/docs/api/admin-extensions` | 131 | yes |
| `partner` | `/docs/api/partner` | 91 | maybe |
| `hydrogen` | `/docs/api/hydrogen` | 89 | no (you said skip hydrogen) |
| `admin-rest` | `/docs/api/admin-rest` | 76 | maybe (legacy fallback) |
| `hydrogen-react` | `/docs/api/hydrogen-react` | 44 | no (skip hydrogen) |
| `remix` | `/docs/api/shopify-app-remix` | 38 | maybe |
| `react-router` | `/docs/api/shopify-app-react-router` | 23 | yes |
| `webhooks-api` | `/docs/api/webhooks` | 1 | yes |

### B) Additional sections not represented in sitemap counts

Sources: `https://shopify.dev/llms.txt`, plus prefix crawl.

| key (short) | path prefix | approx pages via prefix crawl | fit for your goals |
|---|---|---:|---|
| `apps` | `/docs/apps/build` | 355 | yes, highest value app-build docs |
| `launch` | `/docs/apps/launch` | 55 | yes (distribution, app review, billing) |
| `app-home` | `/docs/api/app-home` | 129 | yes (app bridge + polaris web components) |
| `cli` | `/docs/api/shopify-cli` | 1 | yes (landing) |
| `cli-app` | `/docs/api/shopify-cli/app` | 31 | yes (app commands) |
| `cli-core` | `/docs/api/shopify-cli/general-commands` | 12 | yes |
| `apps-store` | `/docs/apps/store` | 1 | maybe |
| `apps-deploy` | `/docs/apps/deployment` | 1 | yes |
| `apps-structure` | `/docs/apps/structure` | 1 | yes |
| `apps-webhooks` | `/docs/apps/webhooks` | 1 | yes |
| `storefronts-headless` | `/docs/storefronts/headless` | 62 | no (headless/hydrogen-adjacent) |

### C) Optional granular subsections under `/docs/apps/build/*`

If you want finer-grained section choices than one big `apps` section:

- `admin` (11)
- `ai-toolkit` (1)
- `app-configuration` (1)
- `app-extensions` (5)
- `app-surfaces` (1)
- `authentication-authorization` (14)
- `b2b` (7)
- `checkout` (54)
- `cli-for-apps` (8)
- `compliance` (1)
- `custom-data` (11)
- `customer-accounts` (18)
- `dev-dashboard` (11)
- `devmcp` (1)
- `discounts` (9)
- `flow` (14)
- `functions` (17)
- `localize-your-app` (1)
- `marketing-analytics` (6)
- `markets` (15)
- `metafields` (10)
- `metaobjects` (9)
- `online-store` (12)
- `orders-fulfillment` (13)
- `payments` (15)
- `performance` (5)
- `pos` (5)
- `privacy-law-compliance` (1)
- `product-merchandising` (19)
- `purchase-options` (36)
- `sales-channels` (8)
- `scaffold-app` (1)
- `security` (1)
- `webhooks` (12)

## Section recommendations for your stated scope

You asked for app development/deploy, Polaris, Shopify CLI, dev dashboard/tools, admin/store/product management; exclude hydrogen.

### Recommended include set (phase 1)

- `apps`
- `launch`
- `admin`
- `admin-ext`
- `app-home`
- `cli-app`
- `cli-core`
- `react-router`
- `webhooks-api`

### Optional include set (phase 2, as needed)

- `checkout-ui`
- `customer-account-ui`
- `pos-ui`
- `payments-apps`
- `admin-rest`
- `partner`

### Recommended exclude now

- `hydrogen`
- `hydrogen-react`
- `storefronts-headless`
- `storefront` (unless you start headless/storefront features)

## No page-limit flag

Page-limit flag is removed from the plan.

Why loops are already prevented in code:

- crawler tracks `visited` and skips already seen pages (`scripts/refs-shopify-docs.ts:144`, `scripts/refs-shopify-docs.ts:174`)
- crawler tracks `queued` and avoids duplicate enqueues (`scripts/refs-shopify-docs.ts:143`, `scripts/refs-shopify-docs.ts:163`)

So true infinite loops are not expected with current logic.

Worst-case scenarios are operational, not theoretical recursion:

- Shopify grows section size a lot (runtime + output size spike)
- prefix is broadened by mistake (downloads far more docs than intended)
- canonicalization misses a URL variant, causing cardinality blow-up
- long run fails late after downloading many files (wasted run time)

Recommendation:

- no page-cap flag
- rely on strict section-prefix boundaries and reviewed section selection

## CLI option design recommendation

Recommended CLI:

- `pnpm refs:shopify-docs --section admin --section apps`
- `pnpm refs:shopify-docs --list-sections`
- `pnpm refs:shopify-docs --section app-home`

Behavior:

- no `--section`: run default set
- repeatable `--section`
- unknown section: fail with valid list

## Notes to carry into implementation

- Use `.md` only for fetches.
- Consider normalizing duplicate slashes in path canonicalization (some app-home links appeared as `/docs/api/app-home//...`).
- Keep default section set aligned to your app goals; avoid pulling unrelated docs by default.
