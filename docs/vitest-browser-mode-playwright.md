# Vitest Browser Mode with Playwright

## Bottom Line

Vitest Browser Mode with `playwright()`:

- Vitest is the test runner
- Playwright is the browser provider Vitest uses to drive a real browser
- tests use Vitest APIs (`test`, `expect`, `vi`) plus `vitest/browser` locators
- tests render components into an iframe served by Vitest's own Vite-powered browser server (default port `63315`)

Standalone Playwright:

- Playwright Test is runner and browser automation
- tests use `@playwright/test` fixtures (`{ page }`)
- mental model is end-to-end runner first

Browser Mode is a component/integration runner with real browser semantics. It is not a miniature Playwright.

## What Browser Mode Is For

One rule, applied consistently: **Browser Mode renders a React component into a real browser and asserts on its behavior.** That is the whole shape of the idiomatic test.

- the component is the subject
- its props, context providers, and mocks are the inputs
- real DOM, real events, real browser APIs are the runtime
- no real app server, no real auth, no cross-origin navigation

If a test does not render a component, it is not a Browser Mode test. If a test needs to cross the app HTTP boundary, it is not a Browser Mode test. Those belong in integration or Playwright respectively.

## Picking The Right Layer

The decision is about **what is under test**, not **what tools are available**.

| If the test is primarily about...                           | Use                    |
| ----------------------------------------------------------- | ---------------------- |
| Server fn, worker, RPC, repository, workflow, or auth logic | **Vitest integration** |
| A UI component or route fragment on a single page           | **Vitest Browser Mode** |
| A user journey that crosses pages, auth, or sessions        | **Playwright E2E**     |

Heuristics:

- **If the test only calls server fns and asserts on responses, it is an integration test.** A browser buys nothing if nothing renders. Put it in `test/integration/`.
- **If the test navigates between routes, it is a Playwright test.** Vitest Browser Mode reuses a single page per file (see the provider constraint below); multi-page flows are not its model.
- **If the test renders a component and exercises real browser APIs** (`matchMedia`, clipboard, `File`, focus, keyboard, popover/dialog focus traps), Browser Mode is correct — it gives real DOM plus direct module imports and Vitest mocks.
- **If the test needs real auth cookies, multi-tab, downloads, or cold sessions**, use Playwright.

Vitest's own docs on the single-page constraint:

> "Unlike Playwright test runner, Vitest opens a single page to run all tests that are defined in the same file. This means that isolation is restricted to a single test file, not to every individual test."[^playwright-provider]

> "Vitest creates a new context for every test file"[^playwright-provider]

So Browser Mode's sweet spot is deliberately narrow: **one page, one component or route fragment, real browser semantics, Vitest ergonomics**.

## Execution Model

- **Playwright E2E**: test code runs in Node, drives a real browser against a real app server (`playwright.config.ts` `webServer` spawns `pnpm dev`).
- **Vitest Browser Mode**: test code runs in a browser iframe served by Vitest's Vite-powered browser server on port `63315`.[^browser-api] It imports application source modules directly and renders components into the iframe.
- **Vitest integration**: test code runs in Node, calls the worker's `fetch` in-process, no browser.

The important question is: **where does the test body execute?** In Browser Mode the answer is "in a real browser", and the test's job is to render UI there.

## Why Auth Is Handled With Mocks

The app serves from one port (e.g. `:3100`), Vitest serves the test iframe from another (`:63315`). Session cookies are origin-bound and `better-auth.session_token` is HttpOnly — not settable from JavaScript. Top-level navigation to the app would unload the test iframe and terminate the test body.

The idiomatic Browser Mode response is not a workaround: it is to **not need real auth at all**. The component is rendered with mocked context and providers. That is the same pattern component tests use in every React testing framework; real-auth UI coverage is Playwright's job.

## Authenticating Browser Mode Tests

Every interesting page in this repo is under `/app/$organizationId/...`. The strategy is to mock auth and route context and render the component directly.

### What has to be satisfied

Route context layers:

| Route                       | Context added                                          | Source                                     |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| `__root`                    | `{ queryClient: QueryClient }`                         | `createRootRouteWithContext`               |
| `/app`                      | `{ sessionUser }`                                      | `beforeLoad` → server fn reads session     |
| `/app/$organizationId`      | `{ organization, organizations, sessionUser }`         | `beforeLoad` → server fn + `listOrganizations` |

Types to satisfy (from `src/lib/Auth.ts`):

- `sessionUser`: `AuthInstance["$Infer"]["Session"]["user"]`
- `organization` / `organizations[number]`: `AuthInstance["$Infer"]["Organization"]`

Runtime providers the authenticated subtree installs (`src/routes/app.$organizationId.tsx:123-144`):

