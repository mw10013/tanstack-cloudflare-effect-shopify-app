# Effect ManagedRuntime Dynamic Service Research

Question: Effect v4 `ManagedRuntime` already has a context built from services and layers. Later, the app needs to add another service. What are the supported ways to do that?

## Executive Summary

- `ManagedRuntime` does not expose a public API to mutate or append to its context after construction.
- `ManagedRuntime.make(layer)` builds and caches the layer context lazily, then runs effects with that cached context.
- For a truly new runtime-wide service, create a new `ManagedRuntime` from a merged layer, optionally sharing the old runtime's `memoMap` so existing layer builds are reused.
- For per-request or per-run dynamic data, prefer `Effect.provideService`, `Effect.provideContext`, or `Effect.provide(...layer, { local: true })` around the effect passed to `runtime.runPromise`.
- If you need to manually combine a runtime context with an extra service, use `runtime.context()` plus `Context.add(...)`, then run with `Effect.runPromiseWith(context)(effect)` rather than pretending the original runtime was mutated.
- For this Shopify app, request/auth/session-scoped dependencies should not be added to the global runtime. They should be provided around the specific request effect, or modeled as mutable service state inside an already-runtime-provided service.

## Key Implementation Facts

`ManagedRuntime` is constructed from one layer and exposes context access, run methods, and disposal. It has no `add`, `provide`, `extend`, or `setContext` method in [refs/effect4/packages/effect/src/ManagedRuntime.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/src/ManagedRuntime.ts#L45-L128):

```ts
export interface ManagedRuntime<in R, out ER> {
  readonly memoMap: Layer.MemoMap
  readonly contextEffect: Effect.Effect<Context.Context<R>, ER>
  readonly context: () => Promise<Context.Context<R>>
  cachedContext: Context.Context<R> | undefined
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Promise<A>
  readonly dispose: () => Promise<void>
}
```

`ManagedRuntime.make` captures the original `layer`, builds it through `Layer.buildWithMemoMap`, and caches the resulting context in [refs/effect4/packages/effect/src/ManagedRuntime.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/src/ManagedRuntime.ts#L160-L199):

```ts
export const make = <R, ER>(
  layer: Layer.Layer<R, ER, never>,
  options?: { readonly memoMap?: Layer.MemoMap | undefined } | undefined
): ManagedRuntime<R, ER> => {
  const memoMap = options?.memoMap ?? Layer.makeMemoMapUnsafe()
  ...
  const contextEffect = Effect.withFiber<Context.Context<R>, ER>((fiber) => {
    if (!buildFiber) {
      buildFiber = Effect.runFork(
        Effect.tap(
          Layer.buildWithMemoMap(layer, memoMap, layerScope),
          (context) => Effect.sync(() => { self.cachedContext = context })
        ),
        { ...defaultRunOptions, scheduler: fiber.currentScheduler }
      )
    }
    return Effect.flatten(Fiber.await(buildFiber))
  })
```

Once cached, run methods use that exact context. Before caching, they provide `contextEffect`; after caching, they call `Effect.runPromiseWith(self.cachedContext)` in [refs/effect4/packages/effect/src/ManagedRuntime.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/src/ManagedRuntime.ts#L249-L254):

```ts
runPromise<A, E>(effect: Effect.Effect<A, E, R>, options?: { readonly signal?: AbortSignal | undefined }): Promise<A> {
  return self.cachedContext === undefined ?
    Effect.runPromise(provide(self, effect), mergeRunOptions(options)) :
    Effect.runPromiseWith(self.cachedContext)(effect, mergeRunOptions(options))
}
```

## Option 1: Build A New Runtime From A Merged Layer

Use this when the new service should be runtime-wide and lifecycle-managed.

Effect layers can be merged. `Layer.mergeAll` combines services in [refs/effect4/packages/effect/src/Layer.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/src/Layer.ts#L969-L981):

```ts
const mergedLayer = Layer.mergeAll(dbLayer, loggerLayer)
```

`ManagedRuntime` supports sharing the memo map. The test in [refs/effect4/packages/effect/test/ManagedRuntime.test.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/test/ManagedRuntime.test.ts#L27-L39) shows two runtimes can reuse layer memoization:

```ts
const runtimeA = ManagedRuntime.make(layer)
const runtimeB = ManagedRuntime.make(layer, { memoMap: runtimeA.memoMap })
```

Pattern:

```ts
const baseRuntime = ManagedRuntime.make(BaseLayer)

const extendedRuntime = ManagedRuntime.make(
  Layer.mergeAll(BaseLayer, DynamicService.layer),
  { memoMap: baseRuntime.memoMap }
)
```

Tradeoffs:

- Best for app-level dependencies.
- Preserves layer lifecycle semantics for the added service.
- Does not mutate the old runtime; callers must use the new runtime.
- If the old runtime is no longer needed, dispose it when safe.

## Option 2: Provide A Service Around One Run

Use this for request/session/user-specific data.

`Effect.provideService` is documented as providing an implementation for a service in [refs/effect4/packages/effect/src/Effect.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/src/Effect.ts#L5887-L5948):

```ts
const program = Effect.provideService(fetchData, Config, {
  apiUrl: "https://api.example.com",
  timeout: 5000
})
```

Pattern:

```ts
await runtime.runPromise(
  program.pipe(
    Effect.provideService(RequestSession, session)
  )
)
```

Tradeoffs:

- Minimal and type-safe for one request/effect.
- Does not affect other concurrent requests.
- Not lifecycle-managed like a `Layer.scoped`; use a layer if acquisition/release matters.

## Option 3: Provide A Dynamic Layer Around One Run

Use this when the dynamic service needs effectful construction or scoped cleanup.

`Effect.provide` accepts layers and has a `local` option. The docs say in [refs/effect4/packages/effect/src/Effect.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/src/Effect.ts#L5607-L5610):

```ts
Provides dependencies to an effect using layers or a context. Use `options.local`
to build the layer every time; by default, layers are shared between provide
calls.
```

Pattern:

```ts
await runtime.runPromise(
  program.pipe(
    Effect.provide(makeRequestLayer(request), { local: true })
  )
)
```

Tradeoffs:

- Good when constructing the service is effectful.
- Good when scoped resources must be acquired/released per request.
- `local: true` matters if each run must build a fresh instance.

## Option 4: Build An Extended Context And Run With It

Use this when non-Effect edge code has a runtime, needs a one-off combined context, and does not need `ManagedRuntime` lifecycle for the extra service.

`Context.add` adds a service to a context in [refs/effect4/packages/effect/src/Context.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/src/Context.ts#L510-L551):

```ts
const context = pipe(
  someContext,
  Context.add(Timeout, { TIMEOUT: 5000 })
)
```

`Effect.runPromiseWith` runs an effect with an explicit context in [refs/effect4/packages/effect/src/Effect.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/packages/effect/src/Effect.ts#L8484-L8514):

```ts
Effect.runPromiseWith(context)(program).then(console.log)
```

Pattern:

```ts
const baseContext = await runtime.context()
const context = Context.add(baseContext, RequestSession, session)

await Effect.runPromiseWith(context)(program)
```

Tradeoffs:

- Explicitly models “base runtime context plus one extra service”.
- Bypasses `runtime.runPromise`, so you do not get `ManagedRuntime` run options/fiber tracking behavior from its methods.
- Better as a local adapter than a project-wide default.

## Option 5: Put Mutable Dynamic State Inside An Existing Service

Use this when the runtime should contain a stable service, but that service’s current value changes over time.

This app already does this in `Shopify`: the runtime-provided `Shopify` service owns refs/state and methods. Around the selected area in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L193-L218), `buildAdminContext(session)` creates a GraphQL function over a dynamic `session`:

```ts
const buildAdminContext = (session: ShopifyApi.Session): ShopifyAdminContext => ({
  session,
  graphql: Effect.fn("Shopify.graphql")(function* (query, options) {
    const client = new shopify.clients.Graphql({ session });
    const result = yield* Effect.tryPromise({
      try: () => client.request(query, { variables: options?.variables }),
      catch: (cause) => cause,
    })
    return result;
  }),
});
```

Tradeoffs:

- Good when the service is conceptually stable and only its internal state changes.
- Avoids runtime/context mutation entirely.
- Be careful with request-scoped refs in a shared runtime: concurrent requests can overwrite each other if the ref stores “current request” globally.

## Recommendation For This App

- Do not mutate `ManagedRuntime`; there is no public API for it.
- If the “another Service” is request/session-specific, pass it via `Effect.provideService` or `Effect.provide(makeLayer(...), { local: true })` around `runEffect`/`runtime.runPromise`.
- If it is app-wide and long-lived, create a new runtime from `Layer.mergeAll(AppLayer, NewService.layer)` and share `memoMap` if you need to avoid rebuilding existing layers.
- If this is specifically about Shopify Admin GraphQL/session, avoid a global “current session” service in a shared runtime. Provide the session per request or have GraphQL APIs take/use the authenticated session directly.
