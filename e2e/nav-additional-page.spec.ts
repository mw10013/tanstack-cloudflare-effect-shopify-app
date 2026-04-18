import { test, expect } from "@playwright/test";
import { requiredEnv } from "./env";

test("nav to additional page renders heading", async ({ page }) => {
  test.setTimeout(2 * 60 * 1000);
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));
  const frame = page.frameLocator('iframe[src*="embedded=1"]');

  await expect(frame.locator("s-page")).toBeVisible({ timeout: 60_000 });

  const href = await page
    .getByRole("link", { name: "Additional page" })
    .evaluate((el: HTMLAnchorElement) => el.href);
  await page.goto(href);

  await expect(frame.locator('s-page[heading="Additional page"]')).toBeVisible({
    timeout: 60_000,
  });
});
