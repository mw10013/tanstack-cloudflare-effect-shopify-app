import { test, expect } from "@playwright/test";
import { requiredEnv } from "./env";

test("embedded app home loads", async ({ page }) => {
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));
  const frame = page.frameLocator('iframe[src*="embedded=1"]');
  await expect(frame.locator("s-page")).toBeVisible();
});