- `OrganizationAgentProvider` — supplies `{ call, stub, ready, identified }` from `useAgent()` (websocket to a Cloudflare Durable Object via `agents/react`). Tests provide a fake value; the real one will never connect from the iframe.
- `SidebarProvider` — state-only, safe to use as-is.
- `QueryClientProvider` — tests use a fresh `QueryClient` with retry disabled.

### Tooling

Dev deps include `vitest` 4.1.4, `@vitest/browser-playwright` 4.1.4, and `vitest-browser-react` 2.2.0 — the latter provides `render()` and integrates with `vitest/browser`'s `page` locators. (`vitest-browser-react` versions separately from `vitest`.)

### Fixtures

Drop these into `test/browser/fixtures.ts`:

```ts
import type { AuthInstance } from "@/lib/Auth";

export const fakeOrg: AuthInstance["$Infer"]["Organization"] = {
  id: "org_test",
  name: "Test Org",
  slug: "test-org",
  logo: null,
  metadata: null,
  createdAt: new Date("2026-01-01"),
};

export const fakeUser: AuthInstance["$Infer"]["Session"]["user"] = {
  id: "user_test",
  email: "u@u.com",
  name: "Test User",
  emailVerified: true,
  image: null,
  role: "user",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

export const fakeAppContext = {
  organization: fakeOrg,
  organizations: [fakeOrg],
  sessionUser: fakeUser,
};

export const fakeAgent = {
  call: async () => undefined,
  stub: {} as never,
  ready: true,
  identified: true,
};
```

### Three patterns, ranked

**Pattern 1 — Prop-driven subcomponent (preferred).** Many components already take their auth/org data as props. `AppSidebar` (`src/routes/app.$organizationId.tsx:147-263`) takes `{ organization, organizations, user }` and has no Route hooks. Render it wrapped in `SidebarProvider` + a mocked `OrganizationAgentProvider` + a router stub (needed only to back `Link` and `useMatchRoute`). This is the default pattern.

**Pattern 2 — Test router with stubbed `beforeLoad`.** For components that call `Route.useRouteContext()`, `Route.useLoaderData()`, or `Route.useParams()`, those hooks are bound to the module-level `Route` export and require a router. Build one using the real `routeTree` and `createMemoryHistory({ initialEntries: ["/app/org_test/invoices"] })`, and use `vi.mock()` to replace server fn modules so `beforeLoad` returns fake context without network I/O. Heavier; reserve for tests where the real wiring is the point.

**Pattern 3 — Refactor to accept context as props.** When a page is thin and only uses Route hooks to pull context/params, extract a prop-driven inner component and pass props from the route shell. Converts a Pattern 2 test into a Pattern 1 test. Do this opportunistically.

### Worked example — Pattern 1

```tsx
// test/browser/app-sidebar.test.tsx
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter, createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";
import { OrganizationAgentProvider } from "@/lib/OrganizationAgentContext";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/routes/app.$organizationId"; // export it from the module
import { fakeAgent, fakeOrg, fakeUser } from "./fixtures";

const renderSidebar = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: ["/app/org_test/invoices"],
    }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router}>
        <OrganizationAgentProvider value={fakeAgent}>
          <SidebarProvider>
            <AppSidebar
              organization={fakeOrg}
              organizations={[fakeOrg]}
              user={fakeUser}
            />
          </SidebarProvider>
        </OrganizationAgentProvider>
      </RouterProvider>
    </QueryClientProvider>,
  );
};

describe("AppSidebar", () => {
  it("marks the invoices item active on /invoices", async () => {
    renderSidebar();
    const invoices = page.getByRole("link", { name: "Invoices" });
    await expect.element(invoices).toHaveAttribute("data-status", "active");
  });
});
```

Notes:

- `AppSidebar` is currently module-local in `src/routes/app.$organizationId.tsx`. A one-line `export` is required.
- `RouterProvider` is present only to back `Link` and `useMatchRoute` inside the sidebar — the authenticated route subtree is not mounted, so `beforeLoad` never runs.
- `OrganizationAgentProvider` is fed a fake; no Durable Object connection is attempted.

### Worked example — Pattern 2

For a whole route that must exercise the real `beforeLoad`/loader wiring, mock the server fn modules:

```ts
vi.mock("@/routes/app", async (orig) => {
  const actual = await orig<typeof import("@/routes/app")>();
  return {
    ...actual,
    Route: {
      ...actual.Route,
      options: { ...actual.Route.options, beforeLoad: () => ({ sessionUser: fakeUser }) },
    },
  };
});
vi.mock("@/routes/app.$organizationId", async (orig) => {
  const actual = await orig<typeof import("@/routes/app.$organizationId")>();
  return {
    ...actual,
    Route: {
      ...actual.Route,
      options: {
        ...actual.Route.options,
        beforeLoad: () => ({
          organization: fakeOrg,
          organizations: [fakeOrg],
          sessionUser: fakeUser,
        }),
      },
    },
  };
});
```

