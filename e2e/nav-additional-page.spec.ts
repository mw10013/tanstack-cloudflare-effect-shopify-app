import { test, expect } from "@playwright/test";
import { requiredEnv } from "./env";

test("nav to additional page renders heading", async ({ page }) => {
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));
  const frame = page.frameLocator('iframe[src*="embedded=1"]');

  await expect(frame.locator("s-page")).toBeVisible();

  const outsideLink = page.getByRole("link", { name: "Additional page" });
  await expect(outsideLink).toBeVisible();
  await outsideLink.evaluate((element) => {
    (element as HTMLAnchorElement).click();
  });

  await expect(frame.locator('s-page[heading="Additional page"]')).toBeVisible();
});
