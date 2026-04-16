# Vitest Integration Research

## Summary

Vitest is integrated here as a Cloudflare Worker test harness around the real app Worker.

- current Cloudflare versions here are `wrangler@4.80.0` and `@cloudflare/vitest-pool-workers@0.14.1`
- `pnpm test` runs `vitest run`
- `pnpm test:integration` runs `pnpm vitest --config test/integration/vitest.config.ts run`
- root `vitest.config.ts` re-exports `test/integration/vitest.config`
- the Worker under test comes from `wrangler.jsonc`, which points at `src/worker.ts`
- integration tests call the Worker through `cloudflare:workers`
- integration tests also call TanStack server functions through `createClientRpc()`
- `test/integration/vitest.config.ts` seeds `TSS_SERVER_FN_BASE` for the test runtime
- D1 migrations are loaded into Miniflare and applied in `test/apply-migrations.ts`

## Entry Points

`package.json` wires the scripts like this:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:integration": "pnpm vitest --config test/integration/vitest.config.ts run",
    "typecheck:test": "tsc -p test/tsconfig.json"
  }
}
```

The repo-level Vitest config forwards everything to the integration config:

`vitest.config.ts`

```ts
export { default } from "./test/integration/vitest.config";
```

That makes `pnpm test` and `pnpm test:integration` use the same Vitest setup.

## Integration Config

The main integration wiring lives in `test/integration/vitest.config.ts`:

```ts
import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

process.env.TSS_SERVER_FN_BASE ??= "/_serverFn/";

