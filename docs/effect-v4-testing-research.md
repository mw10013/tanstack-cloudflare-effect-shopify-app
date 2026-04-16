# Effect v4 Testing — Research for Integration Test Conversion

## Goal

Convert `test/integration/login.test.ts` and its `test-utils.ts` helpers to idiomatic Effect v4, using `@effect/vitest`.

---

## Current Test Structure

### login.test.ts

Two tests:
1. **Renders /login** — `exports.default.fetch(url)` → assert status 200 + body content
2. **Login flow** — `resetDb()` → `runServerFn(login, data)` → fetch verify URL → extract session cookie → fetch authenticated route → assert

### test-utils.ts

| Helper | What it does |
|---|---|
| `resetDb()` | Batch-deletes rows from D1 tables via `env.D1` |
| `runServerFn()` | Calls a TanStack server fn via `createClientRpc` + `exports.default.fetch` |
| `extractSessionCookie()` | Parses `Set-Cookie` header for `better-auth.session_token` |
| `parseSetCookie()` | Generic cookie string → Record parser |
| `getSetCookie()` | Extracts raw `Set-Cookie` header from Response |

---

## @effect/vitest API

Source: `refs/effect4/packages/vitest/`

### Core imports

```ts
import { it, describe, assert, layer } from "@effect/vitest"
```

### Test runners

| Runner | Provides | Use when |
|---|---|---|
| `it.effect` | `TestClock`, `TestConsole`, `Scope` | **Default — most tests use this** |
| `it.live` | Real clock, real console, `Scope` | Need actual time/logging |
| `it.scoped` | `TestClock`, `TestConsole`, `Scope` | Managing `acquireRelease` resources |
| `it.scopedLive` | Real clock, `Scope` | Scoped + real time |

### Usage in Effect v4 codebase

| Runner | Occurrences |
|---|---|
| `it.effect` | **2,356** across 161 files |
| `it.live` | 28 across 12 files |
| `it.scoped` | 2 across 2 files |
| `it.scopedLive` | 0 |

`it.effect` is overwhelmingly the default. `it.live` is only used when tests explicitly need real time (e.g., `Date.now()` comparisons, actual `Effect.sleep` delays). Our integration tests don't need real time — they're request/response cycles — so `it.effect` is correct.

### Shared layers via `layer()`

```ts
layer(MyService.layerTest)("suite name", (it) => {
  it.effect("test", () =>
    Effect.gen(function*() {
      const svc = yield* MyService
    }))
})
```

- Layer built once in `beforeAll`, torn down in `afterAll`
- All tests share the same layer instance
- Nested: `it.layer(AnotherLayer)("nested", (it) => { ... })`

### Assertions

`assert` from `@effect/vitest` wraps vitest assertions:

```ts
assert.strictEqual(actual, expected)
assert.deepStrictEqual(actual, expected)
assert.isTrue(value)
```

Standard `expect()` also works inside `it.effect`.

---

## Effect.fn vs Effect.gen

From `refs/effect4/ai-docs/src/01_effect/01_basics/02_effect-fn.ts`:

> **Avoid creating functions that return an Effect.gen**, use `Effect.fn` instead.

`Effect.fn` is the idiomatic way to define functions returning Effects. It adds tracing spans and better stack traces. `Effect.gen` is for inline/anonymous Effect blocks (e.g., inside test bodies, Layer.effect constructors).

| Pattern | When to use |
|---|---|
| `Effect.fn("name")(function*(...) { ... })` | Named functions that return Effects — helpers, service methods |
| `Effect.gen(function*() { ... })` | Inline anonymous blocks — test bodies, layer constructors |

### Effect.fn in Effect v4 source

- Used in `Layer.ts` (38x), `LayerMap.ts` (4x), `Effect.ts` (3x), and throughout unstable/ modules
- Test bodies use `Effect.gen` (the block is anonymous), but helper functions within tests use `Effect.fn`
- Example from `refs/effect4/ai-docs/src/09_testing/20_layer-tests.ts`:

```ts
const create = Effect.fn("TodoRepo.create")(function*(title: string) {
  const todos = yield* Ref.get(store)
  const todo = { id: todos.length + 1, title }
  yield* Ref.set(store, [...todos, todo])
  return todo
})
```

---

## Effect v4 HTTP Utilities — Cookies

Source: `refs/effect4/packages/effect/src/unstable/http/Cookies.ts`

Effect v4 has a full `Cookies` module at `effect/unstable/http/Cookies`:

| Function | Signature | What it does |
|---|---|---|
| `fromSetCookie` | `(headers: Iterable<string> \| string) => Cookies` | Parse `Set-Cookie` header(s) into `Cookies` object |
| `get` | `(self: Cookies, name: string) => Option<Cookie>` | Get a cookie by name |
| `getValue` | `(self: Cookies, name: string) => Option<string>` | Get cookie value by name |
| `toCookieHeader` | `(self: Cookies) => string` | Serialize to `Cookie` header string (e.g., `"name=value; name2=value2"`) |
| `parseHeader` | `(header: string) => Record<string, string>` | Parse a `Cookie` header into key-value pairs |
| `toRecord` | `(self: Cookies) => Record<string, string>` | Convert cookies to record |

`HttpClientResponse` already exposes `.cookies: Cookies.Cookies` which auto-parses `Set-Cookie` from the response.

This means `extractSessionCookie`, `parseSetCookie`, and `getSetCookie` can all be replaced by Effect's built-in `Cookies` module.

---

## Conversion Plan

### TestUtils.ts — Effect v4 helpers using `Effect.fn`

