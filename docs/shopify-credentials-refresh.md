# Shopify Playwright credentials refresh

## Problem

`playwright/.auth/shopify-admin.json` cookies expire periodically. `_shopify_s` has a ~4-week TTL; `koa.sid` has a similar short TTL. When they expire, all e2e tests fail with auth errors.

Login through Playwright-launched Chrome is not viable due to hCaptcha (see `docs/shopify-playwright-login-loop-research.md`). Cookies must be extracted from a normal Chrome session.

## Cookie TTLs (observed)

| Cookie | Domain | TTL |
|---|---|---|
| `_shopify_s` | `.shopify.com` | ~4 weeks |
| `koa.sid` | `admin.shopify.com` | ~4 weeks |
| `_identity_session` | `accounts.shopify.com` | ~13 months |
| `_merchant_essential` | `.shopify.com` | ~12 months |

Only `_shopify_s` and `koa.sid` need frequent refresh.

## Option A: CDP export (recommended)

Uses Chrome DevTools Protocol to extract cookies from a running Chrome session. No manual copy-paste.

### Do I need to close Chrome first?

Only if Chrome is not already running with `--remote-debugging-port=9222`. CDP cannot attach to an already-running Chrome launched without that flag. **Your Shopify session and tabs are preserved** — Chrome restores open tabs on relaunch and session cookies survive a quit/reopen cycle, so you will still be logged in.

To skip this step in the future, always launch Chrome with the debug flag:
```bash
alias chrome='open -a "Google Chrome" --args --remote-debugging-port=9222'
```

### Steps

1. Quit Chrome if it is running without the debug flag.

2. Launch Chrome with remote debugging enabled:
   ```bash
   open -a "Google Chrome" --args --remote-debugging-port=9222
   ```

3. Navigate to `https://admin.shopify.com/store/sandbox-shop-01` and confirm you are logged in.

4. Run the export script:
   ```bash
   node scripts/cdp-export-cookies.ts
   ```

`scripts/cdp-export-cookies.ts` connects to `http://localhost:9222`, calls `Network.getAllCookies`, filters to Shopify domains (`.shopify.com`, `admin.shopify.com`, `accounts.shopify.com`), and writes `playwright/.auth/shopify-admin.json`.

5. Verify:
   ```bash
   pnpm test:e2e
   ```

## Option B: Cookie-Editor extension (fallback)

If CDP is not viable (e.g., Chrome already open with other tabs you cannot close):

1. In normal Chrome, navigate to `https://admin.shopify.com/store/sandbox-shop-01`.
2. Open Cookie-Editor extension → Export (copies JSON to clipboard).
3. Also navigate to `https://accounts.shopify.com` and export those cookies.
4. Merge both arrays into one. Write `playwright/.auth/shopify-admin.json`:
   ```json
   { "cookies": [ /* merged array */ ], "origins": [] }
   ```
5. Field conversions from Cookie-Editor format:
   - `expirationDate` → `expires` (same float value)
   - Drop `hostOnly`, `session`, `id`, `storeId`
   - Normalize `sameSite`: `"unspecified"` → `"Lax"`, capitalize first letter

## Troubleshooting

**CDP: `No Chrome tab found`** — Chrome is not running with the debug flag. Repeat step 1-2.

**CDP: `fetch failed` / connection refused** — Port 9222 is not open. Another process may be using it, or Chrome launched without the flag.

**Tests still fail after refresh** — Confirm the app is running (`pnpm dev`) and `SHOPIFY_PREVIEW_URL` in `.env.playwright` points to a valid embedded-app URL for the logged-in store.
