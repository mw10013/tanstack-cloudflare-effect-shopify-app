import { test, expect } from "@playwright/test";
import { requiredEnv } from "./env";

/**
 * Exercises the full generate-product path: click → `generateProduct`
 * server fn → admin GraphQL `productCreate` + `productVariantsBulkUpdate`
 * → result JSON rendered in-page.
 *
 * Skipped: clicks the admin-chrome `primary-action`-slotted button
 * (`app.index.tsx:174`), rendered by Shopify admin *outside* the iframe,
 * because Playwright clicks on the in-iframe `<s-button>` do not cause the
 * UI to update (no loading state, no result, no error), even though a
 * DOM click fires on the host element. Manual clicks in the dev preview
 * work — so the app is fine; the problem is Playwright-side. Until the
 * in-iframe click path is understood (see
 * `iframe-button-click.investigate.spec.ts`), avoid codifying the
 * admin-chrome workaround as the rule.
 *
 * Frame targeting: the embedded app runs inside an iframe whose URL carries
 * `embedded=1&host=…&shop=…` — `iframe[src*="embedded=1"]` selects it and
 * `frameLocator` lazily retries inside it, replacing manual `page.frames()`
 * polling.
 *
 * Section selector: `s-section[heading="productCreate mutation"]` is
 * strict — `filter({ hasText: "productCreate mutation" })` would also
 * match the "Get started with products" section because its intro
 * paragraph mentions "productCreate mutation in our API references",
 * causing the assertion to pass instantly before the result renders.
 */
test("generate product creates and renders product JSON", async ({ page }) => {
  test.setTimeout(2 * 60 * 1000);
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));
  const frame = page.frameLocator('iframe[src*="embedded=1"]');

  await expect(frame.locator("s-page")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Generate a product" }).first().click();

  const mutationSection = frame.locator('s-section[heading="productCreate mutation"]');
  await expect(mutationSection).toBeVisible({ timeout: 30_000 });
  await expect(mutationSection.locator("code").first()).toContainText(
    '"id": "gid://shopify/Product/',
  );
  await expect(frame.getByRole("button", { name: "Edit product" })).toBeVisible();
});
