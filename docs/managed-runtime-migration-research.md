# ManagedRuntime Migration Research

## Is Rebuilding Services Actually Costly?

Before migrating, assess what `make` actually does for each service:

| Service | `make` does | Resources / finalizers |
|---------|-------------|------------------------|
| `D1` | reads `CloudflareEnv`, closes over `d1` binding, builds closure fns | none |
| `KV` | same pattern | none |
| `Repository` | yields `D1`, builds SQL closure fns | none |
| `Shopify` | yields `Repository`, reads 3 env vars, calls `ShopifyApi.shopifyApi(...)` | none |

All services are pure JS object construction — closures over Cloudflare bindings, no I/O, no open connections, no registered finalizers. `ShopifyApi.shopifyApi(...)` validates config and wires up REST/GraphQL client classes — still pure JS.

**The actual per-`runEffect` overhead is: allocate ~5 JS objects + one call to `shopifyApi()`.** No I/O. Likely microseconds.

The "terrible" part is more architectural correctness than a real perf problem.

---

## ManagedRuntime Per-Request Pattern

`ManagedRuntime.dispose()` returns `Promise<void>` directly (line 122 of `ManagedRuntime.ts`), making Cloudflare Workers integration clean.

```ts
// worker.ts
fetch(request, env, ctx) {
  const runtimeLayer = makeRuntimeLayer(env, request)
  const runtime = ManagedRuntime.make(runtimeLayer)

  const runEffect = async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(effect)
    // ... same exit handling as today
  }

  const responsePromise = runEffect(mainEffect)

  // ctx.waitUntil keeps the isolate alive after the response streams out
  ctx.waitUntil(responsePromise.finally(() => runtime.dispose()))

  return responsePromise
}
```

Services build lazily on first `runEffect` call, are cached in the MemoMap for subsequent calls within the same request, and are released (scope closed) after `ctx.waitUntil` resolves.

---

## Disposal: What Actually Happens

From `ManagedRuntime.ts` lines 214-218:

```ts
disposeEffect: Effect.suspend(() => {
  self.contextEffect = Effect.die("ManagedRuntime disposed")
  self.cachedContext = undefined
  return Scope.close(self.scope, Exit.void)
})
```

`Scope.close` runs any finalizers registered by services. Since none of the current services register finalizers, disposal today is a fast no-op (GC-eligible). If a future service adds a finalizer (e.g. closing a WebSocket, flushing a write buffer), `ctx.waitUntil` ensures it runs before the isolate is reclaimed.

---

## The Tricky Parts

### 1. `ctx` is not currently threaded through

`worker.ts` today does not use `ctx` (it's `_ctx`). To call `ctx.waitUntil`, the fetch handler needs to use it. Minor change.

### 2. First `runEffect` call triggers layer build

With `ManagedRuntime`, the layer builds on the first `runtime.runPromiseExit(...)` call, not at construction time. If the first call is a server function (not the outer `runEffect` in `fetch`), the runtime is still warm for all subsequent calls within the request — ordering doesn't matter.

### 3. Per-request services need per-request runtime

`runtimeLayer` includes `CurrentRequest` (per-request) and `CloudflareEnv` (per-request). The runtime must be created fresh per `fetch` call — which it already would be. No per-isolate (module-level) `ManagedRuntime` is possible with the current layer shape.

---

## Alternative: Accept the Current Cost

Given that all `make` effects are pure JS construction with no I/O, the rebuild-per-`runEffect` cost is negligible in practice. The main architectural concern — that services are conceptually "per-request" not "per-pipeline" — still exists but is academic for these particular services.

Worth considering: only migrate if/when a service is added that is genuinely expensive to initialize (e.g. a service that opens a connection or fetches a remote config on startup).

---

## Recommendation

Migrate to `ManagedRuntime` for architectural correctness and future-proofing, using `ctx.waitUntil` for disposal. The migration is small (only `worker.ts` changes significantly) and the disposal pattern is clean. The current cost is not urgent, but the pattern is wrong.

---

## Implementation

Only `worker.ts` changes. Three edits:

**1. Add `ManagedRuntime` import**

```ts
import { Cause, Effect, Layer, Context, ManagedRuntime } from "effect";
```

**2. Refactor `makeRunEffect` to return `{ runEffect, runtime }`**

Rename the layer-building block to a helper, then wire a `ManagedRuntime` instead of `Effect.runPromiseExit(Effect.provide(...))`:

```ts
const makeAppLayer = (env: Env, request: Request) => {
  const envLayer = makeEnvLayer(env);
  const d1Layer = Layer.provideMerge(D1.layer, envLayer);
  const kvLayer = Layer.provideMerge(KV.layer, envLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const requestLayer = Layer.succeedContext(Context.make(CurrentRequest, request));
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

const makeRunEffect = (env: Env, request: Request) => {
  const appLayer = makeAppLayer(env, request);
  const managedRuntime = ManagedRuntime.make(appLayer);
  const runEffect = async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof appLayer>>,
  ): Promise<A> => {
    const exit = await managedRuntime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const squashed = Cause.squash(exit.cause);
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
```

`ServerContext` needs a small type update since `makeRunEffect` now returns an object:

```ts
export interface ServerContext {
  runEffect: ReturnType<typeof makeRunEffect>["runEffect"];
}
```

**3. Use `ctx` to dispose after response**

```ts
export default {
  fetch(request, env, ctx) {
    const { runEffect, managedRuntime } = makeRunEffect(env, request);
    const responsePromise = runEffect(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: async () => serverEntry.fetch(request, { context: { runEffect } }),
          catch: (cause) => cause,
        });
        const shopify = yield* Shopify;
        return yield* shopify.withShopifyDocumentHeaders(request, response);
      }),
    );
    ctx.waitUntil(responsePromise.finally(() => managedRuntime.dispose()));
    return responsePromise;
  },
} satisfies ExportedHandler<Env>;
```

`_ctx` becomes `ctx`. Everything else in the file is unchanged.
