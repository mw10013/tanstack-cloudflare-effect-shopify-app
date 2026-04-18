# Shopify embedded admin Playwright E2E

This repo runs Playwright against Shopify Admin (embedded iframe) and checks that the app home iframe is present and uses embedded params (`embedded=1`, `host=`, `shop=`).

Shopify admin embed model reference:
- `refs/shopify-docs/docs/apps/build/admin.md`

Playwright auth-with-setup pattern reference:
- `refs/playwright/docs/src/auth.md`
- `refs/playwright/docs/src/getting-started-vscode-js.md`

## Current repo setup

- Config: `playwright.config.ts`
- Test directory: `e2e/`
- Setup/auth test: `e2e/shopify-admin.setup.ts`
- Embedded assertion test: `e2e/embedded-app-home.spec.ts`
- Auth storage file: `playwright/.auth/shopify-admin.json` (gitignored in `.gitignore`)

## Current test inventory

`pnpm exec playwright test --list` currently reports 2 tests in 2 files:
- `shopify-admin.setup.ts > shopify admin auth`
- `embedded-app-home.spec.ts > embedded app home loads`

`pnpm test:e2e` runs only `*.spec.ts` tests.
`pnpm test:e2e:setup` runs only `*.setup.ts` tests.

## Preview URL

Default preview URL (override with `SHOPIFY_PREVIEW_URL`):

```text
https://admin.shopify.com/store/sandbox-shop-01/apps/9a91c9ff6ba488dafb39a7c696429753?dev-console=show
```

## Local run flow

1) Start Shopify dev tunnel:
- `pnpm shopify:dev`

2) Bootstrap/reuse admin auth (headed):
- `pnpm test:e2e:setup`
- Force a fresh login: `SHOPIFY_E2E_REAUTH=1 pnpm test:e2e:setup`
- Log in in the opened browser.
- Resume the paused test to persist `playwright/.auth/shopify-admin.json`.

3) Run embedded assertion test (headed):
- `pnpm test:e2e:run`

## VS Code Playwright extension notes

- There are no Playwright projects in config now.
- Test Explorer should show both files in `e2e/` directly.
- If one is missing, use the Playwright sidebar refresh action and reload the VS Code window.