```ts
import * as Cookies from "effect/unstable/http/Cookies"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { Effect, Option } from "effect"
import { env, exports } from "cloudflare:workers"

export const resetDb = Effect.fn("resetDb")(function*() {
  yield* Effect.promise(() =>
    env.D1.batch([
      ...["Session", "Member", "Invitation", "Verification", "Organization"]
        .map((t) => env.D1.prepare(`delete from ${t}`)),
      env.D1.prepare(`delete from Account where id <> 'admin'`),
      env.D1.prepare(`delete from User where id <> 'admin'`),
    ])
  )
})

export const workerFetch = Effect.fn("workerFetch")(
  function*(url: string, init?: RequestInit) {
    return yield* Effect.promise(() =>
      exports.default.fetch(new Request(url, init))
    )
  }
)

export const runServerFn = Effect.fn("runServerFn")(
  function*<TInputValidator, TResponse>(
    serverFn: ServerFn<TInputValidator, TResponse>,
    data: Parameters<ServerFn<TInputValidator, TResponse>>[0]["data"],
  ) {
    return yield* Effect.promise(() => {
      // black-box the createClientRpc + runWithStartContext dance
      const clientRpc = createClientRpc(serverFn.serverFnMeta!.id)
      const fetchServerFn = (url: string, init?: RequestInit) =>
        exports.default.fetch(new Request(url, init))
      return runWithStartContext(/* ... */, () =>
        clientRpc({ data, method: serverFn.method, fetch: fetchServerFn })
      ).then((r) => r.result as Awaited<TResponse>)
    })
  }
)

export const extractSessionCookie = Effect.fn("extractSessionCookie")(
  function*(response: Response) {
    const cookies = Cookies.fromSetCookie(
      response.headers.getSetCookie()
    )
    const token = Cookies.getValue(cookies, "better-auth.session_token")
    if (Option.isNone(token))
      return yield* Effect.fail(new Error("Missing session cookie"))
    return Cookies.toCookieHeader(cookies)
  }
)
```

### Cookie helpers replaced by Effect v4 builtins

| Old helper | Effect v4 replacement |
|---|---|
| `extractSessionCookie(response)` | `Cookies.fromSetCookie(response.headers.getSetCookie())` → `Cookies.getValue(cookies, name)` → `Cookies.toCookieHeader(cookies)` |
| `parseSetCookie(header)` | `Cookies.parseHeader(header)` |
| `getSetCookie(response)` | `response.headers.getSetCookie()` (native) or via `HttpClientResponse.cookies` |

### login.test.ts — Converted

```ts
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { login } from "@/lib/Login"
import { extractSessionCookie, workerFetch, resetDb, runServerFn } from "../TestUtils"

describe("integration smoke", () => {
  it.effect("renders /login", () =>
    Effect.gen(function*() {
      const response = yield* workerFetch("http://w/login")
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("Sign in / Sign up")
    }))

  it.effect("login → verify magic link → access authenticated route", () =>
    Effect.gen(function*() {
      yield* resetDb
      const result = yield* runServerFn(login, { email: "u@u.com" })
      expect(result.success).toBe(true)
      expect(result.magicLink).toContain("/api/auth/magic-link/verify")

      const verifyResponse = yield* workerFetch(result.magicLink ?? "", { redirect: "manual" })
      expect(verifyResponse.status).toBe(302)
      expect(new URL(verifyResponse.headers.get("location") ?? "").pathname).toBe("/login-callback")

      const sessionCookie = yield* extractSessionCookie(verifyResponse)
      expect(sessionCookie).toContain("better-auth.session_token=")

      const appResponse = yield* workerFetch(
        new URL(verifyResponse.headers.get("location") ?? "/", result.magicLink).toString(),
        { headers: { Cookie: sessionCookie } },
      )
      expect(appResponse.status).toBe(200)
      expect(new URL(appResponse.url).pathname).toMatch(/^\/app\/.+/)
      expect(yield* Effect.promise(() => appResponse.text())).toContain("Members")
    }))
})
```

---

## Decisions

1. **`it.effect` not `it.live`** — `it.effect` is the overwhelming default in Effect v4 (2,356 vs 28 uses). Our tests don't need real time. `it.effect` provides `TestClock` + `TestConsole` but that doesn't hurt — unused services are just available, not forced.

2. **`Effect.fn` for helpers, `Effect.gen` for test bodies** — Per Effect v4 docs: "Avoid creating functions that return an Effect.gen, use Effect.fn instead." Test bodies stay as `Effect.gen` (anonymous blocks).

3. **`Effect.promise` not `Effect.tryPromise`** — `Effect.tryPromise` does exist in Effect v4, but it's for async operations that may fail and need error mapping or recovery. Our `TestUtils.ts` wrappers (`env.D1.batch`, `exports.default.fetch`, `runWithStartContext`) treat rejection as an unexpected test defect, so `Effect.promise` is the better fit. Explicit test-level failures are still modeled separately with `Effect.fail`, e.g. missing session cookie.

4. **Plain `Error` for failures** — No custom tagged errors for test helpers. Keep it simple.

5. **`Cookies` module from `effect/unstable/http`** — Replaces all hand-rolled cookie parsing. `fromSetCookie`, `getValue`, `toCookieHeader` cover our needs.

6. **`@effect/vitest` compatibility** — Needs to be verified in the vitest cloudflare pool environment (`cloudflare:workers` imports suggest a custom pool). Try it and see.

---

## Files to Create/Modify

| File | Action |
|---|---|
| `test/TestUtils.ts` | New — Effect v4 versions of helpers using `Effect.fn` + `Cookies` module |
| `test/integration/login.test.ts` | Rewrite — use `@effect/vitest` `it.effect` + `TestUtils.ts` |
| `test/test-utils.ts` | Keep — other tests may still use it |
