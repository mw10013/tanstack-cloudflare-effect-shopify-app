import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { requiredEnv } from "./env";

const waitForPage = async (page: Page): Promise<FrameLocator> => {
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));
  const frame = page.frameLocator('iframe[src*="embedded=1"]');
  await expect(frame.locator("s-page")).toBeVisible({ timeout: 60_000 });
  return frame;
};

const expectResult = (frame: FrameLocator) =>
  expect(frame.locator('s-section[heading="productCreate mutation"]')).toBeVisible({
    timeout: 20_000,
  });

test.describe("in-iframe s-button click strategies", () => {
  test.describe.configure({ timeout: 2 * 60 * 1000 });

  test("default click on host", async ({ page }) => {
    const frame = await waitForPage(page);
    await frame.locator('s-button:has-text("Generate a product")').first().click();
    await expectResult(frame);
  });

  test("force click on host", async ({ page }) => {
    const frame = await waitForPage(page);
    await frame
      .locator('s-button:has-text("Generate a product")')
      .first()
      .click({ force: true });
    await expectResult(frame);
  });

  test("click shadow-DOM inner button", async ({ page }) => {
    const frame = await waitForPage(page);
    await frame
      .locator('s-button:has-text("Generate a product")')
      .first()
      .locator("button")
      .click();
    await expectResult(frame);
  });

  test("dispatch composed MouseEvent", async ({ page }) => {
    const frame = await waitForPage(page);
    await frame
      .locator('s-button:has-text("Generate a product")')
      .first()
      .evaluate((el) => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      });
    await expectResult(frame);
  });

  test("hover then click host", async ({ page }) => {
    const frame = await waitForPage(page);
    const button = frame.locator('s-button:has-text("Generate a product")').first();
    await button.hover();
    await button.click();
    await expectResult(frame);
  });

  test("pointer sequence: down up click", async ({ page }) => {
    const frame = await waitForPage(page);
    await frame
      .locator('s-button:has-text("Generate a product")')
      .first()
      .evaluate((el) => {
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      });
    await expectResult(frame);
  });

  test("focus then keyboard Enter", async ({ page }) => {
    const frame = await waitForPage(page);
    const button = frame.locator('s-button:has-text("Generate a product")').first();
    await button.focus();
    await page.keyboard.press("Enter");
    await expectResult(frame);
  });

  test("focus then keyboard Space", async ({ page }) => {
    const frame = await waitForPage(page);
    const button = frame.locator('s-button:has-text("Generate a product")').first();
    await button.focus();
    await page.keyboard.press("Space");
    await expectResult(frame);
  });
});
