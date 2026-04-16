# User Provisioning Integration Testing Research

How to integration-test the user provisioning flow: the enqueue-as-safety-net pattern in `Auth.ts` databaseHooks, the `UserProvisioningWorkflow` steps, and `createOrganization` idempotency.

## Test Targets

### 1. Enqueue Safety Net (Auth.ts L112-139)

The `databaseHooks.user.create` has two hooks:
- **before**: `enqueue({ action: "EnsureUserProvisioned", email })` — durable queue job
- **after**: `ensureUserProvisionedWorkflow(...)` wrapped in `Effect.ignoreCause` — best-effort inline

**What to test**: If the `after` hook fails silently, the queued `EnsureUserProvisioned` message still triggers provisioning via `processEnsureUserProvisioned` in `Q.ts:104-114`.

### 2. Workflow Steps (user-provisioning-workflow.ts)

Four `step.do` calls:
1. `create-organization` — creates org + owner member via Better Auth API
2. `initialize-active-organization-for-sessions` — sets `activeOrganizationId` on null sessions
3. `init-organization-agent` — initializes Durable Object stub with name
4. `sync-membership` — calls `stub.syncMembership({ userId, change: "added" })`

### 3. createOrganization Idempotency

Three states to cover:
1. **Org + owner member exist** → short-circuit via `getOwnerOrganizationByUserId`
2. **Neither exists** → `createOrganization` succeeds normally
3. **Org exists, owner member missing** → catches `ORGANIZATION_ALREADY_EXISTS`, looks up by slug, calls `addMember`

---

## Testing Approach: Cloudflare Vitest Pool Workers

The project already uses `@cloudflare/vitest-pool-workers` with D1 migrations auto-applied. Integration tests run inside the Workers runtime with real bindings.

### Existing Infrastructure

- **Config**: `test/integration/vitest.config.ts` — uses `cloudflareTest()` plugin with `miniflare`
- **Utilities**: `test/TestUtils.ts` — `resetDb()`, `workerFetch()`, `callServerFn()`, `login()`
- **Seed helpers**: `test/integration/repository.test.ts` — `seedUser()`, `seedOrganization()`, `seedMember()`, `seedSession()`
- **Layer pattern**: Tests use `@effect/vitest`'s `layer()` with `Layer.provideMerge` chains

### Vitest Config Additions

For queue and workflow testing, the vitest config may need:

```ts
cloudflareTest({
  miniflare: {
    queueConsumers: {
      "tces-q-local": { maxBatchTimeout: 0.05 },
    },
  },
})
```

This enables automatic queue consumer dispatch in the test environment with a short batch timeout.

---

## Testing Workflows with Introspectors

`@cloudflare/vitest-pool-workers` provides workflow introspection APIs from `cloudflare:test`.

### Pattern A: Known Instance ID — `introspectWorkflowInstance()`

```ts
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";

it("provisions user via workflow", async () => {
  const INSTANCE_ID = "test-user-id";

  await using instance = await introspectWorkflowInstance(
    env.USER_PROVISIONING_WORKFLOW,
    INSTANCE_ID,
  );

  await instance.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });

  await env.USER_PROVISIONING_WORKFLOW.create({
    id: INSTANCE_ID,
    params: { userId: INSTANCE_ID, email: "test@test.com" },
  });

  expect(await instance.waitForStepResult({ name: "create-organization" }))
    .toBeDefined();
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  const output = await instance.getOutput();
  expect(output).toHaveProperty("organizationId");
});
```

### Pattern B: Mock Individual Steps

```ts
await instance.modify(async (m) => {
  await m.mockStepResult({ name: "init-organization-agent" }, undefined);
  await m.mockStepResult({ name: "sync-membership" }, undefined);
});
```

This isolates `create-organization` and `initialize-active-organization-for-sessions` while skipping DO interactions.

### Pattern C: Test Step Failure + Retry

```ts
await instance.modify(async (m) => {
  await m.mockStepError(
    { name: "create-organization" },
    new Error("D1 transient"),
    2, // fail twice, then succeed
  );
});
```

### Key Introspector Methods

