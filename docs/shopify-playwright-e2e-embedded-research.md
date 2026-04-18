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
- Shared storage-state path: `e2e/storage-state.ts` (single source of truth)
- Auth storage file: `playwright/.auth/shopify-admin.json` (gitignored)
- HTML report output: `playwright/report/` (gitignored)
- Per-test artifact output (`outputDir`): `playwright/test-results/` (gitignored)
- `.gitignore` collapses everything Playwright-owned to a single entry: `playwright/`

## Current test inventory

`pnpm exec playwright test --list` currently reports 2 tests in 2 files:
- `shopify-admin.setup.ts > shopify admin auth`
- `embedded-app-home.spec.ts > embedded app home loads`

`pnpm test:e2e` runs only `*.spec.ts` tests (positional `.spec.ts` filter).
`pnpm test:e2e:setup` runs only `*.setup.ts` tests headed.

The positional arg to `playwright test` is a substring/regex match against file paths; combined with `testMatch` in config it cleanly partitions setup vs spec runs without escaped regex.

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

3) Run embedded assertion test:
- `pnpm test:e2e`

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

### Previous state (before consolidation)

Top-level dirs created/used by Playwright historically:

| Dir | Source | Purpose |
| --- | --- | --- |
| `e2e/` | `testDir` in config | Test specs + setup |
| `playwright/.auth/` | manual `path.join(...)` in setup + spec | `storageState` JSON (gitignored) |
| `playwright-report/` | HTML reporter default | Generated HTML report |
| `test-results/` | `outputDir` default | Per-test artifacts (traces/screenshots/videos) |
| `.playwright-cli/` | external `playwright-cli` tool, **not** `@playwright/test` | Unrelated session storage; ignore |

Grievances:
- `playwright/` was a near-empty shell whose only purpose was to host `.auth/`.
- `playwright-report/` and `test-results/` were sibling top-level dirs with no visual relation.
- Auth path was hardcoded in two files instead of one source of truth.

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

### Decision: Option A (applied)

Trade-off: keep the Playwright-blessed convention (`playwright/.auth`) and cluster the two generated dirs (`test-results/`, `report/`) inside the same parent so the root stops looking like a junk drawer.

#### Applied changes

- `playwright.config.ts`:
  - `outputDir: "./playwright/test-results"`
  - `reporter: [["html", { outputFolder: "./playwright/report" }]]`
- New `e2e/storage-state.ts` — single export `storageStatePath` pointing at `playwright/.auth/shopify-admin.json`. Imported by both `shopify-admin.setup.ts` and `embedded-app-home.spec.ts` (no more hardcoded paths).
- `.gitignore` — three lines (`playwright-report/`, `test-results/`, `playwright/.auth/`) collapsed into one: `playwright/`.
- Removed orphaned top-level `playwright-report/` and `test-results/`.

#### Why `storageState` is not in global `use`

Putting `use.storageState` at the config root would apply to the setup test too, which would try to load a non-existent file on first run before producing it. Without a separate `setup` Playwright project (intentionally avoided to keep config minimal), the spec file declares `test.use({ storageState })` itself. Both files import the path constant from `e2e/storage-state.ts`.

#### Verification

- `pnpm exec playwright test --list` → 2 tests in 2 files (unchanged).
- `pnpm typecheck` → clean.

#### Notes

- Don't set `snapshotDir` — it's discouraged. Use `snapshotPathTemplate` if/when snapshots are added.

### Sources

- [Playwright `outputDir` and `snapshotDir`](https://playwright.dev/docs/api/class-testconfig#test-config-output-dir)
- [Playwright HTML reporter `outputFolder`](https://playwright.dev/docs/test-reporters#html-reporter)
- [Playwright auth: `playwright/.auth` convention](https://playwright.dev/docs/auth)
