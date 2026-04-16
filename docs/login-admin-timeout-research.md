# Login integration timeout research

## Question

Why does `admin login -> verify magic link -> access admin route` time out when `renders /login` runs first, but pass when `renders /login` is skipped?

## What I ran

- `pnpm test:integration test/integration/login.test.ts`
- `pnpm vitest --config test/integration/vitest.config.ts run test/integration/login.test.ts -t "admin login"`
- Repro variants in a temporary test file (created and deleted) to isolate trigger conditions.

## Key observations

### 1) It is not just test-order/state leakage

I reproduced the timeout inside a single test body:

1. `workerFetch("http://w/login")`
2. consume the response body (`response.text()` or `response.body?.cancel()`)
3. call `loginAdmin("a@a.com")`

That single test times out on step 3.

This means the trigger is in request/stream behavior, not only cross-test isolation.

### 2) The trigger is consuming `/login` response body

Matrix from repro runs:

- `fetch /login` + **no body read** + `loginAdmin` -> passes
- `fetch /login` + **`response.text()`** + `loginAdmin` -> hangs until timeout
- `fetch /login` + **`response.body?.cancel()`** + `loginAdmin` -> hangs until timeout
- `fetch /pricing` + `response.text()` + `loginAdmin` -> passes
- `fetch /` + `response.text()` + `loginAdmin` -> passes

So this is specific to the `/login` page stream completion path.

### 3) Where the hang occurs

With `--disableConsoleIntercept`, logs show:

- `/login` request completes and body is fully read (`/login html length 7677` logged)
- then `_serverFn/<id>` request is received
- then no `auth.sendMagicLink`/`auth.magicLink.generated` logs appear
- test times out

When it passes, those auth logs appear immediately after `_serverFn/<id>`.

This indicates the stall happens very early in server-fn request handling (before login flow logs), likely while parsing/dispatching the POST RPC request.

## Code/doc excerpts supporting the conclusion

From `test/integration/login.test.ts`:

```ts
it.effect.only("renders /login", () =>
  Effect.gen(function* () {
    const response = yield* workerFetch("http://w/login");
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toContain("Sign in / Sign up");
  }),
);

it.effect.only("admin login -> verify magic link -> access admin route", () =>
  Effect.gen(function* () {
    const { sessionCookie } = yield* loginAdmin("a@a.com");
    expect(sessionCookie).toContain("better-auth.session_token=");
  }),
);
```

From `test/TestUtils.ts` (`loginAdmin` path):

```ts
const result = yield* callServerFn({ serverFn: loginServerFn, data: { email } });
```

From TanStack Start server-fn handler (`@tanstack/start-server-core`):

```js
if (contentType?.includes("application/json")) jsonPayload = await request.json();
```

From Cloudflare Vitest docs (`refs/cloudflare-docs/.../known-issues.mdx`):

```md
When making requests via fetch or R2.get(), consume the entire response body
```

Our repro shows `/login` is an exception path in this stack: consuming that page body triggers a subsequent server-fn POST stall.

## Most likely root cause

High-confidence: a runtime/framework interaction bug on the `/login` SSR stream completion path (TanStack Start + Workers Vitest pool/workerd), not an auth/domain logic bug.

Why:

- login works when called alone
- login works after consuming other page bodies (`/`, `/pricing`)
- only `/login` body consumption poisons the next server-fn POST request
- stall happens before login flow logs fire

`/login` is special because it imports and wires the same `login` server function via `useServerFn(login)` in route render code, so stream-finalization/hydration serialization for that route is the likely differentiator.

## Why skipping `renders /login` makes admin test pass

Because the problematic `/login` body-consumption path does not run, the subsequent `loginAdmin` server-fn call is not stalled.

## Practical mitigations for tests (short-term)

1. Keep `admin login` in a file/run path that does not first consume `/login` response body.
2. For the `/login` smoke assertion, avoid full body consumption (assert status only) until root issue is fixed.
3. Track this as a framework/runtime repro and upstream if needed, since behavior points below app business logic.

## Follow-up: consume-body rule vs this hang

### What Cloudflare docs say

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/known-issues.mdx`:

```md
When making requests via fetch or R2.get(), consume the entire response body
```

Also in the same file:

```md
Dynamic import() statements do not work inside export default handlers when
writing integration tests with exports.default.fetch()
```

### What workers-sdk source/fixtures say

From `refs/workers-sdk/fixtures/vitest-pool-workers-examples/dynamic-import/test/dynamic-import.test.ts`:

```ts
// calling exports.default.fetch() on a worker whose fetch handler uses a
// dynamic import() would hang
```

From `refs/workers-sdk/packages/vitest-pool-workers/CHANGELOG.md` (`0.13.5`):

```md
Support dynamic import() inside entrypoint and Durable Object handlers
...
calling exports.default.fetch() ... would hang
```

From `refs/workers-sdk/packages/vitest-pool-workers/src/worker/index.ts`:

```ts
// Dynamic import() ... fails with "Cannot perform I/O on behalf of a different
// Durable Object"
```

### Interpretation for this repo

- We are already consuming `/login` body in `test/integration/login.test.ts:12`.
- In repro, consuming `/login` body is exactly what precedes the hang.
- The next call is a TanStack server-fn request whose id includes `tss-serverfn-split` (dynamic import split path).
- Running with shared storage flags (`--maxWorkers=1 --no-isolate`) still times out, so this is not the documented per-file-isolation WebSocket limitation.

So for this specific timeout, "you forgot to consume response bodies" is unlikely to be the root cause. The stronger match is a dynamic-import/module-runner context issue in the vitest-pool-workers/runtime path.

### Remaining body-consumption hygiene gaps (real, but likely not this timeout)

In `test/TestUtils.ts`:

- `loginAdmin()` does not consume `verifyResponse` body (`test/TestUtils.ts:250`) before using headers.
- `loginAdmin()` does not consume `appResponse` body (`test/TestUtils.ts:258`) before returning.
- same pattern exists in `loginUser()` (`test/TestUtils.ts:208`, `test/TestUtils.ts:216`).

Those should be cleaned up for isolation hygiene, but they occur after the currently hanging step (`callServerFn(login)`), so they do not explain this particular stall.
