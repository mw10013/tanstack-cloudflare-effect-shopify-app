import { ConfigProvider, Layer, Logger, References, Context } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

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
