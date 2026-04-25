import { expect, test } from "@playwright/test";

import { requiredEnv } from "./env";

test("generate product from iframe button renders product JSON", async ({
  page,
}) => {
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));

  const frame = page.frameLocator('iframe[src*="embedded=1"]');
  await expect(frame.locator("s-page")).toBeVisible();

  const productSection = frame.locator(
    's-section[heading="Get started with products"]',
  );
  // Scope to the product section to target the section button, not the title-bar button.
  const productSectionGenerateButton = productSection.getByRole("button", {
    name: "Generate a product",
  });
  await productSectionGenerateButton.click();

  const mutationSection = frame.locator(
    's-section[heading="productCreate mutation"]',
  );
  await expect(mutationSection).toBeVisible();
  await expect(mutationSection.locator("code").first()).toContainText(
    '"id": "gid://shopify/Product/',
  );
  await expect(
    frame.getByRole("button", { name: "Edit product" }),
  ).toBeVisible();
});
