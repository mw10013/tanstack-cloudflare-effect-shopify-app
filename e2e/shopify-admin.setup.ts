import { test as setup } from "@playwright/test";
import * as fs from "fs";
import path from "path";

/**
 * Playwright "setup" project used by embedded Shopify Admin E2E.
 *
 * Why this exists:
 * - Shopify Admin pages require login; a fresh Playwright browser context will prompt for it.
 * - This setup test saves an authenticated `storageState` so subsequent tests can reuse it.
 *
 * Behavior:
 * - If `playwright/.auth/shopify-admin.json` exists and `SHOPIFY_E2E_REAUTH` !== "1", exit quickly.
 * - Otherwise open `SHOPIFY_PREVIEW_URL` (or the repo default), pause for manual login, then save
 *   `storageState` to `playwright/.auth/shopify-admin.json` (gitignored).
 */
setup("shopify admin auth", async ({ page }) => {
  setup.setTimeout(10 * 60 * 1000);
  const storageStatePath = path.join(
    process.cwd(),
    "playwright",
    ".auth",
    "shopify-admin.json",
  );
  await fs.promises.mkdir(path.dirname(storageStatePath), { recursive: true });

  const shouldReauth = process.env.SHOPIFY_E2E_REAUTH === "1";
  if (!shouldReauth) {
    try {
      await fs.promises.stat(storageStatePath);
      return;
    } catch (_error) {
      void _error;
    }
  }

  const defaultPreviewUrl =
    "https://admin.shopify.com/store/sandbox-shop-01/apps/9a91c9ff6ba488dafb39a7c696429753?dev-console=show";
  await page.goto(process.env.SHOPIFY_PREVIEW_URL ?? defaultPreviewUrl);
  await page.pause();
  await page.context().storageState({ path: storageStatePath });
});
