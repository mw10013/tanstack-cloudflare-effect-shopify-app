import { expect, test as setup } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as fs from "fs";
import path from "path";
import { requiredEnv } from "./env";
import { storageStatePath } from "./storage-state";

/**
 * Playwright "setup" project used by embedded Shopify Admin E2E.
 *
 * Why this exists:
 * - Shopify Admin pages require login; a fresh Playwright browser context will prompt for it.
 * - This setup test saves an authenticated `storageState` so subsequent tests can reuse it.
 *
 * Behavior:
 * - If `playwright/.auth/shopify-admin.json` exists, exit quickly.
 * - Otherwise open `SHOPIFY_PREVIEW_URL`, login with `SHOPIFY_E2E_LOGIN_EMAIL`
 *   + `SHOPIFY_E2E_LOGIN_PASSWORD`, then save `storageState` to
 *   `playwright/.auth/shopify-admin.json` (gitignored).
 */
const isEmbeddedFrameUrl = (url: string) =>
  url.includes("embedded=1") && url.includes("host=") && url.includes("shop=");

const hasEmbeddedFrame = (page: Page) =>
  page
    .frames()
    .some((f) => f !== page.mainFrame() && isEmbeddedFrameUrl(f.url()));

const waitForEmbeddedFrame = async (page: Page, timeoutMs: number) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (hasEmbeddedFrame(page)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

setup("shopify admin auth", async ({ page }) => {
  setup.setTimeout(10 * 60 * 1000);
  await fs.promises.mkdir(path.dirname(storageStatePath), { recursive: true });

  try {
    await fs.promises.stat(storageStatePath);
    return;
  } catch (_error) {
    void _error;
  }

  const previewUrl = requiredEnv("SHOPIFY_PREVIEW_URL");
  const loginEmail = requiredEnv("SHOPIFY_E2E_LOGIN_EMAIL");
  const loginPassword = requiredEnv("SHOPIFY_E2E_LOGIN_PASSWORD");

  await page.goto(previewUrl);

  if (
    page
      .frames()
      .some((f) => f !== page.mainFrame() && isEmbeddedFrameUrl(f.url()))
  ) {
    await page.context().storageState({ path: storageStatePath });
    return;
  }

  const accountLookupForm = page.locator("form#account_lookup").first();

  const submitLookupForm = async () => {
    const primaryLoginButton = accountLookupForm
      .locator('button.login-button[type="submit"], button[type="submit"]')
      .first();

    if (await primaryLoginButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await primaryLoginButton.click();
      return;
    }

    await accountLookupForm.evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
    });
  };

  const refreshCaptchaButton = page.locator("#refresh-page-trigger").first();
  const captchaErrorBanner = page
    .getByText(/Captcha couldn't load\. Refresh the page and try again\./i)
    .first();

  if (await captchaErrorBanner.isVisible({ timeout: 2000 }).catch(() => false)) {
    await refreshCaptchaButton.click();
    await page.waitForLoadState("domcontentloaded");
  }

  const emailInput = accountLookupForm
    .locator(
      'input[name="account[email]"], input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name="email"]',
    )
    .first();

  if (await emailInput.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await emailInput.fill(loginEmail);
    await submitLookupForm();
  }

  if (await captchaErrorBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
    await refreshCaptchaButton.click();
    await page.waitForLoadState("domcontentloaded");
    if (await emailInput.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await emailInput.fill(loginEmail);
      await submitLookupForm();
    }
  }

  const passwordInputByName = accountLookupForm
    .locator(
      'input[name="account[password]"]:not([tabindex="-1"]), input[type="password"]:not([tabindex="-1"]), input[autocomplete="current-password"]:not([tabindex="-1"]), input[name="password"]:not([tabindex="-1"])',
    )
    .first();

  const passwordInputByLabel = page.getByLabel(/password/i).first();

  const resolvePasswordInput = async () => {
    if (
      await passwordInputByName.isVisible({ timeout: 1000 }).catch(() => false)
    ) {
      return passwordInputByName;
    }
    if (
      await passwordInputByLabel.isVisible({ timeout: 1000 }).catch(() => false)
    ) {
      return passwordInputByLabel;
    }
    return null;
  };

  let passwordInput = await resolvePasswordInput();

  if (!passwordInput) {
    await submitLookupForm();
    passwordInput = await resolvePasswordInput();
  }

  if (!passwordInput) {
    await expect
      .poll(
        async () => {
          const resolvedPasswordInput = await resolvePasswordInput();
          if (resolvedPasswordInput) return "password";
          if (
            page
              .frames()
              .some((f) => f !== page.mainFrame() && isEmbeddedFrameUrl(f.url()))
          ) {
            return "embedded";
          }
          return "pending";
        },
        { timeout: 30_000 },
      )
      .not.toBe("pending");
    passwordInput = await resolvePasswordInput();
  }

  if (passwordInput) {
    await passwordInput.fill(loginPassword);
    await submitLookupForm();
  }

  await page.goto(previewUrl);

  const embeddedAfterAutoAttempt = await waitForEmbeddedFrame(page, 30_000);

  if (!embeddedAfterAutoAttempt && !process.env.CI) {
    await page.pause();
    await page.goto(previewUrl);
  }

  await expect
    .poll(() => hasEmbeddedFrame(page), { timeout: 120_000 })
    .toBe(true);

  await page.context().storageState({ path: storageStatePath });
});
