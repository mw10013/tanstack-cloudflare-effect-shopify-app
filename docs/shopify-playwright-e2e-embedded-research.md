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

## Folder layout: config, output, reports, auth state

### What Playwright generates and where (defaults)

Grounded in `refs/playwright/docs/src/`:

- **`outputDir`** — per-test artifacts (traces, screenshots, videos, attachments). Default: `<package.json-dir>/test-results`. *"This directory is cleaned at the start. When running a test, a unique subdirectory inside the `outputDir` is created"* — `test-api/class-testconfig.md:318–336`.
- **HTML reporter `outputFolder`** — the report site. Default: `playwright-report/` in cwd. Overridable via `outputFolder` option or `PLAYWRIGHT_HTML_OUTPUT_DIR` — `test-reporters-js.md:210–250`.
- **`storageState` for auth** — Playwright docs explicitly recommend `playwright/.auth/` and gitignoring it: *"We recommend to create `playwright/.auth` directory and add it to your `.gitignore`"* — `auth.md:13–34`.
- **`snapshotDir`** — base for `toMatchSnapshot` files. Default: `testDir`. The property itself is **discouraged** in favor of `snapshotPathTemplate` — `test-api/class-testconfig.md:351–374`.

### Current state in this repo (the mess)

Top-level dirs created/used by Playwright today:

| Dir | Source | Purpose |
| --- | --- | --- |
| `e2e/` | `testDir` in config | Test specs + setup |
| `playwright/.auth/` | manual `path.join(...)` in `e2e/shopify-admin.setup.ts:19–24` and `e2e/embedded-app-home.spec.ts:4–9` | `storageState` JSON (gitignored) |
| `playwright-report/` | HTML reporter default (`reporter: "html"` in `playwright.config.ts:17`) | Generated HTML report |
| `test-results/` | `outputDir` default | Per-test artifacts (traces/screenshots/videos) |
| `.playwright-cli/` | external `playwright-cli` tool, **not** `@playwright/test` | Unrelated session storage; ignore |

Grievances confirmed:
- `playwright/` is a near-empty shell whose only purpose is to host `.auth/`.
- `playwright-report/` and `test-results/` are sibling top-level dirs with no visual relation.
- Auth path is hardcoded in two spec files instead of the config.

### Options

#### Option A — Consolidate under `playwright/` (recommended)

Make `playwright/` the single home for everything Playwright owns *except* test specs:

```
e2e/                          # test specs only (testDir)
playwright/
  .auth/shopify-admin.json    # storageState (gitignored)
  test-results/               # outputDir (gitignored)
  report/                     # html outputFolder (gitignored)
playwright.config.ts          # stays at root (Playwright auto-discovers)
```

Config:

```ts
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./playwright/test-results",
  reporter: [["html", { outputFolder: "./playwright/report" }]],
  use: { storageState: "./playwright/.auth/shopify-admin.json" },
});
```

Pros:
- Matches the Playwright-docs convention for `.auth` verbatim — zero friction for anyone reading the official auth guide.
- One folder to gitignore (`playwright/`), one folder to delete to nuke state.
- Specs stop hardcoding paths: `storageState` lives in config; setup/spec files read `testInfo.project.use.storageState` or just rely on the project default.

Cons:
- `playwright/` and `playwright.config.ts` both exist at root — minor visual duplication.

#### Option B — Move everything under `e2e/`

```
e2e/
  .auth/shopify-admin.json
  .output/                    # outputDir
  .report/                    # html outputFolder
  *.spec.ts, *.setup.ts
```

Pros: only one Playwright-related top-level dir.

Cons:
- `testDir: "./e2e"` walks this folder. `testMatch` already filters to `*.spec.ts`/`*.setup.ts` so generated dirs *won't* be picked up as tests, but it still mixes source and generated artifacts in one tree — annoying in editors and `git status`.
- Diverges from the Playwright docs' `playwright/.auth` convention.

#### Option C — Hidden `.playwright/` (like `.tanstack`, `.wrangler`)

```
.playwright/
  auth/shopify-admin.json
  test-results/
  report/
```

Pros: matches the dotfile pattern of other tool-owned dirs in this repo (`.tanstack`, `.wrangler`, `.shopify`).

Cons:
- `.auth` nesting (`.playwright/.auth`) becomes weird vs flat `.playwright/auth`.
- Drifts from official docs more than A. Anything you grep for in Playwright docs (`playwright/.auth/...`) won't match your tree.

### Recommendation

**Option A.** Trade-off: keep the single Playwright-blessed convention (`playwright/.auth`) and cluster the two generated dirs (`test-results/`, `report/`) inside the same parent so the root stops looking like a junk drawer. Pull the auth path out of the spec files and into `use.storageState` in `playwright.config.ts` so there's one source of truth.

### Companion changes

- `.gitignore`: replace the three lines `playwright-report/`, `test-results/`, `playwright/.auth/` with a single `playwright/` (or keep `.auth/` separate if you ever want to commit the report locally — unlikely).
- Drop `process.cwd() + "playwright/.auth/..."` from `e2e/shopify-admin.setup.ts` and `e2e/embedded-app-home.spec.ts`; read from project config instead.
- Don't set `snapshotDir` — it's discouraged. Use `snapshotPathTemplate` if/when snapshots are added.

### Sources

- [Playwright `outputDir` and `snapshotDir`](https://playwright.dev/docs/api/class-testconfig#test-config-output-dir)
- [Playwright HTML reporter `outputFolder`](https://playwright.dev/docs/test-reporters#html-reporter)
- [Playwright auth: `playwright/.auth` convention](https://playwright.dev/docs/auth)