Then build the router against the real `routeTree` and mock any additional server fns the leaf route's loader calls.

## Sidecar Processes

Neither Vitest Browser Mode nor Playwright's `webServer` manage sidecar processes (e.g. `stripe listen`) as a first-class concern. A sidecar is any auxiliary process the test depends on beyond the app itself — webhook forwarders, queue workers, external emulators. They must be started separately (manual terminal, `globalSetup` spawn, or a process manager wrapping the runner) and are out of scope for this document. Idiomatic Browser Mode tests don't need sidecars because they don't hit the app server.

## Candidate Tests In This Repo

Client-heavy behavior that depends on real browser APIs, real focus and keyboard handling, or Base UI popover/dialog behavior — but doesn't justify a full end-to-end flow — is the sweet spot.[^component-testing]

### 1. Sidebar keyboard and responsive behavior

Targets: `src/components/ui/sidebar.tsx:26-108`, `src/hooks/use-mobile.ts:3-20`. Pattern 1.

Why Browser Mode: depends on `window.matchMedia`, `window.innerWidth`, `document.cookie`, real keyboard events. Desktop and mobile paths diverge. Reusable UI infrastructure, not a journey.

High-value assertions: `Ctrl+B`/`Cmd+B` toggles and writes `sidebar_state` cookie; desktop toggle flips `data-state`; mobile toggle opens the sheet path.

### 2. Invoice list browser-only micro-interactions

Targets: `src/routes/app.$organizationId.invoices.index.tsx:122-207` and `:629-664`. Pattern 3 refactor (extract list UI) → Pattern 1; or Pattern 2 with mocked RPC.

Why Browser Mode: `File`, `arrayBuffer`, `navigator.clipboard.writeText`, `setTimeout`, non-trivial post-upload client logic (clear input, store pending id, invalidate, auto-select on refresh).

High-value assertions: `File` selection produces correct `fileName`/`contentType`/base64 payload; successful upload clears the file input; post-invalidate the new invoice auto-selects; `Copy JSON` writes clipboard, flips label to `Copied`, resets after 2 seconds.

### 3. Invitations form validation and role select behavior

Target: `src/routes/app.$organizationId.invitations.tsx:201-320`. Pattern 3 refactor → Pattern 1, or Pattern 2.

Why Browser Mode: TanStack Form client validation on transformed comma-separated email input, plus Base UI select/popover keyboard interaction.

High-value assertions: invalid comma-separated emails show field errors; >10 emails is rejected client-side; keyboard can open the role select and pick `Admin`; submit resets form and invalidates the route.

### 4. Admin search and dialog interaction

Targets: `src/components/ui/input-group.tsx:46-64`, `src/routes/admin.users.tsx:156-199` and `:390-430`, `src/routes/admin.sessions.tsx:72-111`. Pattern 1 for the input group; Pattern 2 for admin routes.

Why Browser Mode: click-to-focus on addon; form submit resets `page` in router search params; dropdown → dialog focus flow.

High-value assertions: clicking the search icon focuses the input; submit preserves filter and resets `page=1`; reopening Ban dialog resets the field.

### 5. Live invoice invalidation from agent messages

Target: message-handling logic in `src/lib/Activity.ts:3-30`. **Not a Browser Mode test.** Pure data logic — `decodeActivityMessage` + `shouldInvalidateForInvoice` are unit-testable in integration without a browser. The `useAgent` wiring in the route component is glue that Playwright would cover implicitly if it mattered.

## Practical Recommendation

- Default to Pattern 1 (prop-driven subcomponents, fake router backing `Link`s only). Export prop-driven subcomponents from their route module as needed.
- Reach for Pattern 2 when a route-wide test requires real `beforeLoad`/loader wiring. Use `Route.update({ ... })` to override the real `beforeLoad`/`loader` without hitting the network.
- Mock `agents/react`'s `useAgent` when rendering any route under `/app/$organizationId` — its websocket won't connect from the iframe.
- If a candidate needs neither a rendered component nor real browser APIs, it is integration.
- If it needs real auth or multi-page flow, it is Playwright.

Working examples live at `test/browser/app-sidebar.test.tsx` (Pattern 1) and `test/browser/organization-index.test.tsx` (Pattern 2).

[^browser-api]: [`refs/vitest/docs/config/browser/api.md`](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/vitest/docs/config/browser/api.md#L1-L21)
[^playwright-provider]: [`refs/vitest/docs/config/browser/playwright.md`](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/vitest/docs/config/browser/playwright.md#L1-L58) and [`refs/vitest/docs/config/browser/playwright.md`](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/vitest/docs/config/browser/playwright.md#L156-L163)
[^component-testing]: [`refs/vitest/docs/guide/browser/component-testing.md`](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-saas/refs/vitest/docs/guide/browser/component-testing.md#L1-L56)
