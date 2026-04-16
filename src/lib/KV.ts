import { Effect, Layer, Schedule, Schema, Context } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

/**
 * Effect service wrapping Cloudflare Workers KV.
 *
 * All operations automatically retry on transient errors with exponential
 * backoff (1s base, jittered, up to 2 retries). Retryable signals:
 * - `"network connection lost"` — transient Workers runtime connection failure
 * - `"daemondown"` — temporary problem invoking the Worker
 * - `"kv put failed: 429 too many requests"` — per-key write rate limit
 *   (1 write/sec/key); harmless no-op for reads since they never produce this
 *
 * The 1s base delay is intentional: KV enforces 1 write/sec/key, so retrying
 * sooner would just hit the rate limit again.
 */
export class KV extends Context.Service<KV>()("KV", {
  make: Effect.gen(function* () {
    const { KV: kv } = yield* CloudflareEnv;
    const get = Effect.fn("KV.get")(function* (key: string) {
      return yield* tryKV(() => kv.get(key));
    });
    const getJson = Effect.fn("KV.getJson")(function* <T>(key: string) {
      return yield* tryKV(() => kv.get<T>(key, "json"));
    });
    const getBulk = Effect.fn("KV.getBulk")(function* (keys: string[]) {
      return yield* tryKV(() => kv.get(keys));
    });
    const getWithMetadata = Effect.fn("KV.getWithMetadata")(function* <
      Metadata = unknown,
    >(key: string) {
      return yield* tryKV(() => kv.getWithMetadata<Metadata>(key));
    });
    const getWithMetadataJson = Effect.fn("KV.getWithMetadataJson")(function* <
      T,
      Metadata = unknown,
    >(key: string) {
      return yield* tryKV(() => kv.getWithMetadata<T, Metadata>(key, "json"));
    });
    const put = Effect.fn("KV.put")(function* (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) {
      return yield* tryKV(() => kv.put(key, value, options));
    });
    const del = Effect.fn("KV.delete")(function* (key: string) {
      return yield* tryKV(() => kv.delete(key));
    });
    const list = Effect.fn("KV.list")(function* <Metadata = unknown>(
      options?: KVNamespaceListOptions,
    ) {
      return yield* tryKV(() => kv.list<Metadata>(options));
    });
    return {
      get,
      getJson,
      getBulk,
      getWithMetadata,
      getWithMetadataJson,
      put,
      delete: del,
      list,
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

export class KVError extends Schema.TaggedErrorClass<KVError>()("KVError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

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
