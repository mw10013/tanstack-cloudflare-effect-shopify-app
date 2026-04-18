# Polaris web components + Playwright — research

Problem: Playwright can't click Polaris `s-*` components inside the embedded app iframe. `e2e/iframe-button-click.investigate.spec.ts` tries 8 click strategies against `s-button`; none work. Admin-chrome sidebar links also fail (separate mechanism). This doc collects what's verified vs. inferred and lists verification steps.

## Evidence — what we know

### 1. Playwright does not support closed-mode shadow roots

`refs/playwright/docs/src/locators.md:700-704`:

> All locators in Playwright **by default** work with elements in Shadow DOM. The exceptions are:
> - Locating by XPath does not pierce shadow roots.
> - [Closed-mode shadow roots](https://developer.mozilla.org/en-US/docs/Web/API/Element/attachShadow#parameters) are not supported.

Playwright *can* click into a closed shadow root if given an `ElementHandle` via `evaluateHandle` (`refs/playwright/tests/library/hit-target.spec.ts:298-316`), but locator-based strategies can't reach interior elements.

### 2. Playwright "enabled" walks ancestors for `aria-disabled`

`refs/playwright/packages/injected/src/roleUtils.ts:1098-1136`:

```ts
export const kAriaDisabledRoles = ['application', 'button', 'composite', 'gridcell',
  'group', 'input', 'link', 'menuitem', …];

function hasExplicitAriaDisabled(element, isAncestor = false): boolean {
  if (isAncestor || kAriaDisabledRoles.includes(getAriaRole(element) || '')) {
    const attribute = (element.getAttribute('aria-disabled') || '').toLowerCase();
    if (attribute === 'true') return true;
    if (attribute === 'false') return false;
    return hasExplicitAriaDisabled(parentElementOrShadowHost(element), true);
  }
  return false;
}
```

If any ancestor with a role in `kAriaDisabledRoles` (or matched during recursion) carries `aria-disabled="true"`, Playwright reports the descendant as not-enabled. `click()` retries until timeout.

### 3. Observed failure signatures in this repo

- `e2e/iframe-button-click.investigate.spec.ts` — 8 strategies against `s-button` (default click, force click, shadow-DOM inner-button pierce, `MouseEvent` dispatch, hover+click, pointerdown/up sequence, keyboard Enter, keyboard Space). All reported to fail (see `docs/iframe-button-click-research.md`).
- `e2e/generate-product.spec.ts:32-44` — currently clicks the admin-chrome `primary-action` button via `page.getByRole`, with a comment explaining the in-iframe `s-button` click path is not understood.
- Admin-chrome sidebar link (Polaris-React `<a>`) failure log: "element is not enabled" retried for 120 s before timeout. The rendered HTML from the error trace shows no `disabled` / `aria-disabled` attribute directly on the `<a>` itself — which matches the ancestor-walk in (2).

### 4. No shadow-DOM internals in refs

- `refs/shopify-bridge` ships only `app-bridge-react` and `app-bridge-types`, not the `s-*` component implementations.
- `refs/shopify-docs/docs/api/app-home/` mentions `attachShadow` / `shadowRoot` zero times; it contains no e2e-testing guidance for `s-*` components.
- `Polaris-Navigation` / `data-polaris-unstyled` class names (seen in the sidebar `<a>`) appear in zero repo refs — that DOM is rendered by Shopify admin, not shipped with our app or any vendored package we have.

So the source of truth for `s-*` internals is not in this workspace.

## Conjecture — what we've been assuming

**Claim A: Polaris `s-*` components use closed-mode shadow roots.**
Strong indirect evidence:
- All locator-based click strategies fail consistently, matching (1).
- Shadow-DOM pierce (`locator('s-button').locator('button')`) fails — Playwright's open-shadow pierce would normally work.
- Vendor-shipped design-system web components commonly choose closed mode for encapsulation.

Not yet directly verified from Shopify source or runtime inspection.

**Claim B: Admin sidebar links are Polaris-React (not web components), and something in the admin chrome ancestor tree carries `aria-disabled="true"`.**
Supporting:
- The `<a>` in the error log has `class="Polaris-Navigation__Item"` / `data-polaris-unstyled="true"` — classic Polaris-React CSS-modules marker.
- Live under the admin's iframe host document, not ours.
- No direct `aria-disabled` on the `<a>` itself — consistent with ancestor walk per (2).

Not yet verified which ancestor carries the attribute.

**Claim C: In-iframe `<s-link>` inside `<s-app-nav>` is declarative only — App Bridge projects it to admin chrome; the iframe copy isn't wired to navigate.**
Supporting:
- `refs/shopify-docs/docs/apps/launch/built-for-shopify/requirements.md:199` says `s-app-nav` "integrates your app's primary navigation into the Shopify admin navigation menu".
- Screenshot after click showed admin sidebar updating — but we never tested clicking the iframe-side `s-link` directly.

Not tested.

## Verification steps

### V1. Directly inspect shadow-root mode

Add a throwaway Playwright test (or run in the existing investigate spec) that reports the shadow mode:

```ts
const info = await frame.locator('s-button').first().evaluate((el) => ({
  tag: el.tagName,
  hasShadowRoot: !!el.shadowRoot,
  childCount: el.children.length,
  outerSnippet: el.outerHTML.slice(0, 200),
}));
console.log(info);
```

- `hasShadowRoot === false` + no children → closed shadow (most likely).
- `hasShadowRoot === true` → open shadow (rules out Claim A; different root cause).
- `hasShadowRoot === false` + children present → no shadow at all (rules out Claim A; even weirder root cause).

Chrome DevTools can also inspect closed shadow roots visually (DevTools ignores the `mode`), so a manual pass confirms.

### V2. Check accessibility tree

```ts
const snap = await frame.locator('s-button').first().ariaSnapshot();
```

If the snapshot shows only the host with no interior `button` role, that's further evidence of inaccessible internals.

### V3. Find the `aria-disabled` ancestor in admin chrome

```ts
await page.getByRole('link', { name: 'Additional page' }).evaluate((el) => {
  const chain: Array<{ tag: string; role: string | null; ariaDisabled: string | null }> = [];
  let n: Element | null = el;
  while (n) {
    chain.push({
      tag: n.tagName,
      role: n.getAttribute('role'),
      ariaDisabled: n.getAttribute('aria-disabled'),
    });
    n = n.parentElement;
  }
  return chain;
});
```

Find the first ancestor with `aria-disabled="true"`. Confirms Claim B and tells us whether it's a stable admin-chrome state or a transient one we could wait out.

### V4. Click the iframe-side `s-link` directly

```ts
await frame.locator('s-app-nav s-link[href*="/app/additional"]').click({ force: true });
```

Compare URL / iframe-src afterward against a baseline. If no navigation: Claim C confirmed — iframe copy is inert. If it navigates: we have a better click path for nav tests than `page.goto(href)`.

### V5. Read Polaris web component source

Not in refs. Options:
- `npm view @shopify/app-bridge-ui-components` / Shopify's GitHub for the `s-*` element implementation.
- Grep `mode: 'closed'` or `attachShadow` in whatever package ships them.

Most authoritative; slowest.

## Known workarounds in this repo

- **In-iframe `s-button` with admin-chrome `primary-action` slot** (e.g. Generate a product at `src/routes/app.index.tsx:174`): click the admin-chrome button via `page.getByRole`. See `e2e/generate-product.spec.ts:36`.
- **Admin-chrome nav links** (`s-app-nav` items lifted into admin sidebar): read `HTMLAnchorElement.href` via `locator.evaluate`, then `page.goto`. See `e2e/nav-additional-page.spec.ts`.
- **In-iframe `s-button` with no chrome lift**: no reliable click path established. Options: call the underlying server fn directly, or add a test-only DOM affordance.

## Related files

- `e2e/iframe-button-click.investigate.spec.ts` — matrix of click strategies.
- `docs/iframe-button-click-research.md` — prior research on the `s-button` click problem.
- `docs/e2e-coverage-gaps-research.md` — coverage gaps analysis.
