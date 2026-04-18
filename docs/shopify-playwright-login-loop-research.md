# Shopify Playwright login loop research

## Scope

Captures what we learned about Shopify auth inside Playwright's Chromium, why in-Playwright login is unreliable in this environment, and the workaround this repo now ships.

## Problem

Running `e2e/shopify-admin.setup.ts` without an existing `playwright/.auth/shopify-admin.json` gets stuck in an email-lookup/captcha loop:

- Repro: `CI=1 pnpm exec playwright test e2e/shopify-admin.setup.ts --project=setup --headed`.
- Page stays on `Continue to Shopify` lookup. Submitting email navigates briefly to `newassets.hcaptcha.com/.../hcaptcha.html#frame=challenge...`, then returns to `accounts.shopify.com/lookup?...verify=<fresh-token>`.
- Sometimes the page shows: `Captcha couldn't load. Refresh the page and try again.`
- Happens regardless of whether Playwright drives the inputs or the developer clicks manually inside the Playwright-launched Chromium.

Opening the same preview URL in the developer's normal Chrome works fine — no captcha, no loop.

## What that tells us

Shopify's risk scoring fires at **login submit**, not on authed sessions. Playwright-launched Chromium is flagged at that moment (automation flags / `navigator.webdriver` / fingerprint), so the lookup form keeps returning a fresh verify token without advancing. Manual clicks inside that browser don't help because the context itself is flagged.

Post-login pages do **not** trigger the same challenge. Loading `admin.shopify.com/store/.../apps/<app>` with valid Shopify session cookies in the same Playwright Chromium renders the embedded app normally.

Concrete evidence: a `shopify-admin.json` saved months ago from a prior working session still bootstraps Playwright tests today. `_shopify_s` cookies have long TTLs (current file: valid through ~July 2026). Loading that file short-circuits login entirely and the tests pass.

## Grounding

- `refs/playwright/docs/src/best-practices-js.md:44-47` — "Avoid testing third-party dependencies / Only test what you control." Shopify auth + hCaptcha is third-party and risk-scored.
- `refs/playwright/docs/src/auth.md:40` — `storageState` reuse is the recommended model for tests without server-side state.
- `refs/playwright/docs/src/auth.md:127-129` — storage state needs occasional manual refresh; expiry is a normal operational concern.

## Current implementation

`e2e/shopify-admin.setup.ts` now does the minimum:

1. If `playwright/.auth/shopify-admin.json` exists, return immediately (cookies reused by the `e2e` project via `use.storageState`).
2. If CI and no file exists, throw with an explicit message — CI cannot bootstrap this.
3. Otherwise navigate to `SHOPIFY_PREVIEW_URL`, `page.pause()`, save storage state on resume.

`playwright.config.ts` wires `setup` as a dependency of `e2e`; the `e2e` project points `use.storageState` at the same path (`e2e/storage-state.ts`).

The test does **not** try to automate email/password entry. Attempts to do so looped on captcha. The pause path is kept only as a last resort and is known-brittle in this environment (see next section).

## Operational playbook

### Happy path

`pnpm test:e2e` — setup sees the file, returns; spec runs.

### Storage state expired or missing

The `page.pause()` fallback in setup is unreliable here: in-Playwright login submits keep looping on captcha even when a human clicks the button. Do not rely on it. Use this instead:

1. In your normal Chrome (not Playwright), confirm you are logged in at `https://admin.shopify.com/store/sandbox-shop-01/apps/<app-id>`.
2. Using a cookie export extension (e.g. "Cookie-Editor"), export cookies for `.shopify.com` / `admin.shopify.com` as JSON.
3. Write `playwright/.auth/shopify-admin.json` with the Playwright storage-state shape:
   ```json
   { "cookies": [ /* exported array */ ], "origins": [] }
   ```
   Field conversions that may be needed: `expirationDate` → `expires`, `hostOnly`/`session` dropped, `sameSite` values normalized to `Strict`/`Lax`/`None`.
4. Run `pnpm test:e2e`.

### When to re-bootstrap

Only when the spec starts failing with auth errors, or cookies visibly expire. `_shopify_s` typically has multi-month TTL, so this is rare.

## Rejected alternatives (for future reference)

- **Automated email/password entry in Playwright.** Loops on captcha. Not viable here.
- **Manual login via `page.pause()` in Playwright's Chromium.** Same loop; the browser context itself is flagged, not the click source.
- **`connectOverCDP` to a user-launched Chrome.** Would bypass the flag but adds a persistent Chrome process + port + user-data-dir to the workflow. Not worth the complexity given that saved storage state lasts months.
- **`launchPersistentContext` with a dedicated profile.** Still Playwright-launched, so the automation flag is still set at launch; not expected to change risk scoring meaningfully.

## Source references

- `e2e/shopify-admin.setup.ts`
- `e2e/storage-state.ts`
- `playwright.config.ts`
- `refs/playwright/docs/src/auth.md`
- `refs/playwright/docs/src/best-practices-js.md`