| Method | Purpose |
|--------|---------|
| `introspectWorkflowInstance(binding, id)` | Attach to a known instance |
| `introspectWorkflow(binding)` | Capture all instances created after this point |
| `instance.modify(fn)` | Configure mocks/overrides before execution |
| `m.disableSleeps()` | Skip `step.sleep()` calls |
| `m.disableRetryDelays()` | Skip retry backoff |
| `m.mockStepResult(step, result)` | Mock a step's return value |
| `m.mockStepError(step, error, times?)` | Fail a step N times |
| `instance.waitForStepResult(step)` | Block until step completes |
| `instance.waitForStatus(status)` | Block until workflow reaches status |
| `instance.getOutput()` | Get final workflow output |

**Disposal**: Use `await using` (TC39 explicit resource management) for automatic cleanup, or call `instance.dispose()` manually.

Reference: `refs/workers-sdk/fixtures/vitest-pool-workers-examples/workflows/test/unit.test.ts`

---

## Testing Queues

### Verifying Enqueue (Producer Side)

Spy on the queue binding's `send` method:

```ts
import { env } from "cloudflare:workers";
import { vi } from "vitest";

const sendSpy = vi.spyOn(env.Q, "send").mockResolvedValue(undefined);

// ... trigger user creation ...

expect(sendSpy).toHaveBeenCalledWith(
  expect.objectContaining({
    action: "EnsureUserProvisioned",
    email: "test@test.com",
  }),
);
```

### Testing Queue Consumer (processEnsureUserProvisioned)

Two approaches:

**A. Unit — call `processMessage` directly with an Effect test layer:**

The queue handler in `Q.ts` calls `processEnsureUserProvisioned` which does:
1. `repository.getUser(email)` → finds the user
2. `ensureUserProvisionedWorkflow({ userId, email })` → calls `USER_PROVISIONING_WORKFLOW.createBatch`

Test by providing a repository layer with a seeded user and verifying the workflow binding was called.

**B. Integration — use `createMessageBatch` + `getQueueResult`:**

```ts
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";

const messages = [{
  id: "msg-1",
  timestamp: new Date(),
  attempts: 1,
  body: { action: "EnsureUserProvisioned", email: "test@test.com" },
}];
const batch = createMessageBatch("tces-q-local", messages);
const ctx = createExecutionContext();

// Import the queue handler
await queueHandler(batch, env, ctx);

const result = await getQueueResult(batch, ctx);
expect(result.outcome).toBe("ok");
expect(result.explicitAcks).toContain("msg-1");
```

Reference: `refs/workers-sdk/fixtures/vitest-pool-workers-examples/queues/test/queue-consumer-unit.test.ts`

---

## Effect v4 Testing Patterns

### layer() from @effect/vitest

The project already uses this pattern. Build test layers that replace real services:

```ts
import { layer } from "@effect/vitest";
import { Layer, Context, Effect } from "effect";

const envLayer = Layer.succeedContext(Context.make(CloudflareEnv, env));
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);

layer(repositoryLayer)("user provisioning", (it) => {
  it.effect("createOrganization is idempotent", () =>
    Effect.gen(function* () {
      // seed, call, assert
    }));
});
```

### Testing Idempotency with Effect

Run the same effect multiple times and verify convergence:

```ts
it.effect("createOrganization idempotent — org + member exist", () =>
  Effect.gen(function* () {
    const user = yield* seedUser();
    const org = yield* seedOrganization({ slug: user.id });
    yield* seedMember({ userId: user.id, organizationId: org.id, role: "owner" });

    const result1 = yield* createOrganization({ userId: user.id, email: user.email });
    const result2 = yield* createOrganization({ userId: user.id, email: user.email });
    expect(result1).toBe(org.id);
    expect(result2).toBe(org.id);
  }));
```

### Testing Error Recovery (Effect.ignoreCause)

Verify that `Effect.ignoreCause` swallows failures:

