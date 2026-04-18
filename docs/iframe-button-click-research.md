# In-iframe Polaris Button Click — Research

## Problem

Playwright cannot trigger `<s-button onClick={handler}>` rendered inside the Shopify admin embedded-app iframe. Human clicks in the dev preview work. Eight Playwright strategies all fail: the UI never updates (no loading state, no result, no error).

Test matrix: `e2e/iframe-button-click.investigate.spec.ts`.

## Observations

- Playwright's `.click()` lands a DOM `click` on the `<s-button>` host — confirmed via ad-hoc `el.addEventListener("click", ...)` during debugging.
- `dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))` produces a blue focus outline — event reaches the host element — but doesn't trigger the React handler.
- The same React handler, bound to a `primary-action`-slotted `<s-button>` that Shopify admin renders *outside* the iframe in admin chrome, fires correctly via `page.getByRole("button").click()`.

## Strategies tried (8 / 8 failed)

1. Default `.click()` on `<s-button>` host
2. `.click({ force: true })`
3. Click on shadow-DOM inner `button` (via `locator('s-button').locator('button')`)
4. `dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))`
5. `hover()` then `click()`
6. `dispatchEvent` sequence: `pointerdown` → `pointerup` → `click`
7. `focus()` then `keyboard.press("Enter")`
8. `focus()` then `keyboard.press("Space")`

## Grounded findings

### Playwright — shadow DOM is not the blocker

`refs/playwright/docs/src/locators.md:700-704`:

> All locators in Playwright **by default** work with elements in Shadow DOM. The exceptions are:
> - Locating by XPath does not pierce shadow roots.
> - Closed-mode shadow roots are not supported.

We successfully locate the `<s-button>` host (text matches it), and strategy 3 found a child `button` to click. So Polaris either uses open shadow roots or no shadow. Shadow-DOM piercing is not the cause.

### Shopify docs — App Home is a cross-origin iframe

`refs/shopify-docs/docs/api/app-home.md:42`:

> The App Home area in Shopify admin is implemented as an iframe. To interact with other Shopify admin components outside this iframe, apps in App Home use Shopify's App Bridge JavaScript SDK.

Top frame: `admin.shopify.com`. Iframe: our Cloudflare tunnel origin. Chromium runs cross-origin iframes as **out-of-process iframes (OOPIFs)**. CDP-dispatched input/events have to cross the process boundary; a native mouse click reaches the target frame via the OS-browser hit-test path directly.

### Shopify docs — `<s-button>` interop has sharp edges

Shopify's own React examples (`refs/shopify-bridge/packages/app-bridge-react/README.md:93, 102, 127` and `refs/shopify-docs/docs/api/app-home.md:106`) use plain `<button onClick={…}>` — not `<s-button>` — whenever a React handler needs to fire. `<s-button>` is demonstrated for styling and for App Bridge commands (`commandFor`, `command`), not for React-owned click dispatch.

No embedded-app e2e testing guidance exists in `refs/shopify-docs`.

### Polaris button click event contract

`refs/shopify-docs/docs/api/app-home/polaris-web-components/actions/button.md:204-212`:

> **click** — `CallbackEventListener<typeof tagName> | null` — A callback fired when the button is clicked.

The click event is standard DOM `click`. Our ad-hoc listener on the host receives it. React's `onClick={generate}` does not. This points to React 19's custom-element listener binding not being wired the way programmatic clicks inside an OOPIF expect — but we did not isolate the exact mechanism.

## Hypothesis

Most likely root cause: cross-origin OOPIF + React 19 custom-element listener binding + something about CDP-synthesized events differing from native clicks in ways Polaris's internal handler discriminates against (`isTrusted`, user-activation, App Bridge interposition). A DOM `click` reaches the host; whatever React 19 bound for `onClick` on the custom element is either not the same listener or is gated on something the synthesized event lacks.

Not proven — eliminating candidates further would require stepping through React 19's `ReactDOMEventListener` during a test run, or testing the same pattern outside the admin iframe (same-origin dev page hosting `<s-button>`). Out of scope for now.

## Recommendation

Do not test user interactions via in-iframe `<s-button>` clicks. Options:

1. **Unit/integration tests for server fns** (Vitest against the Worker): covers auth + admin GraphQL — the actual logic. This is where the value is.
2. **Admin-chrome slotted buttons** (`slot="primary-action"` etc.): Shopify admin renders these outside the iframe as native buttons that bridge back to the React handler. Playwright-clickable via `page.getByRole(...).click()`. Practical for smoke tests but limited — not every interaction has a slotted counterpart.
3. **Route-level nav**: in-iframe `<s-link href="…">` renders as native `<a>` and should be clickable by Playwright. This covers spec 2 (nav to additional page) without hitting the button problem.

Avoid: building `.evaluate()`-based click shims that call handlers directly — couples tests to component internals and gives false confidence.

## Current state

- `e2e/generate-product.spec.ts` — `test.skip`, documents the admin-chrome workaround in JSDoc.
- `e2e/iframe-button-click.investigate.spec.ts` — 8 failing strategies kept as evidence. Delete when a verdict is reached.
- `docs/e2e-coverage-gaps-research.md` — coverage gap ranking; spec 1 (generate product) is blocked on this issue unless the admin-chrome workaround is accepted.
