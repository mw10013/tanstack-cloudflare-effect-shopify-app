import { expect, test } from "@playwright/test";

import { requiredEnv } from "./env";

test("edit product opens Shopify product editor", async ({ page }) => {
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));

  const frame = page.frameLocator('iframe[src*="embedded=1"]');
  await expect(frame.locator("s-page")).toBeVisible({ timeout: 30000 });

  const productSection = frame.locator(
    's-section[heading="Get started with products"]',
  );
  await productSection
    .getByRole("button", { name: "Generate a product" })
    .click();

  const mutationSection = frame.locator(
    's-section[heading="productCreate mutation"]',
  );
  await expect(mutationSection).toBeVisible();

  const product = JSON.parse(
    (await mutationSection.locator("code").first().textContent()) ?? "{}",
  ) as { readonly title?: string };
  const productTitle = product.title;
  if (!productTitle) {
    throw new Error("Missing generated product title");
  }

  await frame.getByRole("button", { name: "Edit product" }).click();

  await expect(
    page,
  ).toHaveTitle(
    new RegExp(
      productTitle.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`),
    ),
  );
  await expect(
    page.getByRole("heading", { name: productTitle, exact: true }).first(),
  ).toBeVisible();
});
