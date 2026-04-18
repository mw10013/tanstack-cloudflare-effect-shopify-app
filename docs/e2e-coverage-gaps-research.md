# E2E Coverage Gaps — Research

Current state: `e2e/embedded-app-home.spec.ts` is the only spec. It loads the Shopify admin preview URL and asserts a Polaris `s-page` renders inside the embedded iframe. That's a smoke test — it proves the auth handshake and iframe mount, nothing more.

## Why embedded tests look awkward

Shopify admin wraps the app in an iframe whose URL carries `embedded=1&host=…&shop=…`. Playwright's `page.goto` lands on the admin shell, not the app. Tests must scope into the frame.

Cleanest primitive is `page.frameLocator(selector)` — lazy, auto-retrying, composes with regular locators:

```ts
const frame = page.frameLocator('iframe[src*="embedded=1"]');
await expect(frame.locator("s-page")).toBeVisible({ timeout: 60_000 });
```

No manual polling, no `page.frames()` loop. Use this pattern for every new spec.

## Gaps — ranked

### 1. Generate product happy path

Route: `src/routes/app.index.tsx:146`

Clicks "Generate a product", asserts toast + rendered JSON block. Covers the full stack: server fn → `authenticateAdmin` → admin GraphQL `productCreate` + `productVariantsBulkUpdate` → App Bridge toast (`app.index.tsx:139-144`) → React state render (`app.index.tsx:217-233`).

```ts
const frame = page.frameLocator('iframe[src*="embedded=1"]');
await frame.getByRole("button", { name: "Generate a product" }).first().click();
await expect(frame.locator("s-section").filter({ hasText: "productCreate mutation" })).toBeVisible();
await expect(frame.locator("code").first()).toContainText('"id": "gid://shopify/Product/');
```

Toast assertion is awkward — App Bridge toasts render outside the app iframe. Skip or assert via `window.shopify.toast` spy.

### 2. Nav to additional page

Routes: `src/routes/app.tsx:98-101`, `src/routes/app.additional.tsx:9`

Click "Additional page" in `s-app-nav`, assert `s-page heading="Additional page"`. Covers in-iframe client routing and `searchStr` preservation (critical — losing `host`/`shop` breaks auth on the next request).

```ts
await frame.getByRole("link", { name: "Additional page" }).click();
await expect(frame.locator('s-page[heading="Additional page"]')).toBeVisible();
```

### 3. Unauth redirect

Route guard: `src/routes/app.tsx:75-86`

Hit `/app` without storage state, assert redirect to Shopify auth (`/auth/login` or `admin.shopify.com/oauth`). Covers `beforeLoad` → `authenticateAdmin` → `redirect({ href })` path (`app.tsx:83-85`).

Needs a separate Playwright project without `storageState`, or `browser.newContext({ storageState: undefined })` inside the test.

### 4. Edit product intent

Route: `src/routes/app.index.tsx:161-169`

After generate, click "Edit product", assert `shopify.intents.invoke("edit:shopify/Product", …)` fires. App Bridge intent navigates admin — hard to assert navigation, easier to spy:

```ts
await frame.evaluate(() => {
  (window as any).__intents = [];
  const orig = (window as any).shopify.intents.invoke;
  (window as any).shopify.intents.invoke = (...args: unknown[]) => {
    (window as any).__intents.push(args);
    return orig?.(...args);
  };
});
// …click Edit product…
const calls = await frame.evaluate(() => (window as any).__intents);
expect(calls[0][0]).toBe("edit:shopify/Product");
```

### 5. Error path on generate

Route: `src/routes/app.index.tsx:212-216`

Force `productCreate` to fail (revoke `write_products` scope, or point to a dev store with restricted permissions), assert error section renders. Low-value given the cost of setting up a failure fixture — defer unless the error UI regresses.

## Not worth doing via Playwright

- **Webhooks** (`webhooks.app.scopes_update.ts`, `webhooks.app.uninstalled.ts`) — Shopify signs deliveries with HMAC. Simulating that in Playwright means forging signatures or using `shopify app webhook trigger`. Test these as unit tests against the route handler with a fixture payload + HMAC.
- **OAuth install flow** — already exercised by `shopify-admin.setup.ts` manual pause. Automating it fights Shopify's bot detection.

## Suggested next step

Add specs 1 and 2 first — they give the most coverage per line. Spec 3 needs a second Playwright project and is orthogonal. Specs 4 and 5 are polish.
