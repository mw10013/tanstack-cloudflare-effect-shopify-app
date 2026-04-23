# Effect v4 Layer MemoMap Lifecycle Research

## Core Question

When `runEffect` (i.e. `Effect.runPromiseExit(Effect.provide(effect, runtimeLayer))`) is called twice in a row, does it rebuild services from scratch both times?

**Answer: Yes. Every `runPromiseExit` call builds the layer graph from scratch.**

---

## How It Works

### MemoMap is fiber-context-local

`CurrentMemoMap` is a `Context.Service` (a key in a `Context.Context`) stored on the root fiber:

```ts
// refs/effect4/packages/effect/src/Layer.ts, lines 420-425
export class CurrentMemoMap extends Context.Service<CurrentMemoMap, MemoMap>()("effect/Layer/CurrentMemoMap") {
  static getOrCreate: <Services>(self: Context.Context<Services>) => MemoMap = Context.getOrElse(
    this,
    makeMemoMapUnsafe
  )
}
```

`buildWithScope` reads it from the running fiber:

```ts
// refs/effect4/packages/effect/src/Layer.ts, lines 576-589
export const buildWithScope = dual(2, (self, scope) =>
  core.withFiber((fiber) =>
    buildWithMemoMap(self, CurrentMemoMap.getOrCreate(fiber.context), scope)
  ))
```

### Each `runPromiseExit` starts with an empty fiber context

```ts
// refs/effect4/packages/effect/src/internal/effect.ts, line 5206
runForkWith(Context.empty())
```

The root fiber's context is `Context.empty()` — no `CurrentMemoMap`. So `getOrCreate` always calls `makeMemoMapUnsafe()`, producing a **fresh MemoMap** for every `runPromiseExit` call.

### Consequence

```ts
// runtimeLayer is the same JS object both times — doesn't matter
await Effect.runPromiseExit(Effect.provide(effectA, runtimeLayer))  // builds all services fresh
await Effect.runPromiseExit(Effect.provide(effectB, runtimeLayer))  // builds all services fresh again
```

`Shopify.make`, `Repository.make`, etc. run on every call. A `let` variable inside `make` resets to its initial value each time.

---

## Within a Single `runPromiseExit`: Layers Are Deduplicated

Inside one `runPromiseExit`, the same `MemoMap` is threaded through the entire layer graph. A layer that appears multiple times (e.g. `d1Layer` as both a direct member and a transitive dependency of `repositoryLayer`) is built **exactly once**:

```ts
// refs/effect4/packages/effect/src/Layer.ts, MemoMapImpl.getOrElseMemoize
getOrElseMemoize(layer, scope, build) {
  if (this.map.has(layer)) {
    const entry = this.map.get(layer)!
    entry.observers++
    return /* cached effect */
  }
  // ... build and store
}
```

So in `worker.ts`, the `runtimeLayer` with overlapping deps (`d1Layer` appears as both a direct entry and a dep of `repositoryLayer`/`shopifyLayer`) still only calls `D1.make` once per `runPromiseExit`.

---

## How `makeRunEffect` in `worker.ts` Actually Works

```ts
const makeRunEffect = (env: Env, request: Request) => {
  // runtimeLayer is constructed ONCE as a description (no services built yet)
  const runtimeLayer = Layer.mergeAll(d1Layer, kvLayer, repositoryLayer, shopifyLayer, ...)

  // This returned fn can be called many times
  return async (effect) => {
    // Each call: fresh root fiber → fresh MemoMap → all services rebuilt
    const exit = await Effect.runPromiseExit(Effect.provide(effect, runtimeLayer))
    // ...
  }
}
```

`makeRunEffect` is called once per Cloudflare `fetch`. The returned `runEffect` is passed as `context.runEffect` to TanStack Start and used by every server function in that request. **Each server function call that invokes `context.runEffect(someEffect)` rebuilds all services from scratch.**

---

## To Share Services Across Runs: Use `ManagedRuntime`

`ManagedRuntime` owns a long-lived MemoMap and scope:

```ts
// refs/effect4/packages/effect/src/ManagedRuntime.ts, line 166
const memoMap = options?.memoMap ?? Layer.makeMemoMapUnsafe()
```

Every call to `runtime.runPromise(...)` reuses the same `memoMap`, so `make` runs only on the first call and the built services are cached until `runtime.dispose()`.

---

## Implication for Shopify GraphQL Design

A `let` variable (or `Ref`) inside `Shopify.make` is scoped to **one `runEffect` call**. `authenticateAdmin` and any subsequent `graphql` calls must be in the **same Effect pipeline** passed to one `runEffect`. If they're in separate server function invocations (separate `runEffect` calls), the variable resets and graphql would fail.

In practice this is fine: a server function that needs GraphQL calls `authenticateAdmin` and then runs queries in the same pipeline.
