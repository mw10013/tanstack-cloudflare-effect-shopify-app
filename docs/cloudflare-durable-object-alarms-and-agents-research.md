# Cloudflare Durable Object Alarms And Agents Research

## Bottom Line

- Native Durable Object alarms are durable, but only within the Durable Object model: one alarm slot per object, durable storage-backed metadata, at-least-once delivery, and bounded automatic retries.
- Native alarms are not exactly-once, not unbounded-retry, and not a substitute for workflow checkpointing.
- Yes, alarms can be used to build fault-tolerant and eventually consistent operations, but only if the operation is driven from durable state and the handler is idempotent.
- Cloudflare Agents does support alarms, but indirectly. The Agents SDK multiplexes a single Durable Object alarm into many SQL-backed schedules in `cf_agents_schedules`.
- For testing, `@cloudflare/vitest-pool-workers` gives strong direct-control helpers, but `runDurableObjectAlarm()` is a deterministic test hook, not a full simulation of production retry/backoff semantics.

## Sources Checked

- `refs/cloudflare-docs/src/content/docs/durable-objects/api/alarms.mdx`
- `refs/cloudflare-docs/src/content/docs/durable-objects/examples/alarms-api.mdx`
- `refs/cloudflare-docs/src/content/docs/durable-objects/examples/testing-with-durable-objects.mdx`
- `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/{test-apis,configuration,isolation-and-concurrency,recipes,known-issues}.mdx`
- `refs/cloudflare-docs/src/content/docs/durable-objects/{concepts/what-are-durable-objects,concepts/durable-object-lifecycle,platform/known-issues,best-practices/rules-of-durable-objects,best-practices/error-handling}.mdx`
- `refs/cloudflare-docs/src/content/changelog/durable-objects/{2026-02-24-deleteall-deletes-alarms,2025-12-15-rules-of-durable-objects}.mdx`
- `refs/cloudflare-docs/src/content/docs/workflows/{build/rules-of-workflows,get-started/durable-agents}.mdx`
- `refs/agents/docs/{scheduling,agent-class,retries}.md`
- `refs/agents/packages/agents/src/index.ts`
- `refs/agents/packages/agents/src/tests/{schedule.test.ts,agents/schedule.ts}`
- `refs/agents/packages/agents/CHANGELOG.md`
- `refs/workers-sdk/packages/vitest-pool-workers/{types/cloudflare-test.d.ts,src/worker/durable-objects.ts,CHANGELOG.md}`
- `refs/workers-sdk/fixtures/vitest-pool-workers-examples/durable-objects/{src/index.ts,test/alarm.test.ts,vitest.config.ts,wrangler.jsonc,README.md}`
- `refs/workers-sdk/packages/miniflare/{src/plugins/do/index.ts,CHANGELOG.md}`

## Native Durable Object Alarm Guarantees

### What Cloudflare explicitly guarantees

From `refs/cloudflare-docs/src/content/docs/durable-objects/api/alarms.mdx`:

```md
- Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`.
- Alarms have guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws.
- Retries are performed using exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed.
```

And later in the same file:

```md
- Only one instance of `alarm()` will ever run at a given time per Durable Object instance.
- The `alarm()` handler has guaranteed at-least-once execution and will be retried upon failure using exponential backoff, starting at 2 second delays for up to 6 retries. This only applies to the most recent `setAlarm()` call.
```

That gives the real baseline:

- one alarm slot per Durable Object
- at-least-once, not exactly-once
- automatic retry only for uncaught exceptions
- bounded retry budget: initial failure plus up to 6 retries
- one in-flight `alarm()` per object at a time

### What “durable” means here

Cloudflare describes Durable Objects themselves as having private durable storage:

From `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/what-are-durable-objects.mdx`:

```md
- Each Durable Object has its own durable, transactional, and strongly consistent storage, persisted across requests, and accessible only within that object.
```

The Alarms API is implemented via that storage layer:

From `refs/cloudflare-docs/src/content/docs/durable-objects/api/alarms.mdx`:

```md
Durable Objects alarms allow you to schedule the Durable Object to be woken up at a time in the future ... alarm operations follow the same rules as other storage operations.
```

Recent changelog evidence makes this more concrete:

From `refs/cloudflare-docs/src/content/changelog/durable-objects/2026-02-24-deleteall-deletes-alarms.mdx`:

```md
Alarm usage stores metadata in an object's storage, which required a separate `deleteAlarm()` call to fully clean up all storage for an object.
```

From `refs/workers-sdk/packages/miniflare/CHANGELOG.md`:

```md
An upcoming version of workerd stores per-namespace alarm metadata in a `metadata.sqlite` file alongside per-actor `.sqlite` files.
```

Conclusion: alarms are durable in the same sense DO storage is durable. They survive hibernation/eviction/restart. They are not just in-memory timers.

### Important caveats Cloudflare also documents

From `refs/cloudflare-docs/src/content/docs/durable-objects/api/alarms.mdx`:

```md
If `getAlarm` is called while an `alarm` is already running, it returns `null` unless `setAlarm` has also been called since the alarm handler started running.
```

```md
If you call `setAlarm` when there is already one scheduled, it will override the existing alarm.
```

```md
Calling `deleteAlarm()` inside the `alarm()` handler may prevent retries on a best-effort basis, but is not guaranteed.
```

```md
If the Durable Object wakes up after being inactive, the constructor is invoked before the `alarm` handler.
```

Practical meaning:

- alarms are single-slot, so app-level schedulers must multiplex
- constructor code can accidentally stomp an already-scheduled alarm
- `deleteAlarm()` is not a reliable “cancel all retries” primitive inside a currently-running alarm
- code inside `alarm()` must tolerate re-entry and duplicate execution

### Alarm handlers can restart on another machine

From `refs/cloudflare-docs/src/content/docs/durable-objects/api/alarms.mdx`:

```md
If an unexpected error terminates the Durable Object, the `alarm()` handler may be re-instantiated on another machine.
Following a short delay, the `alarm()` handler will run from the beginning on the other machine.
```

That is the strongest direct signal that alarms are fault-tolerant only via replay-from-start, not via in-handler checkpointing.

### Strong storage, eventually-consistent deployments

Do not confuse durable per-object storage consistency with deployment consistency.

From `refs/cloudflare-docs/src/content/docs/durable-objects/platform/known-issues.mdx`:

```md
Code changes for Workers and Durable Objects are released globally in an eventually consistent manner.
```

Cloudflare immediately follows that with the practical consequence:

```md
it is best practice to ensure that API changes between your Workers and Durable Objects are forward and backward compatible across code updates.
```

So the object's storage and execution model are strongly consistent, but the Worker version calling the object and the DO version receiving the call may temporarily differ during rollout.

## Are Alarms Fault-Tolerant And Durable?

### Short answer

Yes, but with narrow guarantees.

What you get:

- durable scheduling state
- wake-up after hibernation/eviction
- at-least-once execution
- automatic bounded retry for uncaught failures
- serialized execution inside one object

What you do not get:

- exactly-once execution
- durable sub-step checkpointing inside the handler
- infinite retries
- cross-object or cross-service transactionality
- automatic deduplication of external side effects

### The real engineering rule

Treat a DO alarm as a durable nudge to re-run reconciliation logic for one object, not as a durable workflow engine.

## Can Alarms Make Operations Fault-Tolerant And Eventually Consistent?

### Yes, if you build around durable intent

Cloudflare explicitly positions alarms this way.

From `refs/cloudflare-docs/src/content/docs/durable-objects/api/alarms.mdx`:

```md
Alarms can be used to build distributed primitives, like queues or batching of work atop Durable Objects.
Alarms also provide a mechanism to guarantee that operations within a Durable Object will complete without relying on incoming requests to keep the Durable Object alive.
```

From `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/what-are-durable-objects.mdx`:

```md
You can combine Alarms with in-memory state and the durable storage API to build batch and aggregation applications such as queues, workflows, or advanced data pipelines.
```

And the official batching example in `refs/cloudflare-docs/src/content/docs/durable-objects/examples/alarms-api.mdx` stores batched requests in DO storage, then drains them in `alarm()`.

That pattern is the right one:

1. Write intent to durable DO storage first.
2. Use the alarm to wake the object later.
3. Re-read storage in `alarm()`.
4. Apply idempotent business logic.
5. Mark progress in storage.
6. Re-arm the alarm if work remains.

### What makes the pattern safe

From `refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/rules-of-durable-objects.mdx`:

```md
In rare cases, alarms may fire more than once. Your `alarm()` handler should be safe to run multiple times without causing issues.
```

The same guide shows the core technique: read durable state first, skip already-completed work, then write completion state.

### Where the limit is

Native alarm retries stop after the bounded retry window. Cloudflare documents this directly:

From `refs/cloudflare-docs/src/content/docs/durable-objects/api/alarms.mdx`:

```md
Because alarms are only retried up to 6 times on error, it's recommended to catch any exceptions inside your `alarm()` handler and schedule a new alarm before returning if you want to make sure your alarm handler will be retried indefinitely.
```

So:

- alarms can drive eventual consistency
- alarms alone do not guarantee eventual success forever
- indefinite recovery is an application-level responsibility

### Recommended pattern for “eventually consistent” DO work

Use alarms for object-local reconciliation loops:

- store a job row, cursor, or status record in DO storage/SQLite
- make the handler idempotent via a status field, sequence number, or dedupe key
- on success, mark progress and clear/reschedule
- on recoverable failure, catch and explicitly `setAlarm()` again
- on external side effects, persist an idempotency key before the call

### Where alarms are the wrong tool

Use something stronger than raw alarms when you need:

- multi-step durable checkpointing
- human-in-the-loop pauses
- long-running orchestration across many services
- rich retry policy and history

Cloudflare Workflows is the clearer fit there.

From `refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx`:

```md
Each step is a self-contained, individually retryable component of a Workflow. Steps may emit state that allows a Workflow to persist and continue from that step, even if a Workflow fails due to a network or infrastructure issue.
```

And from `refs/cloudflare-docs/src/content/docs/workflows/get-started/durable-agents.mdx`:

```md
If any step fails, Workflows retries it automatically. If the entire Workflow crashes mid-task, it resumes from the last successful step.
```

That is a stronger guarantee than bare DO alarms.

## Agents SDK Support For Alarms

### Agents uses alarms under the hood

From `refs/agents/docs/scheduling.md`:

```md
Under the hood, scheduling uses Durable Object alarms to wake the agent at the right time. Tasks are stored in a SQLite table and executed in order.
```

And from `refs/agents/docs/agent-class.md`:

```md
Agents support scheduled execution of methods by wrapping the Durable Object's `alarm()`.
Since DOs only allow one alarm at a time, the `Agent` class works around this by managing multiple schedules in SQL and using a single alarm.
```

So the answer is:

- yes, Agents supports alarms
- no, Agents does not add a new platform alarm primitive
- it builds a scheduler on top of the one native DO alarm slot

### What Agents persists

From `refs/agents/packages/agents/src/index.ts`:

```sql
CREATE TABLE IF NOT EXISTS cf_agents_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  callback TEXT,
  payload TEXT,
  type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
  time INTEGER,
  delayInSeconds INTEGER,
  cron TEXT,
  intervalSeconds INTEGER,
  running INTEGER DEFAULT 0,
  execution_started_at INTEGER,
  retry_options TEXT
)
```

And the user-facing doc says the same thing more simply:

From `refs/agents/docs/scheduling.md`:

```md
Scheduled tasks survive agent restarts and are persisted to SQLite.
```

That is the key Agents-level durability story.

### What guarantees Agents adds on top

Agents adds app-layer behavior the native DO alarm API does not give you directly:

- multiple schedules multiplexed over one DO alarm
- delayed, date, cron, and interval modes
- SQL persistence for schedule rows
- idempotent schedule creation for cron by default, interval always, delayed/date opt-in
- overlap prevention for interval jobs
- hung interval recovery
- keepAlive heartbeat multiplexed onto the same alarm slot

Evidence from `refs/agents/packages/agents/src/index.ts`:

- `schedule()` writes rows to `cf_agents_schedules`, then calls `_scheduleNextAlarm()`
- `scheduleEvery()` is idempotent on `(callback, intervalSeconds, payload)`
- `_scheduleNextAlarm()` picks the earliest ready schedule and calls `this.ctx.storage.setAlarm(nextTimeMs)`
- `alarm()` loads all due schedule rows, executes callbacks, then either reschedules cron/interval or deletes one-shot rows

### Re-arming lost alarms after restart/eviction

This is one of the most important Agents behaviors.

From `refs/agents/packages/agents/src/index.ts`:

```ts
// Overdue schedules can happen after a DO restart
// because the SQLite row survives but the in-memory alarm does not.
```

And `_scheduleNextAlarm()` explicitly recalculates the next alarm from stored rows.

The tests confirm this behavior.

From `refs/agents/packages/agents/src/tests/schedule.test.ts`:

```ts
it("should re-arm a lost alarm when idempotency returns an existing interval schedule", ...)
```

```ts
it("should immediately re-arm an overdue interval schedule when idempotency returns the existing row", ...)
```

This is exactly the kind of logic you need if you want a scheduler that survives DO wake/sleep cycles.

### Interval overlap and hung-job recovery

From `refs/agents/docs/scheduling.md`:

```md
If a callback takes longer than the interval, the next execution is skipped (not queued).
```

And the implementation tracks `running` plus `execution_started_at`, then either skips or force-resets a hung interval.

The tests cover both:

- `should skip execution when running flag is already set (concurrent prevention)`
- `should force-reset hung interval schedule after 30 seconds`

### Agents retry semantics are separate from native alarm retries

This is easy to miss.

Inside `Agent.alarm()`, scheduled callbacks are executed through app-level retry logic (`tryN(...)`) using serialized `retry_options` stored in SQLite. That is distinct from the native DO alarm retry budget.

From `refs/agents/docs/retries.md`:

```md
If the callback throws, it is retried according to the retry options. If all attempts fail, the error is logged and routed through `onError()`. The schedule is still removed (for one-time schedules) or rescheduled (for cron/interval) regardless of success or failure.
```

And the same doc calls out the limitation:

```md
- No dead-letter queue. If a queued or scheduled task fails all retry attempts, it is removed.
```

So Agents improves ergonomics and resilience, but one-shot scheduled work is still not an infinite durable retry queue.

### Agents keepAlive also uses the single alarm slot

From `refs/agents/docs/scheduling.md`:

```md
`keepAlive()` uses ... the Durable Object alarm system directly.
No schedule rows are created ... the heartbeat is invisible to `getSchedules()`.
The alarm system multiplexes all schedules and the keepAlive heartbeat through a single alarm slot.
```

That is a clean confirmation that Agents is still built on the same single native alarm.

## How Durable Is Agents Scheduling In Practice?

For Agent scheduling specifically:

- schedule definitions are durable because they live in SQLite
- the wake-up mechanism is durable because it uses DO alarms
- the next-alarm computation is reconstructed from SQLite after restart
- interval execution state has some recovery logic (`running`, `execution_started_at`)
- one-shot task completion is not exactly-once
- one-shot task failure is not infinitely retried

Good fit:

- reminders
- polling
- maintenance
- retries with explicit backoff policy
- object-local eventual consistency loops

Not sufficient alone for:

- payment-grade exactly-once side effects
- multi-step durable orchestration with checkpoints
- durable dead-lettering / audit trail of failed jobs

## Testing Alarms With Cloudflare Vitest Integration

### Official test APIs

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx`:

```md
runInDurableObject(...)
```

```md
runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>
Immediately runs and removes the Durable Object pointed to by stub's alarm if one is scheduled.
```

And the handwritten public types in `refs/workers-sdk/packages/vitest-pool-workers/types/cloudflare-test.d.ts` match that contract exactly.

### The durable-object fixture is the best concrete example

The example fixture at `refs/workers-sdk/fixtures/vitest-pool-workers-examples/durable-objects/` includes:

- a DO with `scheduleReset(afterMillis)` calling `state.storage.setAlarm(...)`
- an `alarm()` handler that resets state
- a test that uses `runDurableObjectAlarm(stub)` and asserts `true` then `false`

From `test/alarm.test.ts`:

```ts
let ran = await runDurableObjectAlarm(stub);
expect(ran).toBe(true);

ran = await runDurableObjectAlarm(stub);
expect(ran).toBe(false);
```

### Current recommended setup

The modern docs prefer:

- `exports.default.fetch()` from `cloudflare:workers` for integration tests
- `runInDurableObject()` and `runDurableObjectAlarm()` from `cloudflare:test` for direct DO tests

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx`:

```md
Use `exports.default.fetch()` to write integration tests against your Worker's default export handler.
```

The older `SELF` helper still appears in many fixtures, but the public types mark it deprecated.

### Very important limitation: `runDurableObjectAlarm()` is not a full production simulation

The implementation in `refs/workers-sdk/packages/vitest-pool-workers/src/worker/durable-objects.ts` is:

```ts
const alarm = await state.storage.getAlarm();
if (alarm === null) return false;
await state.storage.deleteAlarm();
await instance.alarm?.();
return true;
```

That means this helper:

- checks whether an alarm exists
- removes it
- directly calls `instance.alarm()`

It does not simulate:

- native exponential backoff timing
- native retryCount / isRetry metadata
- re-instantiation on another machine
- the full platform scheduler lifecycle

So `runDurableObjectAlarm()` is excellent for deterministic business-logic tests, but not for validating the production retry engine.

### `alarmInfo` is not really test-covered by this helper

Cloudflare documents `alarm(alarmInfo)` with:

- `retryCount`
- `isRetry`

But `runDurableObjectAlarm()` calls `instance.alarm?.()` with no argument. So if you need to validate behavior keyed on `alarmInfo.retryCount`, the stock helper is not enough.

### Storage isolation docs are inconsistent; trust known issues plus source

There is doc drift here.

Older and example-oriented docs say or imply alarm tests are isolated:

From `refs/cloudflare-docs/src/content/docs/durable-objects/examples/testing-with-durable-objects.mdx`:

```md
Each test gets isolated storage automatically
```

And the 2025-12 changelog says:

```md
can test Durable Objects with isolated storage
```

But the current `known-issues.mdx` says the opposite for alarms specifically:

```md
Durable Object alarms are not reset between test runs and do not respect isolated storage.
Ensure you delete or run all alarms with `runDurableObjectAlarm()` scheduled in each test before finishing the test.
```

Given the current helper implementation and explicit known issue, treat `known-issues.mdx` as source of truth.

### Practical testing guidance

For DO alarms in Vitest:

1. Schedule the alarm using a stub or `runInDurableObject()`.
2. Assert pre-alarm state.
3. Call `await runDurableObjectAlarm(stub)`.
4. Assert post-alarm state.
5. Before the test ends, make sure no pending alarm remains.

Good cleanup patterns:

- call `runDurableObjectAlarm()` until it returns `false`
- or explicitly call `state.storage.deleteAlarm()` through `runInDurableObject()`

### Other test constraints worth noting

From `refs/cloudflare-docs/src/content/docs/workers/testing/vitest-integration/test-apis.mdx` and the public types:

- `runInDurableObject()` and `runDurableObjectAlarm()` only work for stubs pointing at Durable Objects defined in the main worker
- `runInDurableObject()` is effectively a temporary fetch-handler swap plus a synthetic request
- per-file storage isolation is the general model, but alarms are a documented exception

## Local Development Caveats

Two local-dev details matter if you rely on alarms:

- `refs/cloudflare-docs/src/content/docs/durable-objects/platform/known-issues.mdx` says DO alarms may fail after hot reload in `wrangler dev`; restart dev after edits.
- `refs/cloudflare-docs/src/content/docs/workers/testing/miniflare/storage/durable-objects.md` says raw Miniflare DO persistence is in-memory by default unless you configure `durableObjectsPersist`.

So do not confuse:

- production durability
- local persistence config
- Vitest storage isolation

They are related, but not the same guarantee.

## Recommendation

### Use native DO alarms when

- the work is naturally scoped to one Durable Object
- you can durably record intent and progress in DO storage
- the handler can be idempotent
- eventual completion is acceptable
- bounded automatic retry plus explicit rescheduling is enough

### Use Agents scheduling when

- you want multiple logical schedules per object
- you want cron/interval/delay/date APIs
- you want SQL-backed schedule state
- you can accept that failed one-shot tasks are removed after retry exhaustion

### Use Workflows when

- you need durable multi-step checkpoints
- retries must survive engine restarts in the middle of a larger workflow
- you need a stronger model for long-running agent operations
- you need clearer auditability and orchestration semantics

## Final Answers

### Are alarms fault-tolerant and durable?

Yes, with bounded guarantees: durable scheduling metadata, wake-after-restart, at-least-once execution, and automatic bounded retries.

### What guarantees do they have?

- one alarm slot per DO
- durable storage-backed alarm state
- one in-flight `alarm()` per object
- at-least-once execution
- exponential backoff starting at 2 seconds
- up to 6 automatic retries
- replay-from-start after crash/reinstantiation

### Can they be used to make operations fault-tolerant and eventually consistent?

Yes, if you store durable intent and make handlers idempotent. No, if you need exactly-once side effects or durable multi-step checkpointing without additional machinery.

### Do Cloudflare Agents support alarms?

Yes. Agents uses native DO alarms under the hood and adds a SQL-backed multi-schedule layer. That gives better ergonomics and some recovery logic, but not stronger core runtime guarantees than Durable Objects themselves.

## Case Study: Refactoring `deleteInvoice` From Cloudflare Queue To Agent Alarms

A worked example of swapping a Cloudflare Queue round-trip for `this.schedule()` inside an agent. Full background lives in `docs/refactor-delete-invoice-to-agent-alarms-research.md`; this section captures only what is generalizable.

### Implementation Shape

```ts
yield* Effect.tryPromise({
  try: () =>
    this.schedule(
      0,
      "onFinalizeInvoiceDeletion",
      { invoiceId, r2ObjectKey },
      { retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000 } },
    ),
  catch: (cause) => new OrganizationAgentError({ ... }),
});
yield* repo.deleteInvoice(invoiceId); // eager local delete after schedule is durable
```

The callback is a plain instance method (not `@callable()`), dispatched by name through `this[callback](payload)`. No decorator, signature change, or rename required.

### Caveats and Gotchas

- **Schedule first, then mutate.** The `schedule()` row is the durable intent anchor. A crash between `schedule()` and the local row delete is safe — the alarm fires and the idempotent handler converges. The reverse order can orphan the side effect with no recovery hook.
- **SDK retry budget defaults are tight.** `baseDelayMs: 100, maxDelayMs: 3000, maxAttempts: 3` adds up to ~600ms total backoff. Real dependency brownouts (R2, D1, third-party APIs) outlast that. Widen `baseDelayMs` / `maxDelayMs` rather than just increasing `maxAttempts`.
- **No DLQ.** Per `refs/agents/docs/retries.md`: *"If a queued or scheduled task fails all retry attempts, it is removed."* There is no automatic landing zone for poison messages.
- **`maxAttempts` includes the initial call.** "Two retries" means `maxAttempts: 3`, not `2`.
- **Miniflare auto-fires `setAlarm(now)` callbacks in tests.** With `schedule(0, ...)` the alarm fires within milliseconds — before test code can re-enter and observe `cf_agents_schedules`. There is no documented hook in `@cloudflare/vitest-pool-workers` to pause the platform scheduler. This invalidates any test that asserts intermediate "row exists / runs once" state on delay-0 schedules.
- **`runDurableObjectAlarm()` does not simulate native exponential backoff.** It fires `alarm()` once per call. To exercise app-level retries deterministically, throw inside the handler and assert the row's `running` flag or final removal; do not rely on the helper to walk the retry curve.

### Testing Pattern That Worked

Drop assertions on intermediate state. Verify the end-to-end contract via polling:

1. Trigger the operation that schedules the alarm.
2. Poll the *observable side effect* (HEAD on the storage object, DB row absence, downstream state) until it converges.
3. Poll `cf_agents_schedules` row count for the relevant `callback` until it drains to `0`.
4. Drain remaining alarms defensively at end of test (DO alarms persist across test runs and do not respect isolated storage — `refs/cloudflare-docs/.../platform/known-issues.mdx`).
5. For idempotency tests, pre-mutate the side effect into the "already done" state before triggering the schedule, then re-poll for the same convergence.

The defensive drain at end-of-test is mostly insurance for non-zero-delay schedules; for delay-0 the platform scheduler will normally drain it before the test ends.

### Trade-offs vs. The Enqueue Pattern

| Dimension          | Cloudflare Queue                                          | Agent `schedule()`                                                  |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Durable intent     | Queue storage                                             | `cf_agents_schedules` in the originating DO's SQLite                |
| Retry horizon      | Queue retry policy + DLQ catches survivors                | App-level `tryN` with bounded backoff, then row is dropped          |
| Failure recovery   | DLQ inspectable, replayable                               | None — orphaned side effect, no recovery hook                       |
| Scope              | Cross-DO orchestration; consumer resolves a fresh stub    | Single-DO; no cross-object hop                                      |
| Latency / overhead | Network hop + worker invocation per message               | In-process alarm tick on the same DO                                |
| Observability      | Queue metrics, DLQ                                        | Just rows in the agent's SQLite — must build your own observability |
| Granularity        | One queue, one consumer, message-typed switch             | One named callback per schedule, dispatched by string               |

The qualitative summary: alarms are simpler, faster, and colocated with the data they touch, but their failure budget is shorter and their failures are silent.

### When To Accept The No-DLQ Trade

Use this rubric. If you cannot answer **yes to all five**, prefer a queue (or some other replayable buffer):

1. **Is the work cleanup or eventual reconciliation, not a system-of-record write?** Failed cleanup leaks resources; failed system-of-record writes leak truth. Only the former is recoverable later.
2. **Is the orphaned side effect independently detectable?** A nightly sweep, storage lifecycle rule, foreign-key check, or audit job needs to be able to find and remediate the leak without the original message.
3. **Is the dependency's failure rate well below the retry window?** If dependency brownouts routinely outlast `maxDelayMs * maxAttempts`, retries will not save you and you need replay.
4. **Does the operation live entirely inside the originating DO's blast radius?** Cross-DO or cross-system operations benefit from a queue's separation of concerns and independent retry. Single-DO work does not.
5. **Is "best effort, bounded" acceptable to the product?** If a stakeholder will ask "what happened to message X" you need a DLQ. If the failure mode is "very rare orphan that gets swept later," you do not.

If any answer is "no," the right move is one of: keep the queue, add a reconciliation loop (`scheduleEvery` + status column on the resource), or split the work so the durable-write portion stays on a queue and only the cleanup tail moves to an alarm.
