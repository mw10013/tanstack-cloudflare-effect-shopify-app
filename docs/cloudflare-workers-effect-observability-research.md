# Cloudflare Workers + Effect v4 Observability (Option A)

## Short Answer

- Yes, the current direction is sound.
- Keep one pipeline: Cloudflare-native traces + Cloudflare-native logs.
- Use Effect `withLogSpan` for app-level timing in logs.
- Keep sampling explicit at `1` for both logs and traces in `wrangler.jsonc`.
- Do not add an OTEL exporter path in this repo now; Cloudflare Worker tracing still does not support custom in-worker spans/attributes.

## Repo State (already aligned)

From `wrangler.jsonc`:

```json
{
  "observability": {
    "enabled": true,
    "logs": {
      "invocation_logs": true,
      "head_sampling_rate": 1
    },
    "traces": {
      "enabled": true,
      "head_sampling_rate": 1
    }
  }
}
```

From `src/lib/LayerEx.ts`:

```ts
Logger.layer(
  environment === "production"
    ? [Logger.consoleJson, Logger.tracerLogger]
    : [Logger.consolePretty(), Logger.tracerLogger],
  { mergeWithExisting: false },
)
```

This is the exact base needed for Option A.

## Why Option A is correct

Cloudflare tracing docs: tracing is automatic for handler calls, fetch, and bindings once enabled.

Cloudflare limitations docs (critical):

- trace IDs are not propagated externally yet
- support for custom spans and custom attributes is still in progress

Effect docs/source:

- `Effect.withLogSpan` enriches logs (records log-span label + start time)
- `Logger.formatJson` includes a `spans` object in structured logs

So the practical model is:

- Cloudflare traces = platform/runtime visibility
- Effect `withLogSpan` + `annotateLogs` = app timing/context in logs

## Decision

We standardize on Option A only:

1. Keep Cloudflare native traces/logs enabled with `head_sampling_rate: 1`.
2. Keep `Logger.consoleJson` in production (`src/lib/LayerEx.ts`).
3. Add `Effect.withLogSpan` at business-operation boundaries.
4. Add `Effect.annotateLogs` for stable dimensions (`organizationId`, `userId`, `workflow`, `operation`, etc.).
5. No OTEL destination/export configuration for this repo.

## Where to use `withLogSpan` first

Highest-value boundaries:

- `src/invoice-extraction-workflow.ts`: workflow `run()` and its step groups (`load`, `extract`, `save`)
- `src/organization-agent.ts`: `onInvoiceUpload`, `syncMembershipImpl`
- `src/routes/_mkt.pricing.tsx`: `upgradeSubscriptionServerFn`
- `src/lib/Auth.ts`: `sendMagicLink`, `ensureBillingPortalConfiguration`
- `src/lib/Stripe.ts`: `getPlans`, `ensureBillingPortalConfiguration`
- `src/worker.ts`: cron cleanup in `scheduled()`

Avoid `withLogSpan` on tiny helpers and low-level D1/KV/R2 wrappers.

## Example shape

```ts
Effect.gen(function* () {
  yield* Effect.logInfo("invoice.extract.started", { invoiceId })
  yield* loadFile()
  yield* callModel()
  yield* saveResult()
  yield* Effect.logInfo("invoice.extract.complete", { invoiceId })
}).pipe(
  Effect.annotateLogs({ operation: "invoice.extract", invoiceId }),
  Effect.withLogSpan("invoice.extract"),
)
```

With `Logger.consoleJson`, logs include `spans` timing data that Cloudflare captures.

## Notes on OTEL wording

Cloudflare does support OTLP export endpoints. The blocker for this repo is narrower: Cloudflare Worker native tracing does not yet support custom in-worker spans/attributes. That is why we stay on Option A.

## Sources

- `refs/cloudflare-docs/src/content/docs/workers/observability/traces/index.mdx`
- `refs/cloudflare-docs/src/content/docs/workers/observability/traces/known-limitations.md`
- `refs/cloudflare-docs/src/content/docs/workers/observability/traces/spans-and-attributes.mdx`
- `refs/cloudflare-docs/src/content/docs/workers/observability/exporting-opentelemetry-data/index.mdx`
- `refs/cloudflare-docs/src/content/docs/logs/logpush/logpush-job/datasets/account/workers_trace_events.md`
- `refs/effect4/ai-docs/src/08_observability/index.md`
- `refs/effect4/ai-docs/src/08_observability/10_logging.ts`
- `refs/effect4/packages/effect/src/Effect.ts`
- `refs/effect4/packages/effect/src/Logger.ts`
- `wrangler.jsonc`
- `src/lib/LayerEx.ts`
