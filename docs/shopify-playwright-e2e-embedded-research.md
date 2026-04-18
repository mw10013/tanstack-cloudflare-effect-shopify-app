# Shopify embedded admin Playwright E2E

This doc captures a redesign of auth/bootstrap for embedded Shopify admin E2E so we can run `pnpm test:e2e` directly, without a manual pause/setup test flow.

## Previous repo behavior (problem statement)

From code before Option A:

- `e2e/shopify-admin.setup.ts` is a manual bootstrap test (`await page.pause()`) that writes auth state.
- It has reauth toggle logic: `const shouldReauth = process.env.SHOPIFY_E2E_REAUTH === "1"`.
- It has a hardcoded fallback preview URL.
- `e2e/embedded-app-home.spec.ts` also has the same hardcoded fallback preview URL.
- Scripts split setup vs spec:
  - `pnpm test:e2e:setup` -> `.setup.ts`
  - `pnpm test:e2e` -> `.spec.ts`

This was clunky for day-to-day runs and diverged from requested behavior.

## Applied Option A snapshot

- `playwright.config.ts` now defines a `setup` project and an `e2e` project with `dependencies: ["setup"]`.
- `e2e` project sets `use.storageState` to `playwright/.auth/shopify-admin.json`.
- `e2e/shopify-admin.setup.ts` now auto-logins with env credentials and no manual pause.
- `e2e/embedded-app-home.spec.ts` uses required `SHOPIFY_PREVIEW_URL` (no fallback URL).
- `test:e2e:setup` script is removed; `pnpm test:e2e` runs `--project=e2e` and Playwright resolves setup dependency.

## Requested target behavior

- No special one-off setup command needed just to save auth.
- Login should use env credentials (`email/username`, `password`).
- Tests navigate to `process.env.SHOPIFY_PREVIEW_URL` only (no fallback URL in code).
- Remove `SHOPIFY_E2E_REAUTH` behavior.
- If auth expires, user deletes storage file manually.
- Playwright should support its own env file and committed example env file.

## Grounding from Playwright refs

- Auth state path convention:
  - `refs/playwright/docs/src/auth.md` recommends `playwright/.auth` + gitignore.
  - Quote: "We recommend to create `playwright/.auth` directory and add it to your `.gitignore`".
- State expiry handling:
  - `refs/playwright/docs/src/auth.md` says to delete stored state when it expires.
  - Quote: "Note that you need to delete the stored state when it expires."
- `.env` loading in Playwright config:
  - `refs/playwright/docs/src/test-parameterize-js.md` shows loading `.env` directly in `playwright.config.ts`.
  - Quote: "consider something like `.env` files ... read environment variables directly in the configuration file".
- No-setup-test alternative exists:
  - `refs/playwright/docs/src/test-global-setup-teardown-js.md` documents `globalSetup`.
  - Caveat from same doc: project dependencies are recommended overall; `globalSetup` has fewer runner integrations (HTML report visibility, fixtures, trace support).

## Design options for this repo

### Option A: Keep setup test, but automate and wire via project dependencies

What changes:

- Keep `*.setup.ts` file, remove `pause()`, do credential login automatically.
- Add Playwright projects + `dependencies: ["setup"]` so normal spec runs trigger setup implicitly.
- Put `use.storageState` in dependent project config.

Pros:

- Most aligned with Playwright's recommended auth model.
- Full runner support (reporting/traces/fixtures on setup path).

Cons:

- Still has a dedicated setup test artifact in the tree.
- More config moving parts for this small suite.

### Why Option A is Playwright-recommended (evidence)

From Playwright auth guide (`refs/playwright/docs/src/auth.md`):

- Line 40: "This is the **recommended** approach for tests **without server-side state**. Authenticate once in the **setup project**..."
- Line 79: "Create a new `setup` project ... declare it as a dependency ... This project will always run and authenticate before all the tests."

From Playwright global setup guide (`refs/playwright/docs/src/test-global-setup-teardown-js.md`):

- Line 8: project dependencies are "the recommended approach" because they integrate better with runner features.
- Line 10 table header: "Project Dependencies (recommended)" vs `globalSetup`.
- Lines 13-19 table: dependencies keep HTML report visibility, trace support, fixtures, and automatic config option application; `globalSetup` lacks these.
- Line 149: "Consider using project dependencies ... to get full feature support."

From Playwright projects guide (`refs/playwright/docs/src/test-projects-js.md`):

- Line 158: dependencies enable setup actions while preserving reporter + trace + fixture support.
- Lines 192-193: dependency project runs first, then dependents run.
- Lines 221-223: filtering still includes dependencies unless `--no-deps` is passed.

Takeaway: Option A is recommended because it keeps auth bootstrap inside normal test-runner semantics (tests, fixtures, traces, report nodes), instead of outside runner lifecycle.

