# Shopify Playwright login loop research

## Scope

This doc captures the current failure mode where Shopify auth in `e2e/shopify-admin.setup.ts` loops on email lookup and never reaches embedded app state, even with email/password automation.

## Current failure signal

Repro command:

```bash
CI=1 pnpm exec playwright test e2e/shopify-admin.setup.ts --project=setup --headed
```

Observed result:

- Test fails at `e2e/shopify-admin.setup.ts:175` waiting for embedded frame.
- Error: `Timeout 120000ms exceeded while waiting on the predicate`.
- Retries fail the same way.

## Evidence collected

### 1) Page remains on Shopify login lookup

From failure snapshots:

- `playwright/test-results/shopify-admin.setup.ts-shopify-admin-auth-setup/error-context.md`
- `playwright/test-results/shopify-admin.setup.ts-shopify-admin-auth-setup-retry1/error-context.md`
- `playwright/test-results/shopify-admin.setup.ts-shopify-admin-auth-setup-retry2/error-context.md`

All three snapshots show the same page shape:

- Heading: `Log in` / `Continue to Shopify`
- Email textbox present
- Button: `Continue with email`
- No transition to embedded app frame

### 2) Playwright API debug run shows captcha-gated submit behavior

Repro command:

```bash
DEBUG=pw:api pnpm exec playwright test e2e/shopify-admin.setup.ts --project=setup --headed
```

Key excerpts from run output:

```text
locator resolved to <button ... disabled="disabled" ... class="... login-button ...">
element is not enabled
...
navigated to "https://newassets.hcaptcha.com/.../hcaptcha.html#frame=challenge..."
...
navigated to "https://accounts.shopify.com/lookup?...verify=..."
```

Interpretation:

- Submit button state is controlled by invisible hCaptcha/risk checks.
- Submission can occur, but server often returns to lookup route with a fresh verify token.

### 3) Raw page HTML captured during loop includes captcha failure banner in some runs

Observed HTML includes:

```html
<p>Captcha couldn't load. Refresh the page and try again.</p>
<button class="ui-button" id="refresh-page-trigger">Refresh</button>
```

This confirms captcha availability is a hard dependency of the login transition.

## Why automation is brittle here

Grounded by Playwright docs + current flow:

- `refs/playwright/docs/src/best-practices-js.md:44-47`:
  - "Avoid testing third-party dependencies"
  - "Only test what you control"
- Shopify auth + hCaptcha is third-party/risk-scored and outside this repo's control.
- `refs/playwright/docs/src/auth.md:127-129` explicitly expects manual auth refresh from time to time in setup flows.

So the weakness is not only selector quality. The auth system can reject/loop even when selectors and clicks are valid.

## Code context (current setup)

- `playwright.config.ts` uses projects + dependencies (`setup` -> `e2e`).
- `e2e/shopify-admin.setup.ts` currently attempts:
  - email submit,
  - optional captcha refresh button click,
  - password submit,
  - revisit preview URL,
  - wait for embedded iframe (`embedded=1`, `host=`, `shop=`).
- Even with these guards, auth loop persists in this environment.

## Options

### Option 1: Keep full auto-login (current direction)

Pros:

- No manual interaction when it works.

Cons:

- Flaky/blocked by captcha risk scoring.
- Fails nondeterministically across machines/networks.

### Option 2: Hybrid bootstrap (recommended)

Behavior:

- First run without storage state: open login + pause for manual completion.
- After user reaches app/admin state, save `storageState`.
- Subsequent runs are fully automated via stored state.
- If state expires, delete `playwright/.auth/shopify-admin.json` and repeat once.

Pros:

- Reliable with Shopify captcha/challenge variations.
- Still no separate special command; remains inside normal `pnpm test:e2e` flow.

Cons:

- First-run/manual refresh is required.

### Option 3: Externalize auth bootstrap outside Playwright test runner

Examples: custom script, manual browser profile capture, or non-Playwright login tooling.

Pros:

- Can decouple from per-test retries/timeout semantics.

Cons:

- Adds maintenance surface and custom tooling.

## Recommendation

Adopt Option 2 as the default policy for this repo:

- Keep project dependencies (`setup` before `e2e`).
- Treat Shopify auth as challenge-prone and support manual completion fallback during setup.
- Keep explicit failure message for lookup-loop/captcha-loop states.

This aligns with Playwright guidance for auth-state reuse while acknowledging third-party auth constraints.

## Source references

- `e2e/shopify-admin.setup.ts`
- `playwright.config.ts`
- `playwright/test-results/shopify-admin.setup.ts-shopify-admin-auth-setup/error-context.md`
- `playwright/test-results/shopify-admin.setup.ts-shopify-admin-auth-setup-retry1/error-context.md`
- `playwright/test-results/shopify-admin.setup.ts-shopify-admin-auth-setup-retry2/error-context.md`
- `refs/playwright/docs/src/best-practices-js.md`
- `refs/playwright/docs/src/auth.md`
