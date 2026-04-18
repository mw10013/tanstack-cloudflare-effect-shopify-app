# Shopify embedded admin Playwright E2E

Run Playwright against the real Shopify admin embedded surface (iframe) and assert:
- Shopify admin loads the app home
- the embedded app iframe URL includes `embedded=1`, `host=`, `shop=`

Shopify embeds App Home in an iframe (`refs/shopify-docs/docs/apps/build/admin.md`):
```md
The Shopify admin provides a surface for apps to render the UX for their App Home. On the web, the surface is an iframe...
```

Playwright recommends a setup project + `storageState` (`refs/playwright/docs/src/auth.md`):
```md
...declare [setup] as a dependency... use the authenticated state as `storageState`.
```

## Current repo setup

- Config: `playwright/playwright.config.ts`
- Auth setup test: `playwright/tests/shopify-admin.setup.ts`
- Embedded assertion test: `playwright/tests/embedded-app-home.spec.ts`

## Preview URL (stable for this repo)

Default Preview URL (override with `SHOPIFY_PREVIEW_URL` if needed):
```text
https://admin.shopify.com/store/sandbox-shop-01/apps/9a91c9ff6ba488dafb39a7c696429753?dev-console=show
```

When the app is running via `pnpm shopify:dev`, Shopify admin will embed the app using a tunnel URL (often `*.trycloudflare.com`) and append `embedded=1`, `host=`, `shop=` to the iframe URL.

## Credential storage

`pnpm test:e2e:setup` writes Shopify admin cookies/storage to:
- `playwright/.auth/shopify-admin.json`

It is gitignored (`.gitignore` contains `playwright/.auth/`).

To force refresh login, set:
- `SHOPIFY_E2E_REAUTH=1`

## How to run (local)

1) Start Shopify dev:
   - `pnpm shopify:dev`
2) One-time login/bootstrap (headed):
   - `pnpm test:e2e:setup`
   - complete Shopify login in the browser
   - resume the paused Playwright run so it saves `playwright/.auth/shopify-admin.json`
3) Run embedded assertions (headed):
   - `pnpm test:e2e:chromium`
