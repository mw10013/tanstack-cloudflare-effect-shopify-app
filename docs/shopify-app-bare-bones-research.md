# Rename + Bare-Bones Simplification Research

## Requested outcome

- Rename project to `tanstack-cloudflare-effect-shopify-app`.
- Strip app to bare bones.
- Remove: auth + better-auth, durable objects + organization agent, workflows, r2, queues, rate limits, cron triggers.
- Keep: `d1` and `kv`.
- Remove actual tests but keep test scaffolding.
- Remove sidebar + `app/*` + `admin/*` pages.
- End with an index route that demonstrates: server functions, form, `useMutation`, Effect v4, d1 read/write.

## Current baseline (evidence)

### Project is still the old SaaS template

`package.json:2`

```json
"name": "tanstack-cloudflare-effect-saas"
```

`README.md:20-24`

```md
- Cloudflare: D1, DO, Agent, Workflow, Queue, KV, Cron, Rate Limiting, Web Analytics
- Better Auth: Magic Link, Admin, Organization, Stripe
```

### Worker is wired to the infra you want removed

`wrangler.jsonc:39-46,53-64,78-113`

```jsonc
"durable_objects": { ... },
"workflows": [ ... ],
"r2_buckets": [ ... ],
"queues": { ... },
"ratelimits": [ ... ],
"triggers": { "crons": ["0 0 * * *"] }
```

`src/worker.ts:23-25,199,220,249`

```ts
export { InvoiceExtractionWorkflow } from "./invoice-extraction-workflow";
export { OrganizationAgent } from "./organization-agent";
export { UserProvisioningWorkflow } from "./user-provisioning-workflow";
const { success } = await env.MAGIC_LINK_RATE_LIMITER.limit({ key: ip });
async scheduled(...) { ... }
queue,
```

### Auth is deeply integrated

`src/lib/Auth.ts:8-11,218-241,385-397`

```ts
import { betterAuth } from "better-auth";
import { admin, magicLink, organization } from "better-auth/plugins";
plugins: [magicLink(...), admin(), organization(...), stripePlugin(...), ...]
export const signOutServerFn = createServerFn({ method: "POST" })
```

Auth is imported in many routes and worker runtime (`src/worker.ts`, `src/routes/*`, `src/lib/Login.ts`, `src/lib/UserProvisioningStatus.ts`).

### Sidebar/app/admin structure is explicit

`src/routes/admin.tsx:25-36,56` and `src/routes/app.$organizationId.tsx:30-42,98`

```ts
import { Sidebar, SidebarContent, SidebarFooter, ... } from "@/components/ui/sidebar";
export const Route = createFileRoute("/admin")({ ... })
export const Route = createFileRoute("/app/$organizationId")({ ... })
```

### Tests are broad and coupled to removed systems

- e2e specs exist in `e2e/*.spec.ts`.
- integration specs exist in `test/integration/*.test.ts`.
- browser specs exist in `test/browser/*.test.tsx`.

`test/integration/vitest.config.ts:62` and `test/browser/vitest.config.ts:57`

```ts
include: ["test/integration/*.test.ts"]
include: ["test/browser/**/*.test.{ts,tsx}"]
```

`playwright.config.ts:17`

```ts
testDir: "./e2e"
```

## Docs constraints that matter for this refactor

### TanStack Start patterns to preserve

`refs/tan-start/docs/start/framework/react/guide/server-functions.md:26-50`

```md
Server functions are created with `createServerFn()`...
Call server functions from route loaders, components (useServerFn), event handlers.
```

`refs/tan-start/docs/start/framework/react/guide/server-entry-point.md:63-67`

```md
Register a request context type ... available throughout ... server functions and router.
```

`refs/tan-start/docs/start/framework/react/guide/routing.md:41-50,198`

```md
File-based routing in `src/routes` ... `/` maps to `index.tsx`.
```

### Wrangler env behavior to preserve while deleting bindings

`refs/cloudflare-docs/src/content/docs/workers/wrangler/configuration.mdx:88,250-278`

```md
Bindings ... are not inheritable and need to be defined explicitly.
Non-inheritable keys include durable_objects, kv_namespaces, r2_buckets, queues, workflows.
```

Implication: when removing bindings at top-level, remove matching `env.production` binding blocks too.

## Recommended target architecture

### Runtime

- `src/worker.ts` keeps only `fetch` handler + `ServerContext` injection (`env`, `runEffect`).
- Remove `scheduled` and `queue` handlers.
- Remove agent routing and all auth rate-limit logic.
- Keep Effect runtime composition for `D1`, `KV`, logger, and request context.

### Data

- Replace current auth/subscription/invoice schema with one minimal app table for demo behavior.
- Keep d1 migrations flow (`pnpm d1:*` scripts) but simplify schema.
- Keep `KV` binding and one concrete usage in index route (example: cache last mutation timestamp or write-through counter).