```ts
it.effect("after hook failure does not propagate", () =>
  Effect.gen(function* () {
    const result = yield* Effect.succeed("provisioned").pipe(
      Effect.tap(() => Effect.fail("simulated failure")),
      Effect.ignoreCause({ log: "Warn", message: "test" }),
    );
    // Effect.ignoreCause returns void, so the tap failure is swallowed
  }));
```

### @effect/vitest API Summary

| API | Purpose |
|-----|---------|
| `it.effect(name, () => Effect)` | Run test as Effect with TestContext |
| `it.live(name, () => Effect)` | Run with real clock/console |
| `it.scoped(name, () => Effect)` | Run with Scope for resource management |
| `layer(TestLayer)(name, (it) => ...)` | Provide a layer to all tests in block |
| `it.layer(NestedLayer)(name, (it) => ...)` | Nest additional layers |
| `it.effect.each(cases)(name, fn)` | Parametrized Effect tests |

Reference: `refs/effect4/packages/vitest/test/index.test.ts`

---

## Proposed Test Plan

### File: `test/integration/user-provisioning.test.ts`

#### Test Group 1: createOrganization Idempotency

Uses a repository + auth layer. Tests the three states directly:

| Test | Setup | Assert |
|------|-------|--------|
| **happy path — neither exists** | seed user only | org created, member with role=owner exists |
| **short-circuit — org + member exist** | seed user + org + owner member | returns existing org id, no new rows |
| **recovery — org exists, member missing** | seed user + org (no member) | member added, returns existing org id |
| **double call convergence** | seed user | call twice, both return same org id |

#### Test Group 2: Queue Safety Net

| Test | Setup | Assert |
|------|-------|--------|
| **enqueue fires on user create before hook** | spy `env.Q.send`, trigger user create | spy called with `EnsureUserProvisioned` |
| **processEnsureUserProvisioned triggers workflow** | seed user, call `processMessage` | workflow binding `createBatch` called |
| **processEnsureUserProvisioned skips missing user** | call with nonexistent email | no workflow call, no error |

#### Test Group 3: Workflow Steps (via Introspectors)

| Test | Setup | Assert |
|------|-------|--------|
| **full workflow completes** | seed user in D1, create workflow instance | all 4 steps complete, output has `organizationId` |
| **workflow with mocked DO steps** | mock `init-organization-agent` + `sync-membership` | `create-organization` + `initialize-active-organization` run against real D1 |
| **step failure retries** | mock `create-organization` error twice | workflow still completes after retries |

#### Test Group 4: initializeActiveOrganizationForUserSessions

| Test | Setup | Assert |
|------|-------|--------|
| **sets activeOrganizationId on null sessions** | seed user + org + sessions with null activeOrgId | sessions updated |
| **idempotent — already-set sessions unchanged** | seed sessions with activeOrgId already set | no change |

---

## Layer Construction for Tests

The workflow test needs Auth + Repository + Stripe + KV. Two strategies:

### Strategy A: Full Layer Stack (Heavier, More Realistic)

Reuse `makeRuntimeLayer` from `user-provisioning-workflow.ts` but with test env bindings. Requires all config vars (BETTER_AUTH_URL, STRIPE_WEBHOOK_SECRET, etc.) to be present in the test environment.

### Strategy B: Surgical Layers (Lighter, More Isolated)

For `createOrganization` idempotency tests, only need Repository + Auth:

```ts
const envLayer = Layer.succeedContext(Context.make(CloudflareEnv, env));
const d1Layer = Layer.provideMerge(D1.layer, envLayer);
const kvLayer = Layer.provideMerge(KV.layer, envLayer);
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
const stripeLayer = Layer.provideMerge(Stripe.layer, Layer.merge(repositoryLayer, Layer.merge(d1Layer, kvLayer)));
const authLayer = Layer.provideMerge(Auth.layer, stripeLayer);
```

For queue consumer tests, only need Repository + CloudflareEnv (no Auth/Stripe).

### Strategy C: Mock Workflow Binding

For testing queue → workflow handoff without running the actual workflow:

```ts
const createBatchSpy = vi.spyOn(
  env.USER_PROVISIONING_WORKFLOW,
  "createBatch",
).mockResolvedValue(undefined);
```

