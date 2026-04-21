import { expect, test } from "@playwright/test";

import { requiredEnv } from "./env";

test("generate product from iframe button renders product JSON", async ({ page }) => {
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));

  const frame = page.frameLocator('iframe[src*="embedded=1"]');
  await expect(frame.locator("s-page")).toBeVisible();

  const outsideButton = page.getByRole("button", { name: "Generate a product" });
  await expect(outsideButton).toBeVisible();
  await expect(outsideButton).toBeEnabled();
  await outsideButton.click({ trial: true });

  const productSection = frame.locator('s-section[heading="Get started with products"]');
  const insideButton = productSection.getByRole("button", { name: "Generate a product" });
  await insideButton.click();

  const mutationSection = frame.locator('s-section[heading="productCreate mutation"]');
  await expect(mutationSection).toBeVisible();
  await expect(mutationSection.locator("code").first()).toContainText(
    '"id": "gid://shopify/Product/',
  );
  await expect(frame.getByRole("button", { name: "Edit product" })).toBeVisible();
});
