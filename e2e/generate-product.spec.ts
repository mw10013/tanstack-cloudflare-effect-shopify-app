import { test, expect } from "@playwright/test";
import { requiredEnv } from "./env";

test("generate product creates and renders product JSON", async ({ page }) => {
  test.setTimeout(2 * 60 * 1000);
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));
  const frame = page.frameLocator('iframe[src*="embedded=1"]');

  await expect(frame.locator("s-page")).toBeVisible({ timeout: 60_000 });
  await frame.getByRole("button", { name: "Generate a product" }).first().click();

  const mutationSection = frame
    .locator("s-section")
    .filter({ hasText: "productCreate mutation" });
  await expect(mutationSection).toBeVisible({ timeout: 30_000 });
  await expect(mutationSection.locator("code").first()).toContainText(
    '"id": "gid://shopify/Product/',
  );
  await expect(frame.getByRole("button", { name: "Edit product" })).toBeVisible();
});
