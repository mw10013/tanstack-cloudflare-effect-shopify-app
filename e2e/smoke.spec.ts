import { test, expect } from "@playwright/test";

test("index renders", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("tanstack-cloudflare-effect-shopify-app"),
  ).toBeVisible();
});
