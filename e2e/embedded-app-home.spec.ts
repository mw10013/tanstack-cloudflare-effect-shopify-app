import { test, expect } from "@playwright/test";
import { storageStatePath } from "./storage-state";

const isEmbeddedFrameUrl = (url: string) =>
  url.includes("embedded=1") && url.includes("host=") && url.includes("shop=");

test.use({ storageState: storageStatePath });

test("embedded app home loads", async ({ page }) => {
  test.setTimeout(2 * 60 * 1000);
  const defaultPreviewUrl =
    "https://admin.shopify.com/store/sandbox-shop-01/apps/9a91c9ff6ba488dafb39a7c696429753?dev-console=show";
  await page.goto(process.env.SHOPIFY_PREVIEW_URL ?? defaultPreviewUrl);

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
