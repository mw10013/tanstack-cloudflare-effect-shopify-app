import { Effect, Layer, Option, Schedule, Schema, Context } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

export class D1 extends Context.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    const { D1: d1 } = yield* CloudflareEnv;
    const prepare = (query: string) => d1.prepare(query);
    const batch = Effect.fn("D1.batch")(function* <T = Record<string, unknown>>(
      statements: D1PreparedStatement[],
      options?: {
        readonly idempotentWrite?: boolean;
      },
    ) {
      return yield* tryD1(() => d1.batch<T>(statements)).pipe(
        retryIfIdempotentWrite(options?.idempotentWrite),
      );
    });
    const run = Effect.fn("D1.run")(function* <T = Record<string, unknown>>(
      statement: D1PreparedStatement,
      options?: {
        readonly idempotentWrite?: boolean;
      },
    ) {
      return yield* tryD1(() => statement.run<T>()).pipe(
        retryIfIdempotentWrite(options?.idempotentWrite),
      );
    });
    const first = Effect.fn("D1.first")(function* <T>(
      statement: D1PreparedStatement,
    ) {
      return yield* tryD1(() => statement.first<T>()).pipe(
        Effect.map(Option.fromNullishOr),
      );
    });
    return {
      prepare,
      /**
       * Executes a transactional batch of prepared statements.
       * Set `idempotentWrite` to `true` to enable application-level retries
       * for transient D1 errors.
       */
      batch,
      /**
       * Executes a prepared statement and returns a D1 result object.
       * Set `idempotentWrite` to `true` to enable application-level retries
       * for transient D1 errors.
       */
      run,
      first,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

const RETRYABLE_ERROR_SIGNALS = [
  "reset because its code was updated",
  "starting up d1 db storage caused object to be reset",
  "network connection lost",
  "internal error in d1 db storage caused object to be reset",
  "cannot resolve d1 db due to transient issue on remote node",
  "can't read from request stream because client disconnected",
] as const;

const tryD1 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new D1Error({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.tapError((error) => Effect.logError(error)));

const retryIfIdempotentWrite =
  (idempotentWrite?: boolean) =>
  <A>(effect: Effect.Effect<A, D1Error>) =>
    idempotentWrite
      ? effect.pipe(
          Effect.retry({
            while: (error) => {
              const message = error.message.toLowerCase();
              return RETRYABLE_ERROR_SIGNALS.some((signal) =>
                message.includes(signal),
              );
            },
            times: 2,
            schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
          }),
        )
      : effect;
