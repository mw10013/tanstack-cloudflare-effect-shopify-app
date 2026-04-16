# KV Service Research

Research for creating `src/lib/KV.ts` — an Effect v4 service wrapping Cloudflare Workers KV.

## Existing Pattern: D1.ts

`src/lib/D1.ts` uses `ServiceMap.Service` with `make` pattern:

```ts
class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    const { D1: d1 } = yield* CloudflareEnv;
    return {
      /* methods returning Effects */
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

Key elements:

- `Schema.TaggedErrorClass` for typed errors
- `Effect.tryPromise` wrapper (`tryD1`) to catch and convert promise rejections
- `Effect.tapError` for error logging
- Retry logic with `Schedule.exponential` + `Schedule.jittered` for idempotent writes
- Accesses binding via `CloudflareEnv` service (`yield* CloudflareEnv`)

## CloudflareEnv Binding

```ts
// src/lib/CloudflareEnv.ts
export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");
```

`worker-configuration.d.ts` confirms `KV: KVNamespace` exists on `Env` (line 9).
`wrangler.jsonc` has `kv_namespaces` with `binding: "KV"`.

## KVNamespace API (from worker-configuration.d.ts)

### `get` — read values

```ts
get(key: Key, options?: Partial<KVNamespaceGetOptions<undefined>>): Promise<string | null>;
get(key: Key, type: "text"): Promise<string | null>;
get<ExpectedValue>(key: Key, type: "json"): Promise<ExpectedValue | null>;
get(key: Key, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
get(key: Key, type: "stream"): Promise<ReadableStream | null>;
// + overloads with KVNamespaceGetOptions
// Bulk: get(key: Array<Key>, ...) → Promise<Map<string, ...>>
```

### `put` — write values

```ts
put(key: Key, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: KVNamespacePutOptions): Promise<void>;
```

`KVNamespacePutOptions`:

```ts
interface KVNamespacePutOptions {
  expiration?: number; // seconds since epoch
  expirationTtl?: number; // seconds from now (min 60)
  metadata?: any | null; // max 1024 bytes serialized JSON
}
```

### `delete` — remove key-value pair

```ts
delete(key: Key): Promise<void>;
```

### `getWithMetadata` — read with metadata

```ts
getWithMetadata<Metadata>(key: Key, type: "json"): Promise<KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>;
// Returns { value, metadata, cacheStatus }
```

### `list` — enumerate keys

```ts
list<Metadata>(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<Metadata, Key>>;
```

`KVNamespaceListOptions`:

```ts
interface KVNamespaceListOptions {
  limit?: number; // max 1000 (default)
  prefix?: string | null;
  cursor?: string | null;
}
```

`KVNamespaceListResult` is a discriminated union on `list_complete`:

```ts
type KVNamespaceListResult<Metadata, Key> =
  | {
      list_complete: false;
      keys: KVNamespaceListKey<Metadata, Key>[];
      cursor: string;
      cacheStatus: string | null;
    }
  | {
      list_complete: true;
      keys: KVNamespaceListKey<Metadata, Key>[];
      cacheStatus: string | null;
    };
```

`KVNamespaceListKey`:

```ts
interface KVNamespaceListKey<Metadata, Key> {
  name: Key;
  expiration?: number;
  metadata?: Metadata;
}
```

## KV Characteristics (from Cloudflare docs)

- **Eventually consistent**: writes visible locally immediately, up to 60s elsewhere
- **Read-optimized**: high-read, low-write workloads (config, assets, caches, allow/deny lists)
- **Max value size**: 25 MiB
- **Max key length**: 512 bytes
- **Write rate limit**: 1 write/sec per key (429 Too Many Requests on violation)
- **cacheTtl**: min 30s, default 60s — controls edge cache duration for reads
- **Bulk read**: `get(keys[])` up to 100 keys, counts as single operation
- **Pagination**: `list()` returns max 1000 keys, use `cursor` for more
- **Metadata**: up to 1024 bytes JSON per key, set via `put()` options

## Effect v4 Patterns (from refs/effect4)

### ServiceMap.Service with `make`

```ts
class MyService extends ServiceMap.Service<MyService>()("MyService", {
  make: Effect.gen(function* () {
    // access dependencies
    return {
      /* service methods */
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
```

### Error class

```ts
class MyError extends Schema.TaggedErrorClass<MyError>()("MyError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}
```

### tryPromise wrapper

```ts
const tryKV = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new KVError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));
```

## Proposed KV.ts Design

### Error

- `KVError` via `Schema.TaggedErrorClass` — mirrors `D1Error`

### Service methods to expose

Following the D1 pattern of thin wrappers that return Effects:

| Method            | Wraps                            | Returns                                            |
| ----------------- | -------------------------------- | -------------------------------------------------- |
| `get`             | `kv.get(key, type?)`             | `Effect<string \| null, KVError>` (text default)   |
| `getJson`         | `kv.get<T>(key, "json")`         | `Effect<T \| null, KVError>`                       |
| `put`             | `kv.put(key, value, options?)`   | `Effect<void, KVError>`                            |
| `delete`          | `kv.delete(key)`                 | `Effect<void, KVError>`                            |
| `list`            | `kv.list(options?)`              | `Effect<KVNamespaceListResult<Metadata>, KVError>` |
| `getWithMetadata` | `kv.getWithMetadata(key, type?)` | `Effect<{value, metadata, cacheStatus}, KVError>`  |

### Retry Deep Dive

#### KV error landscape

**1. Write rate limit — 429 (put only)**

- 1 write/sec to the **same key**. Writes to different keys are unlimited (paid). Source: `refs/cloudflare-docs/src/content/docs/kv/platform/limits.mdx` line 14, FAQ line 48.
- Error message: `"KV PUT failed: 429 Too Many Requests"`
- Only affects `put`. Reads are not per-key rate limited (unlimited on paid plan).

**2. Transient infrastructure errors (all operations)**

- Workers runtime documents `Network connection lost` as a retryable runtime error: "Connection failure. Catch a fetch or binding invocation and retry it." Source: Cloudflare Workers errors docs, runtime errors table.
- `daemonDown` — "A temporary problem invoking the Worker." Also transient.
- KV has experienced elevated timeouts during infrastructure issues (Oct 2025 incident, Jun 2025 major outage caused by storage provider failure).
- D1 service already retries on similar transient signals: `"network connection lost"`, `"internal error"`, `"transient issue on remote node"`, `"reset because its code was updated"`. These same infrastructure-level errors can occur for KV since both sit on Workers runtime.

**3. Non-retryable errors**

- Application logic errors (wrong key format, value too large >25MiB)
- Auth/permission errors
- Memory/CPU limit exceeded

#### Retry design: two layers

Since KV puts are **inherently idempotent** (no auto-increment, no append, last-write-wins), we don't need an `idempotentWrite` opt-in flag like D1. All KV operations are safe to retry on transient errors. This simplifies the design vs D1.

**Layer 1: Transient error retry (all operations)**
Applied automatically to every `tryKV` call. Retries on infrastructure-level transient errors that affect any KV operation (reads and writes alike).

```ts
const RETRYABLE_KV_SIGNALS = ["network connection lost", "daemondown"] as const;
```

**Layer 2: Write rate limit retry (put only)**
Applied automatically to `put`. Retries on 429 rate limiting since puts are always idempotent.

```ts
const RETRYABLE_KV_WRITE_SIGNALS = [
  "kv put failed: 429 too many requests",
] as const;
```

#### Recommendation: single unified retry

Collapsing to one retry layer applied in `tryKV`. Reads will never produce a 429 message, so including the 429 signal in the unified list is a no-op for reads — zero cost, zero false positives. This eliminates the two-layer complexity while keeping the same behavior.

### Skeleton

```ts
import { Effect, Layer, Schedule, Schema, ServiceMap } from "effect";
import { CloudflareEnv } from "@/lib/CloudflareEnv";

export class KVError extends Schema.TaggedErrorClass<KVError>()("KVError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export class KV extends ServiceMap.Service<KV>()("KV", {
  make: Effect.gen(function* () {
    const { KV: kv } = yield* CloudflareEnv;
    return {
      get: (key: string) => tryKV(() => kv.get(key)),
      getJson: <T>(key: string) => tryKV(() => kv.get<T>(key, "json")),
      getBulk: (keys: string[]) => tryKV(() => kv.get(keys)),
      getWithMetadata: <Metadata = unknown>(key: string) =>
        tryKV(() => kv.getWithMetadata<Metadata>(key)),
      getWithMetadataJson: <T, Metadata = unknown>(key: string) =>
        tryKV(() => kv.getWithMetadata<T, Metadata>(key, "json")),
      put: (
        key: string,
        value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
        options?: KVNamespacePutOptions,
      ) => tryKV(() => kv.put(key, value, options)),
      delete: (key: string) => tryKV(() => kv.delete(key)),
      list: <Metadata = unknown>(options?: KVNamespaceListOptions) =>
        tryKV(() => kv.list<Metadata>(options)),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

const RETRYABLE_KV_SIGNALS = [
  "network connection lost",
  "daemondown",
  "kv put failed: 429 too many requests",
] as const;

const tryKV = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new KVError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.retry({
      while: (error) => {
        const message = error.message.toLowerCase();
        return RETRYABLE_KV_SIGNALS.some((signal) => message.includes(signal));
      },
      times: 2,
      schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
    }),
  );
```

### Resolved questions

1. **Retry** — Single unified retry in `tryKV`, no opt-in flag, no separate layers. Retries on transient infra errors (`"network connection lost"`, `"daemondown"`) and write rate limit (`"kv put failed: 429 too many requests"`). The 429 signal is harmless for reads (never matches). 2 retries, exponential backoff from 1s with jitter.

2. **Bulk get** — Exposed as `getBulk(keys[])`. Returns `Map<string, string | null>`. Counts as single operation against 1,000 ops/invocation limit. Max 100 keys.

3. **getWithMetadata** — Two variants: `getWithMetadata` (text) and `getWithMetadataJson`. Skip arrayBuffer/stream.

4. **List pagination** — Leave to caller. Thin wrapper returning `KVNamespaceListResult`. Caller checks `list_complete` and passes `cursor`.
