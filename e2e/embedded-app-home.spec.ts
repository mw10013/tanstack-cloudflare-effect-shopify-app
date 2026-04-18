import { test, expect } from "@playwright/test";
import { requiredEnv } from "./env";

const isEmbeddedFrameUrl = (url: string) =>
  url.includes("embedded=1") && url.includes("host=") && url.includes("shop=");

test("embedded app home loads", async ({ page }) => {
  test.setTimeout(2 * 60 * 1000);
  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));

  await expect
    .poll(
      () =>
        page
          .frames()
          .some((f) => f !== page.mainFrame() && isEmbeddedFrameUrl(f.url())),
      { timeout: 60_000 },
    )
    .toBe(true);

  const embeddedFrame = page
    .frames()
    .find((f) => f !== page.mainFrame() && isEmbeddedFrameUrl(f.url()));

  expect(embeddedFrame).toBeTruthy();
  if (!embeddedFrame) return;
  await expect(embeddedFrame.locator("body")).toBeVisible();
});