### Routes

- Keep `src/routes/__root.tsx`.
- Replace route tree with a minimal set centered on `src/routes/index.tsx`.
- Remove `_mkt*`, `app*`, `admin*`, `login*`, and auth/api routes that only serve removed systems.

### Index route pattern demo (single-page goal)

Index route should include all requested patterns in one place:

1. `createServerFn({ method: "GET" })` loader server fn reads from d1.
2. `createServerFn({ method: "POST" })` mutation server fn writes to d1.
3. `useForm` handles client form state + validation.
4. `useMutation` executes server fn and invalidates/reloads route data.
5. server fn body uses `runEffect(Effect.gen(...))` and `yield* D1`.
6. optional: mutation also writes to `KV` to demonstrate retained kv primitive.

## Proposed deletion map

### Remove these modules/features

- Auth/identity/billing: `src/lib/Auth.ts`, `src/lib/Login.ts`, `src/lib/Stripe.ts`, auth routes under `src/routes/login*` + `src/routes/api/auth/*`.
- Durable Object + agent stack: `src/organization-agent.ts`, `src/lib/OrganizationAgent*`, `src/lib/OrganizationDomain.ts`, `src/lib/OrganizationRepository.ts`.
- Workflow stack: `src/invoice-extraction-workflow.ts`, `src/user-provisioning-workflow.ts`, `src/lib/UserProvisioning*.ts`.
- R2/queue/rate-limit/cron paths: `src/lib/R2.ts`, `src/lib/Q.ts`, `worker.ts` queue/scheduled/rate-limit branches, invoice object route `src/routes/api/org.$organizationId.invoice.$invoiceId.tsx`.
- Sidebar/app/admin UI routes: `src/routes/admin*.tsx`, `src/routes/app*.tsx`, and sidebar-heavy layout routes.
- Generated references tied to removed routes/bindings will be regenerated, not hand-edited (`src/routeTree.gen.ts`, `worker-configuration.d.ts`).

### Keep and simplify

- `src/lib/D1.ts`, `src/lib/KV.ts`, `src/lib/LayerEx.ts`, `src/lib/CloudflareEnv.ts`, `src/lib/Request.ts`.
- Minimal repository module for the index route demo.
- Test config skeletons (`test/integration/vitest.config.ts`, `test/browser/vitest.config.ts`, `playwright.config.ts`).

## Rename impact map

### Required rename updates

- `package.json` package name and old clone script references.
- UI strings and title (`src/routes/__root.tsx`, `src/components/app-logo.tsx`, README headings/links).
- Wrangler worker names/resource naming that still use `tces*` (`wrangler.jsonc`, scripts in `package.json`).
- Docs that still hardcode old repo path/name.

### After binding cleanup

- Run `pnpm cf-typegen` (or `pnpm typecheck`) to regenerate `worker-configuration.d.ts` from new Wrangler bindings.

## Test scaffolding strategy (remove real tests, keep rails)

Recommended:

- Keep folder structure and configs:
  - `test/integration/vitest.config.ts`
  - `test/browser/vitest.config.ts`
  - `test/TestUtils.ts` (simplified)
  - `playwright.config.ts`
- Replace current specs with minimal placeholders:
  - `test/integration/smoke.test.ts`
  - `test/browser/smoke.test.tsx`
  - `e2e/smoke.spec.ts`

Reason: current configs target explicit include globs; deleting all test files without placeholders can break CI/test commands with "no tests found" behavior.

## High-confidence implementation order

1. Rename identity strings + worker names.
2. Strip Wrangler bindings to d1+kv only (top-level + production env).
3. Replace `worker.ts` with minimal fetch runtime.
4. Remove auth/agent/workflow/r2/queue code and dependent routes.
5. Add minimal repository + index route with server fn/form/mutation/effect/d1 (plus small kv usage).
6. Replace migrations with bare-bones schema and run reset flow.
7. Replace tests with scaffold placeholders.
8. Run `pnpm typecheck` and `pnpm lint`.

## Likely "left out" items to include in actual implementation

- Dependency pruning in `package.json` (`better-auth`, `@better-auth/stripe`, `agents`, `@effect/sql-sqlite-do`, `stripe`, `aws4fetch`, and related transitive usage).
- Remove orphaned UI components not used by minimal index route.
- Update README quick-start from SaaS template flow to bare-bones d1/kv workflow.
- Ensure route regeneration (`src/routeTree.gen.ts`) occurs after route deletions.

## Suggested defaults for ambiguous points

- Use `src/routes/index.tsx` as the canonical demo page.
- Keep `ThemeProvider` only if still used by UI controls on index; otherwise remove `better-themes`.
- Reset d1 schema to a fresh minimal migration and treat this as a template reset (not in-place production migration).
