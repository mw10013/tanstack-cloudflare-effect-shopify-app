# Shopify Playwright E2E for embedded app (research)

Goal: run a Playwright test that exercises the real embedded surface inside Shopify admin (iframe), while keeping local dev (Shopify CLI tunnel) workable.

## Verdict on the proposed approach

I agree with the direction (log in to admin, open embedded app, then drive the iframe), but I disagree with a few specifics:

- Hardcoding `.../apps/{client-id}` as the “stable app URL”: partially true; Shopify docs show app home URL is keyed by `handle` (`.../apps/{handle}/app`). In practice, `.../apps/{client_id}` shows up in some flows (notably redirect-after-auth / reviewer URLs), so tests should be tolerant.
- “No storage state / no global setup”: workable for one-off local runs; not a great default for a test suite. Playwright recommends `storageState` + a setup project.
- `iframe[name="app-iframe"]`: likely brittle. Shopify guarantees “an iframe”, not its `name` attribute. Prefer a selector strategy based on “find the iframe whose URL is the app URL” or “find the iframe inside the main admin content region”.

## Repo-specific facts that matter for E2E

This repo already encodes the “tunnel URL changes per run” reality:

From `.shopify-cli/shopify.web.toml`:
```toml
# Shopify CLI injects dynamic HOST/APP_URL for each `shopify app dev` run (new tunnel each run).
# ...
# We intentionally keep SHOPIFY_APP_URL dynamic from Shopify CLI; do not hardcode
# tunnel URLs in local config.
```

The app’s public identifier is stable across runs (unless you create a new app):

From `.shopify-cli/shopify.app.toml`:
```toml
client_id = "9a91c9ff6ba488dafb39a7c696429753"
embedded = true
```

Current Playwright config assumes “start local server and test local URL”:

From `playwright.config.ts`:
```ts
process.loadEnvFile(path.resolve(__dirname, ".env"));

webServer: {
  command: "pnpm dev",
  url: `http://localhost:${process.env.PORT}`,
},
use: { baseURL: `http://localhost:${process.env.PORT}/` },
```

That will likely conflict with `pnpm shopify:dev` because Shopify CLI also runs `pnpm dev` (via `.shopify-cli/shopify.web.toml`), so “true embedded admin E2E” probably wants a separate Playwright config without `webServer` (or a conditional `webServer`).

## What Shopify docs actually guarantee (URL + iframe)

1) App Home URL uses `handle` (not `client_id`) as the slug:

From `refs/shopify-docs/docs/apps/build/app-configuration.md`:
```md
| `handle` | ... | The URL slug of your App Home, for example `https://admin.shopify.com/store/your-store-name/apps/your-app-handle/app`. **Warning**: Updating the handle changes the Shopify admin URL ...
| `client_id` | Yes | `string` | The app's public identifier. |
| `embedded` | Yes | `boolean` | When `true`, your app renders in the Shopify admin ...
```

2) Embedded surface is an iframe (but DOM details are not promised):

From `refs/shopify-docs/docs/apps/build/admin.md`:
```md
The Shopify admin provides a surface for apps to render the UX for their App Home.
On the web, the surface is an iframe and in the Shopify mobile app, the surface is a WebView.
```

Implication for tests: assume “there is an iframe”, do not assume its `name`.

## What Playwright recommends for auth (vs “login every test”)

Playwright docs recommend saving authenticated browser state and reusing it:

From Playwright “Authentication” docs (https://playwright.dev/docs/auth):
```ts
await page.context().storageState({ path: authFile });
// ...
// Use prepared auth state.
storageState: 'playwright/.auth/user.json',
dependencies: ['setup'],
```

Implication: “login and go” is fine to bootstrap `storageState`, but is usually not the best default for all tests.

## Where the proposed approach is correct

- “Tunnel used by Shopify to reach local app”: yes, and it changes per `shopify app dev` run; you should not hardcode it.
- “Playwright doesn’t touch the tunnel directly”: mostly true as intent (you navigate to admin), but the controlled browser will load the tunnel URL inside the embedded iframe, so network + CSP + cookies still matter.
- “App is embedded; use `frameLocator()`”: correct, but iframe selection must be robust.

## Where it’s risky / likely wrong in practice

### 1) App URL shape (`/apps/{client_id}` vs `/apps/{handle}/app`)

Shopify’s own config docs point to `handle` for “App Home” URLs (see excerpt above).

However, `.../apps/{client_id}` does appear in real workflows (reviewer redirects / some install redirect URLs). Treat `client_id` as “something you might see”, not “the only stable canonical URL”.

Test recommendation:
- Prefer navigating via admin UI (click your app in **Apps**) rather than hardcoding a deep URL.
- If hardcoding, accept both patterns (configurable via env): `SHOPIFY_APP_HANDLE` and/or `SHOPIFY_CLIENT_ID`.

### 2) Shopify admin login is not a stable UI contract

Email/password selectors, 2FA prompts, “choose account”, passkey prompts, and bot checks can change. UI-driven admin login in CI is often flaky.

Test recommendation:
- Local dev: allow interactive bootstrap (headed) to generate `storageState`.
- CI: only attempt this if you have a dedicated staff account with 2FA disabled and you’re not getting blocked by bot checks. Otherwise, keep “embedded admin E2E” as a manual / nightly job.

### 3) Iframe selection

`iframe[name="app-iframe"]` is a guess. Shopify docs only promise “an iframe”.

Test recommendation:
- Prefer selecting the iframe by URL, not by `name`:
  - wait for a frame whose `frame.url()` contains `embedded=1` and your `shop` (common embedded params), then interact via `frameLocator`.
  - or locate an iframe within the main content region and assert its `src` changes to your app.

## Suggested structure for “true embedded” Playwright tests (for this repo)

Two layers (keep both):

1) **Local-only smoke tests** (already present)
- keep `e2e/smoke.spec.ts` style tests against `baseURL` for fast feedback.

2) **Embedded admin E2E** (separate config + opt-in)
- Pre-req: run `pnpm shopify:dev` in another terminal (it runs the app + tunnel and updates config/URLs for the chosen dev store).
- Playwright project `setup`:
  - navigate to `https://admin.shopify.com/` (or your store) in `--headed` mode
  - perform login once
  - save `storageState` to `playwright/.auth/shopify-admin.json`
- Embedded tests:
  - reuse `storageState`
  - open the app via admin UI (preferred) or a configurable URL pattern
  - find the embedded app iframe via URL heuristics, not hardcoded `name`

## Practical local workflow for this repo

- Terminal A: `pnpm shopify:dev`
- Terminal B: run embedded tests in headed mode (so you can see + debug)
- If using `playwright-cli` for manual exploration, follow repo convention:
  - `playwright-cli --headed --session="$(pnpm port)-localdev" open "http://localhost:$(pnpm port)"`

## Open questions / needs confirmation on a real run

- What exact iframe attributes Shopify admin uses today for embedded app home (id/name/title/data-testid) in your dev store.
- Whether `https://admin.shopify.com/store/{store-handle}/apps/{client_id}` works for your app home reliably, or only in some redirect contexts.
- Whether Shopify admin login flow is stable enough for CI in your environment (captcha / passkeys / 2FA).