export default defineConfig(async () => {
  const rootDir = path.resolve(import.meta.dirname, "../..");
  const migrations = await readD1Migrations(path.join(rootDir, "migrations"));

  return {
    root: rootDir,
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: path.join(rootDir, "wrangler.jsonc") },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
      tsconfigPaths({
        projects: [path.join(rootDir, "tsconfig.json")],
      }),
      tanstackStart(),
      viteReact({
        babel: {
          plugins: [
            ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.join(rootDir, "src"),
      },
    },
    define: {
      "process.env.TSS_SERVER_FN_BASE": JSON.stringify(
        process.env.TSS_SERVER_FN_BASE,
      ),
      "import.meta.env.TSS_SERVER_FN_BASE": JSON.stringify(
        process.env.TSS_SERVER_FN_BASE,
      ),
    },
    test: {
      env: {
        TSS_SERVER_FN_BASE: process.env.TSS_SERVER_FN_BASE,
      },
      include: ["test/integration/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
      testTimeout: 30000,
    },
  };
});
```

Current responsibilities of this config:

- `cloudflareTest()` boots the Worker test runtime
- `wrangler.configPath` makes Wrangler config the source of truth for the Worker
- `remoteBindings: false` keeps bindings local to the test runtime
- `readD1Migrations()` loads SQL migrations into `TEST_MIGRATIONS`
- `root` is pinned to the repo root, not `test/integration`
- `tanstackStart()`, `viteReact()`, and `tsconfigPaths()` make the test Vite runtime match the app's Vite runtime closely enough for TanStack Start SSR modules to resolve
- the explicit `@` alias matches the main app config
- `define` and `test.env` seed `TSS_SERVER_FN_BASE` for direct server-fn RPC tests

## Server Function Base In Tests

The current test-only `TSS_SERVER_FN_BASE` wiring exists because the integration
suite calls TanStack client RPC code directly.

TanStack builds the RPC URL from `process.env.TSS_SERVER_FN_BASE`:

```ts
// refs/tan-start/packages/start-client-core/src/client-rpc/createClientRpc.ts
export function createClientRpc(functionId: string) {
  const url = process.env.TSS_SERVER_FN_BASE + functionId
```

The active integration smoke test does exactly that:

```ts
// test/integration/smoke.test.ts
const loginClientRpc = createClientRpc(loginServerFn.serverFnMeta.id);
```

Without the Vitest config override, that URL becomes `undefined...` in the test
runtime. So the current fix is intentionally test-local, not worker-local.

## Worker Under Test

`wrangler.jsonc` defines the app Worker entrypoint:

```jsonc
{
  "main": "./src/worker.ts"
}
```

`src/worker.ts` exports the Worker module Vitest exercises:

```ts
import serverEntry from "@tanstack/react-start/server-entry";

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const isMagicLinkRequest =
      (url.pathname === "/login" && request.method === "POST") ||
      url.pathname === "/api/auth/magic-link/verify";

    if (isMagicLinkRequest) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.MAGIC_LINK_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
    }

    return serverEntry.fetch(request, {
      context: {
        env,
        runEffect,
      },
    });
  },
};
```

So the tests target the actual Worker module, not a separate test-only server entry.

## Vite Alignment With The App

The integration config intentionally mirrors the main app Vite config.

`vite.config.ts`

```ts
plugins: [
  devtools(),
  cloudflare({ viteEnvironment: { name: "ssr" } }),
  viteTsConfigPaths({
    projects: ["./tsconfig.json"],
  }),
  tailwindcss(),
  tanstackStart(),
  viteReact({
    babel: {
      plugins: [
        ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
      ],
    },
  }),
],
```

The test config does not need every app plugin, but it does carry the important SSR-facing pieces:

- `tsconfigPaths()`
- `tanstackStart()`
- `viteReact()` with the decorators Babel plugin
- `@` alias to `src`

That keeps the Worker test runtime compatible with the same route and module resolution the app uses in development and build.

## D1 Migration Setup

Migrations are loaded in the Vitest config and applied before tests execute.

`test/apply-migrations.ts`

```ts
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.D1, env.TEST_MIGRATIONS);
```

`test/env.d.ts`

```ts
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
```

This gives the test runtime a typed `TEST_MIGRATIONS` binding while keeping the real D1 binding on `env.D1`.

The current shape intentionally combines two Cloudflare patterns:

- keep the D1 helper import on `cloudflare:test`
- use the non-deprecated `env` import from `cloudflare:workers`
- type the test-only binding by augmenting `Cloudflare.Env`

That last part is the important workaround. In this repo, the generated runtime types still export `cloudflare:workers.env` as `Cloudflare.Env`:

```ts
export const env: Cloudflare.Env;
```

So `TEST_MIGRATIONS` has to exist on `Cloudflare.Env` for `env.TEST_MIGRATIONS` to typecheck.

## TypeScript Wiring

`test/tsconfig.json` provides the test-only type environment:

```json
{
  "compilerOptions": {
    "types": [
      "vitest",
      "node",
      "@cloudflare/vitest-pool-workers",
      "@cloudflare/vitest-pool-workers/types",
      "@playwright/test"
    ],
    "module": "esnext",
    "moduleResolution": "bundler",
    "rootDirs": [".."]
  }
}
```

That gives the tests Vitest globals, Cloudflare Worker test types, and access to the generated Worker bindings in `worker-configuration.d.ts`.

The extra `@cloudflare/vitest-pool-workers/types` entry still matters in practice. In `0.14.1`, `cloudflare:test` is declared in `types/cloudflare-test.d.ts`, and the package root types do not themselves expose a `ProvidedEnv` declaration.

## ProvidedEnv Research

Cloudflare docs still present `ProvidedEnv` as the intended hook for typing `cloudflare:workers.env`:

```ts
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
```

But the current repo state does not line up cleanly with that guidance.

What the aligned `wrangler@4.80.0` and `@cloudflare/vitest-pool-workers@0.14.1` sources show:

- `worker-configuration.d.ts` exports `env` as `Cloudflare.Env`, not `ProvidedEnv`
- installed `@cloudflare/vitest-pool-workers` shipped types contain no `ProvidedEnv` declaration
- Cloudflare's own D1 fixture still types `TEST_MIGRATIONS` by augmenting `Cloudflare.Env`

Cloudflare D1 fixture:

```ts
declare namespace Cloudflare {
  interface Env {
    DATABASE: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
```

That fixture is from the same aligned Workers SDK snapshot now vendored in `refs/workers-sdk`.

I also tested a local `ProvidedEnv` override in `test/env.d.ts` and `pnpm typecheck:test` still failed with:

```txt
Property 'TEST_MIGRATIONS' does not exist on type 'Env'.
```

So the working conclusion here is:

- docs mention `ProvidedEnv`
- actual D1 example fixtures use `Cloudflare.Env`
- actual generated/runtime-consumed types in this repo also use `Cloudflare.Env`
- therefore the reliable local workaround is to augment `Cloudflare.Env` directly

## Test Invocation Pattern

The current smoke test covers both Worker fetches and server-fn RPC calls.

It calls the Worker through `cloudflare:workers`:

`test/integration/smoke.test.ts`

```ts
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("integration smoke", () => {
  it("renders /login", async () => {
    const response = await exports.default.fetch("http://example.com/login");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in / Sign up");
  });
});
```

It also calls a TanStack server function through the real Worker using `runServerFn` from `test/test-utils.ts`:

```ts
import { runServerFn } from "@test/test-utils";

const result = await runServerFn({
  serverFn: login,
  data: { email: "u@u.com" },
});
```

`runServerFn` uses `createClientRpc()` to serialize the server fn call, then routes the request through `exports.default.fetch()`:

```ts
// test/test-utils.ts
const clientRpc = createClientRpc(serverFn.serverFnMeta.id);
const fetchServerFn = (url: string, init?: RequestInit) =>
  exports.default.fetch(new Request(new URL(url, "http://example.com"), init));
```

The JSDoc on `runServerFn` clarifies that it bypasses client middleware and routing, running the server fn via the worker fetch handler.

So the core test shapes are:

- import the Worker module from `cloudflare:workers`
- call `exports.default.fetch()` with an app URL
- optionally route TanStack client RPC requests back through `exports.default.fetch()`
- assert on the full Worker response

## Current Suite Shape

Current integration tests under `test/integration/`:

- `smoke.test.ts` exercises `/login` through `exports.default.fetch()`
- `smoke.test.ts` also exercises the `login` server fn through `runServerFn()` from `test/test-utils.ts`

Shared test utilities in `test/test-utils.ts`:

- `resetDb()` - clears D1 tables between tests
- `runServerFn()` - runs a server fn via client RPC through the Worker fetch handler
- `ServerFn<TInputValidator, TResponse>` - type for server fns used with `runServerFn`
- `extractSessionCookie()` - extracts better-auth session cookie from response headers
- `parseSetCookie()` - parses Set-Cookie header into key-value record
- `getSetCookie()` - gets the raw Set-Cookie header

## Known Warnings

### Empty href warning on every SSR render

```
An empty string ("") was passed to the href attribute. To fix this, either do not
render the element at all or pass null to href instead of an empty string.
```

This appears in stderr for every test that renders a page (visible with `--reporter=verbose`).

**Source:** `src/routes/__root.tsx` imports `appCss` via Vite's `?url` suffix:

```ts
import appCss from "../styles.css?url";
```

and passes it to `head()`:

```ts
head: () => ({
  links: [{ rel: "stylesheet", href: appCss }],
}),
```

**Mechanism:** In the workerd test runtime there is no Vite dev server or asset pipeline. The `?url` import resolves to an empty string `""`. That flows through `HeadContent` → `<link rel="stylesheet" href="">`. React DOM's development SSR renderer (`react-dom-server.edge.development.js:1437`) warns whenever any element receives `href=""`.

**Impact:** Cosmetic only. The warning does not affect test correctness — the test environment exercises server-side logic (server fns, loaders, auth, D1), not client-side asset loading.

## Bottom Line

Vitest is integrated here as a Worker-first integration setup:

- the real Worker comes from `wrangler.jsonc` -> `src/worker.ts`
- Vitest runs through `@cloudflare/vitest-pool-workers`
- the test Vite config includes the TanStack Start and React plugins the app depends on
- the test Vite config also seeds `TSS_SERVER_FN_BASE` so direct server-fn RPC tests work without patching `src/worker.ts`
- D1 migrations are injected into Miniflare and applied in a setup file
- tests exercise the Worker by calling `exports.default.fetch()` and by routing TanStack client RPC requests through that same Worker
- `ProvidedEnv` is not currently the effective source of truth for `env` typing here; `Cloudflare.Env` is

That is the current integration model in this repo.
