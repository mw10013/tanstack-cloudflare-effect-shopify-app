import { isNotFound, isRedirect } from "@tanstack/react-router";
import serverEntry from "@tanstack/react-start/server-entry";
import { Cause, Effect, Layer, Context, ManagedRuntime } from "effect";
import * as Exit from "effect/Exit";

import { D1 } from "@/lib/D1";
import { KV } from "@/lib/KV";
import { makeEnvLayer, makeLoggerLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { Shopify } from "@/lib/Shopify";

const makeAppLayer = (env: Env, request: Request) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const kvLayer = Layer.provideMerge(KV.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const requestLayer = Layer.succeedContext(
    Context.make(CurrentRequest, request),
  );
  const shopifyLayer = Layer.provideMerge(
    Shopify.layer,
    Layer.merge(repositoryLayer, requestLayer),
  );
  return Layer.mergeAll(
    d1Layer,
    kvLayer,
    repositoryLayer,
    shopifyLayer,
    requestLayer,
    makeLoggerLayer(env),
  );
};

/**
 * Builds a per-request `ManagedRuntime` and returns a `runEffect` function for
 * HTTP request handlers (fetch, server functions).
 *
 * `ManagedRuntime` memoizes the layer build so services (`D1`, `KV`,
 * `Repository`, `Shopify`, …) are constructed once per request and reused
 * across every `runEffect` call within that request, rather than being rebuilt
 * on each invocation.
 *
 * `runEffect` converts Effect failures to throwable values compatible with
 * TanStack Start's server function error serialization. Uses `runPromiseExit`
 * instead of `runPromise` to inspect the `Exit` and ensure the thrown value is
 * always an `Error` instance (which TanStack Start can serialize via seroval).
 * Raw non-Error values from `Effect.fail` would otherwise pass through
 * `causeSquash` unboxed and fail the client-side `instanceof Error` check,
 * producing an opaque "unexpected error" message.
 *
 * TanStack `redirect`/`notFound` objects placed in the defect channel via
 * `Effect.die` are detected and re-thrown as-is so TanStack's control flow
 * (HTTP 307 redirects, 404 not-found handling) works from within Effect
 * pipelines.
 *
 * **Error message preservation:** TanStack Router's `ShallowErrorPlugin`
 * (seroval plugin used during SSR dehydration) serializes ONLY `.message`
 * from Error objects — `.name`, `._tag`, `.stack`, and all custom properties
 * are stripped. On the client it reconstructs `new Error(message)`. Effect v4
 * errors like `NoSuchElementError` set `.name` on the prototype and often
 * have `.message = undefined` (own property via `Object.assign`), so after
 * dehydration the client receives a bare `Error` with an empty message.
 * To ensure the error boundary always has something meaningful to display,
 * we normalize the thrown Error to always carry a non-empty `.message`,
 * using `Cause.pretty` which includes the error name and server-side stack
 * trace. This causes some duplication in the browser (the client-generated
 * `.stack` echoes `.message` in V8 environments) but preserves the full
 * server context that would otherwise be lost after `ShallowErrorPlugin`
 * strips everything except `.message`.
 */
const makeRunEffect = (env: Env, request: Request) => {
  const appLayer = makeAppLayer(env, request);
  const managedRuntime = ManagedRuntime.make(appLayer);
  const runEffect = async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof appLayer>>,
  ): Promise<A> => {
    const exit = await managedRuntime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const squashed = Cause.squash(exit.cause);
    // oxlint-disable-next-line @typescript-eslint/only-throw-error -- redirect is a Response, notFound is a plain object; TanStack expects these thrown as-is
    if (isRedirect(squashed) || isNotFound(squashed)) throw squashed;
    if (squashed instanceof Error) {
      if (Cause.isUnknownError(squashed) && squashed.cause instanceof Error) {
        squashed.message = squashed.cause.message;
      } else if (!squashed.message) {
        squashed.message = Cause.pretty(exit.cause);
      }
      throw squashed;
    }
    throw new Error(Cause.pretty(exit.cause));
  };
  return { runEffect, managedRuntime };
};

/**
 * Per-request context injected by `serverEntry.fetch` and typed via Start's
 * `Register.server.requestContext`.
 *
 * Server functions consume this through `context` in handlers
 * (`createServerFn(...).handler(({ context }) => ...)`), so per-request
 * runtime data is available without importing
 * `@tanstack/react-start/server`.
 *
 * Why avoid that import in route modules: `@tanstack/react-start/server` is a
 * barrel that re-exports SSR stream/runtime modules, which pull Node builtins
 * (`node:stream`, `node:stream/web`, `node:async_hooks`) into the client build
 * graph and can trigger Rollup errors like:
 * `"Readable" is not exported by "__vite-browser-external"`.
 *
 * References:
 * - Import Protection (why imports can stay alive):
 *   https://tanstack.com/start/latest/docs/framework/react/guide/import-protection#common-pitfall-why-some-imports-stay-alive
 * - Server Entry Point request context (this pattern):
 *   https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point#request-context
 */
export interface ServerContext {
  runEffect: ReturnType<typeof makeRunEffect>["runEffect"];
}

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: ServerContext };
  }
}

export default {
  fetch(request, env, ctx) {
    const { runEffect, managedRuntime } = makeRunEffect(env, request);
    const responsePromise = runEffect(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: async () =>
            serverEntry.fetch(request, {
              context: {
                runEffect,
              },
            }),
          catch: (cause) => cause,
        });
        /**
         * Shopify encapsulates document response policy here: HTML gate,
         * shop-param sanitization, and the Cloudflare immutable-response
         * clone/new-Response pattern for header updates.
         */
        const shopify = yield* Shopify;
        return yield* shopify.withShopifyDocumentHeaders(request, response);
      }),
    );
    // Keep the isolate alive until services are torn down after the response is sent.
    // Ideally: responsePromise.finally(() => managedRuntime.dispose()), but finally's callback
    // is typed () => void and dispose() returns Promise<void>, triggering no-misused-promises.
    // .then(dispose, dispose) is equivalent and returns Promise<void> so waitUntil types correctly.
    const dispose = () => managedRuntime.dispose();
    ctx.waitUntil(responsePromise.then(dispose, dispose));
    return responsePromise;
  },
} satisfies ExportedHandler<Env>;
