import { test, expect } from "@playwright/test";
import { requiredEnv } from "./env";

test("nav to additional page renders heading", async ({ page }) => {
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));
  const frame = page.frameLocator('iframe[src*="embedded=1"]');

  await expect(frame.locator("s-page")).toBeVisible();

  const outsideLink = page.getByRole("link", { name: "Additional page" });
  await expect(outsideLink).toBeVisible();
  // In Shopify admin chrome, this link can be under an ancestor with
  // aria-disabled="true" even when it appears clickable to humans.
  // Playwright actionability treats descendants of aria-disabled ancestors as
  // disabled, so locator.click()/toBeEnabled() can fail. Trigger a native DOM
  // click on the link element after visibility check.
  await outsideLink.evaluate((element) => {
    (element as HTMLAnchorElement).click();
  });

  await expect(frame.locator('s-page[heading="Additional page"]')).toBeVisible();
});