## Conceptual model: projects vs dependencies

### Project

Per `refs/playwright/docs/src/test-projects-js.md:8`, a project is a logical group of tests with shared config.

Think: one config profile. Example differences per project:

- browser/device
- retries/timeouts
- env target
- auth mode (`storageState`)

### Dependency

Per `refs/playwright/docs/src/test-projects-js.md:156-159`, dependencies are prerequisite projects that must pass before another project runs.

Think: project DAG (directed acyclic graph):

`setup` -> `e2e`

Execution semantics (from `test-projects-js.md:190-197`):

1. run all tests in `setup`
2. if `setup` passes, run dependent projects
3. if `setup` fails, dependents are skipped

Filtering semantics (from `test-projects-js.md:219-223`):

- selecting a dependent project still runs its dependencies
- `--no-deps` disables this behavior

## Mapping this model to this repo

Current repo is not using projects/dependencies:

- `playwright.config.ts:12` has file-level `testMatch` for `*.setup.ts` and `*.spec.ts`.
- `package.json:11` runs only `.spec.ts` and `package.json:12` runs only `.setup.ts`.

That split is why setup feels "special" today.

Option A removes the "special command" while staying in Playwright's recommended model:

- define a `setup` project (`testMatch: "**/*.setup.ts"`)
- define test project(s) for specs (`testMatch: "**/*.spec.ts"`, `use.storageState: ...`)
- add `dependencies: ["setup"]` to spec project(s)
- run one command: `pnpm exec playwright test --headed`

Conceptually, `shopify-admin.setup.ts` stays, but becomes an internal prerequisite stage of the run graph rather than a manual pre-step command.

### Option B: Replace setup test with `globalSetup` lazy-auth bootstrap

What changes:

- Delete `e2e/shopify-admin.setup.ts`.
- Add `e2e/global-setup.ts` and set `globalSetup` in `playwright.config.ts`.
- In global setup: if storage state exists, return; else login using env credentials and save storage state.
- Set `use.storageState` in config for regular tests.

Pros:

- Meets "no special setup test run" cleanly.
- Simple execution model: run specs, auth bootstraps if missing.

Cons:

- Not Playwright's recommended primary model.
- Global setup lacks some first-class runner features (per Playwright docs comparison table).

### Option C: Per-spec `beforeAll` (or shared fixture) lazy-auth

What changes:

- Keep no setup project and no global setup.
- Add auth bootstrap in a shared helper/fixture before tests.

Pros:

- No setup test file.

Cons:

- Easy to duplicate logic.
- Harder to keep robust/centralized than Option B.

## Recommended direction for this repo

Given Playwright guidance + your latest direction, Option A is the best fit.

Implementation shape:

1. Env model (Playwright-specific)
   - Add `.env.playwright` (ignored).
   - Add `.env.playwright.example` (committed).
   - Load in `playwright.config.ts` before `defineConfig`.
2. Required envs
   - `SHOPIFY_PREVIEW_URL`
   - `SHOPIFY_E2E_LOGIN_EMAIL`
   - `SHOPIFY_E2E_LOGIN_PASSWORD`
3. Auth bootstrap via setup project + dependencies
   - `setup` project creates `playwright/.auth` if needed.
   - If `playwright/.auth/shopify-admin.json` exists, reuse and exit.
   - Else automate login in setup test, then save storage state.
4. Wiring
   - `e2e` project depends on `setup` via `dependencies: ["setup"]`.
   - `e2e` project sets `use.storageState` to the saved auth file.
   - `pnpm test:e2e` runs the `e2e` project; Playwright auto-runs `setup` first.
5. Remove old behavior
   - Delete fallback preview URL constants.
   - Remove `SHOPIFY_E2E_REAUTH` code path.
   - Remove `test:e2e:setup` script from package scripts.

## Notes on env-file placement

Two viable paths:

- Dedicated Playwright env files:
  - `.env.playwright` + `.env.playwright.example`.
  - Keeps e2e credentials isolated from app runtime env.
- Reuse existing root env files:
  - Add e2e keys to `.env` and `.env.example`.

Given request "Playwright with its own `.env`", prefer dedicated `.env.playwright*` files.

## Open questions / risk notes

- Shopify may trigger occasional additional auth challenges (2FA/captcha/device verification). If triggered, setup test will fail until account flow is cleared.

## Sources

- `refs/playwright/docs/src/auth.md`
- `refs/playwright/docs/src/test-parameterize-js.md`
- `refs/playwright/docs/src/test-global-setup-teardown-js.md`
- `playwright.config.ts`
- `e2e/shopify-admin.setup.ts`
- `e2e/embedded-app-home.spec.ts`
