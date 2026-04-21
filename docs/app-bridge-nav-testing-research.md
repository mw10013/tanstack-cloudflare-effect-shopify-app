# App Bridge nav testing research (updated)

## Scope

This note captures what we could actually verify about Shopify App Bridge nav behavior in this repo, plus stable testing workarounds.

## Confirmed facts

1. App nav in Shopify admin is outside iframe; app content is inside iframe.
   - `refs/shopify-docs/docs/api/app-home.md:42`
   - `refs/shopify-docs/docs/api/app-home.md:44`
   - `refs/shopify-docs/docs/api/app-home.md:113`

2. Our outside nav is declared in `s-app-nav`.
   - `src/routes/app.tsx:110`

3. The "inside" link is separate page content, not the same element as outside sidebar link.
   - `src/routes/app.index.tsx:211`

4. App Bridge navigation is bridged through `shopify:navigate` listener in app provider.
   - `src/components/AppProvider.tsx:18`
   - ref parity: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:125`

## What we observed directly (local probes)

1. The outside `Additional page` anchor is visible and has normal link attrs.
2. A higher ancestor has `aria-disabled="true"` (observed repeatedly).
3. That ancestor stayed `aria-disabled="true"` for 60s in sampling.
4. Playwright `toBeEnabled()` fails on this locator due to actionability rules.
   - Playwright rule: descendant of `[aria-disabled=true]` is considered disabled.
   - `refs/playwright/docs/src/actionability.md:101`
5. Human-like automation click by coordinates on the link area did not navigate in this run.
6. Native DOM click via `evaluate((el) => el.click())` did navigate in this run.

## Why Playwright blocks `locator.click()`

Playwright enabled check is strict:

- "Element is considered enabled when it is not disabled" (`refs/playwright/docs/src/actionability.md:96`)
- disabled includes descendants of `[aria-disabled=true]` (`refs/playwright/docs/src/actionability.md:101`)

So a link can look clickable to a user, while Playwright rejects actionability on that node.

## Web evidence: similar Shopify nav instability exists

Not the exact same `aria-disabled` report, but many reports of App Bridge nav regressions/host-shell changes:

- `ui-nav-menu` links stop navigating: https://community.shopify.dev/t/ui-nav-menu-just-stopped-working/32671
- root-path nav bug affecting many apps: https://community.shopify.dev/t/embedded-app-navigation-bug-on-root-path-affects-all-apps/13723
- first item disappeared/merged with app name: https://community.shopify.dev/t/app-navigation-menu-link-disappeared-first-link-merged-with-app-name/21870
- first item not displayed: https://community.shopify.dev/t/shopify-admin-not-displaying-the-first-item-in-ui-nav-menu/21846
- `s-app-nav`/`s-link` behavior regressions and CDN fixes: https://community.shopify.dev/t/s-link-in-s-app-nav-not-working-after-adding-polaris-js/23567
- sidebar not updating reactively in some setups: https://community.shopify.dev/t/is-the-apps-left-sidebar-no-longer-updated-with-ui-nav-menu/28703

Conclusion: host-side nav behavior does regress and vary by rollout/store/runtime. Our local `aria-disabled` finding is consistent with that instability, but not officially documented as intended behavior.

## Workarounds we use

1. For route behavior tests, prefer iframe route interactions and assertions.
2. For outside nav integration, assert presence + href contract separately.
3. If outside nav click is required in this env:
   - wait visible on outside link
   - trigger native click via `evaluate((el) => (el as HTMLAnchorElement).click())`
   - do not gate on `toBeEnabled()` for this specific outside locator

Current test implementation:

- `e2e/nav-additional-page.spec.ts:10`

## What not to rely on

1. Waiting for outside `Generate a product` button as nav readiness signal.
   - It proves page shell readiness, not outside nav actionability.
2. Assuming `force: true` equals reliable navigation.
   - In our run, `force: true` click still did not navigate to additional page.

## Minimal debug checklist

1. Re-run with trace:
   - `npm run test:e2e -- e2e/nav-additional-page.spec.ts --project=e2e --trace on --headed`
2. Inspect outside link + ancestors:
   - `aria-disabled`
   - `href`
   - computed `pointer-events`
3. Verify navigation outcome by URL and iframe heading assertion.
