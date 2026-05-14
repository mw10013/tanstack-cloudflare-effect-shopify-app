import { Cause, ConfigProvider, Layer, Logger, References, Context } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

export const formatErrorMessage = (error: Error): string => {
  const message = error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
  return error.cause instanceof Error ? `${message}\n[cause]: ${formatErrorMessage(error.cause)}` : message;
};

/**
 * Flattens an Effect `Cause` into a single string suitable for `new Error(message)`
 * at an RPC / serialization boundary.
 *
 * Why a single string: TanStack Start's `ShallowErrorPlugin` and Cloudflare DO
 * RPC both strip everything except `.message` when an `Error` crosses the
 * boundary — `.name`, `._tag`, `.cause`, `.stack`, and custom properties are
 * dropped, then the client reconstructs `new Error(message)`. Anything not
 * encoded inside `.message` is gone.
 *
 * `Cause.prettyErrors` normalizes arbitrary failures and defects (strings,
 * primitives, plain objects, `Error` subclasses, Effect `TaggedError`s, nested
 * causes) into `Error[]`, so this works regardless of what user code threw or
 * failed with. `formatErrorMessage` then walks each `.cause` chain so the full
 * chain renders into the joined string. This is especially important for
 * unannotated `Effect.tryPromise`, whose `UnknownError` wrapper has a generic
 * message ("An error occurred in Effect.tryPromise") and the useful detail on
 * `.cause`.
 */
export const causeToErrorMessage = <E>(cause: Cause.Cause<E>): string =>
  Cause.prettyErrors(cause).map(formatErrorMessage).join("\n");

export const makeEnvLayer = (env: Env) =>
  Layer.succeedContext(
    Context.make(CloudflareEnv, env).pipe(
      Context.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    ),
  );

export const makeLoggerLayer = (env: Env) => {
  const environment = env.ENVIRONMENT === "production" ? "production" : "local";
  return Layer.merge(
    Logger.layer(
      environment === "production"
        ? [Logger.consoleJson, Logger.tracerLogger]
        : [Logger.consolePretty(), Logger.tracerLogger],
      { mergeWithExisting: false },
    ),
    Layer.succeed(
      References.MinimumLogLevel,
      environment === "production" ? "Info" : "Debug",
    ),
  );
};
