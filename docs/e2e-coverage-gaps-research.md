# E2E Coverage Gaps — Research

## Current state

The old version of this note is stale. The repo now has four real specs plus a setup project:

- `e2e/embedded-app-home.spec.ts:4-8` loads `SHOPIFY_PREVIEW_URL`, scopes into `iframe[src*="embedded=1"]`, and waits for `s-page`.
- `e2e/nav-additional-page.spec.ts:4-21` opens the embedded app, then clicks the mirrored Shopify admin chrome link for `Additional page` and asserts the iframe renders `s-page[heading="Additional page"]`.
- `e2e/generate-product.spec.ts:5-31` clicks the in-app `Generate a product` button, waits for the mutation output block, and checks that `Edit product` appears.
- `e2e/edit-product.spec.ts:5-42` generates a product, clicks `Edit product` in the iframe, parses the generated product title from the mutation JSON, and asserts the Shopify host surface switches to the product editor by matching both the top-level document title and the host heading.
- `playwright.config.ts:28-44` runs those specs only inside the `e2e` project, which depends on the `setup` project and always reuses `playwright/.auth/shopify-admin.json`.

That means current coverage is no longer “one smoke test”, but it is still almost entirely authenticated happy-path coverage.

## What the suite currently proves

- Embedded boot works: Shopify admin preview URL loads, iframe mounts, Polaris/App Bridge boot enough for the app shell to render.
- Secondary route rendering works when navigation is initiated from Shopify admin chrome.
- The product-generation happy path works end-to-end: button click → server fn → `shopifyServerFnMiddleware` → `authenticateAdmin` → `ProductRepository` GraphQL mutations → React state render in `src/routes/app.index.tsx:46-58` and `src/routes/app.index.tsx:119-135`.
- The main App Bridge handoff works for `Edit product`: the iframe click in `src/routes/app.index.tsx:61-68` opens Shopify's product editor in the host admin surface for the exact product just created, not merely some generic editor shell.

## Harness constraints that matter

### 1. Current Playwright config is biased toward authenticated tests

`playwright.config.ts:36-43` gives the `e2e` project a fixed `storageState`, and `e2e/shopify-admin.setup.ts:7-27` bootstraps that state manually. Any anonymous or expired-session coverage needs either:

- a second Playwright project without `storageState`, or
- an explicit fresh browser context inside a spec.

### 2. Embedded assertions still need `frameLocator`

For app DOM, `page.frameLocator('iframe[src*="embedded=1"]')` is still the right primitive. The home and product specs already use that pattern.

### 3. Shopify admin chrome and app DOM are different surfaces

The current nav spec intentionally clicks an outer-page locator:

```ts
const outsideLink = page.getByRole("link", { name: "Additional page" });
await outsideLink.evaluate((element) => {
  (element as HTMLAnchorElement).click();
});
```

That is useful for shell-level navigation coverage, but it does not prove the in-app navigation bridge in `src/components/AppProvider.tsx:10-22`.

## Gaps — ranked

### 1. Auth entry and redirect coverage is still missing

This is the biggest blind spot.

Relevant code paths:

- `src/routes/index.tsx:3-8` redirects `/?shop=...` to `/app...`.
- `src/routes/auth.login.ts:44-79` serves the login form on `GET` and handles shop-domain validation on `POST`.
- `src/routes/app.tsx:95-117` enforces auth in `beforeLoad`.
- `src/lib/Shopify.ts:446-503` contains the real redirect branches: missing `shop`/`host`, missing `embedded=1`, missing `id_token`, and unauthorized fallback.

Today none of that is exercised by Playwright because every spec starts from an authenticated preview URL with stored cookies.

Highest-value cases:

1. `GET /` renders the plain login form.
2. `GET /?shop=<shop>` redirects to `/app?<same-search>`.
3. `GET /app` in a clean context redirects to `/auth/login`.
4. `POST /auth/login` with invalid input re-renders inline `Invalid shop domain`.
5. Optionally, `POST /auth/login` with a valid shop asserts the redirect location points at Shopify install, without trying to finish OAuth.

These are strong candidates because they are local, deterministic, and cover the branchiest code in the app.

### 2. App-side navigation is only partially covered

The existing nav spec proves that Shopify admin chrome can switch the iframe to `/app/additional`, but it does not prove the app’s own navigation glue:

- `src/routes/app.tsx:123-129` builds nav hrefs with `searchStr` preservation.
- `src/components/AppProvider.tsx:10-22` listens for `shopify:navigate` and forwards to TanStack `navigate({ to: href })`.

If either of those broke, the current spec could still pass because it clicks the mirrored outer-shell link, not the app-side navigation event path.

The missing assertion is: a navigation initiated from inside the app should preserve the embedded query params and land on the correct route.

Best version of this test:

1. Start on the embedded home route.
2. Trigger navigation from inside the iframe or dispatch the app-side `shopify:navigate` path.
3. Assert `Additional page` renders.
4. Assert the iframe URL still contains the auth-critical params (`shop`, `host`, usually `embedded=1`).
5. Optionally reload and confirm the route still survives auth.

### 3. Product-generation failure UX is untested

The home route has explicit error UI:

- `src/routes/app.index.tsx:46-58` catches the server-fn failure and stores `error`.
- `src/routes/app.index.tsx:114-117` renders `s-section[heading="Request failed"]`.

There is also auth/error behavior below the button click that is not covered:

- `src/lib/ShopifyServerFnMiddleware.ts:37-59` injects the App Bridge session token and re-runs `authenticateAdmin` on the server.
- `src/lib/Shopify.ts:403-428` returns retry/redirect responses for invalid session tokens.

This is lower priority than the auth entry coverage because it is harder to force deterministically, but it is the main remaining user-visible failure state on the app home page.

## Not worth doing with Playwright

### Webhook handlers

`src/routes/webhooks.app.scopes_update.ts:12-38` and `src/routes/webhooks.app.uninstalled.ts:20-36` both sit behind `shopify.authenticateWebhook`, which validates HMAC in `src/lib/Shopify.ts:337-388`.

That is a poor fit for Playwright. Better test level: route/integration tests with fixture payloads and signed headers.

### Full OAuth install flow

`e2e/shopify-admin.setup.ts:18-27` already documents the reality here: login bootstrap is manual when storage state is missing. Automating the full Shopify auth flow in Playwright fights Shopify bot detection and is not a good regression target for this repo.

## Recommended next work

If adding more E2E coverage now, I would do it in this order:

1. Add local auth-entry specs for `/`, `/?shop=...`, `/app` without storage state, and invalid `/auth/login` POST.
2. Add one embedded spec that proves app-side navigation preserves embedded query params, not just outer admin chrome navigation.
3. Add one failure-path spec for product generation or invalid embedded session recovery, if we can make the setup deterministic enough to avoid flaky Shopify-side failures.

That sequence closes the biggest coverage holes without taking on OAuth or webhook complexity.
