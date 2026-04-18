# Effect v4 backend research

## Thesis

For this repo, “use Effect v4 fully on the backend” should mean:

- keep TanStack Start as the route/SSR framework
- keep Cloudflare Workers as the runtime boundary
- push server-side business logic into `Effect.Effect` programs behind thin route/server-fn/webhook adapters
- model backend capabilities as `Context.Service` + `Layer`
- treat env, request, D1, KV, Shopify auth/admin, validation, logging, retries, and domain errors as Effect concerns

It should not mean “replace TanStack Start with Effect HttpApi right now”.

Grounding from Effect docs:

> “`ManagedRuntime` bridges Effect programs with non-Effect code. Build one runtime from your application Layer, then use it anywhere you need imperative execution, like web handlers, framework hooks, worker queues, or legacy callback APIs.”

Source: `refs/effect4/ai-docs/src/03_integration/index.md:1-5`

> “Use `ManagedRuntime` to run Effect programs from external frameworks while keeping your domain logic in services and Layers.”

Source: `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts:1-5`

That framing matches TanStack Start server functions and Workers fetch/webhook handlers well. The transport stays imperative. The domain moves into Effect.

## What Effect v4 is pushing us toward

Core guidance from the docs:

> “Prefer writing Effect code with `Effect.gen` & `Effect.fn("name")`.”

Source: `refs/effect4/ai-docs/src/01_effect/01_basics/index.md:1-5`

> “When writing functions that return an Effect, use `Effect.fn` … Avoid creating functions that return an `Effect.gen`, use `Effect.fn` instead.”

Source: `refs/effect4/ai-docs/src/01_effect/01_basics/02_effect-fn.ts:1-39`

The backend shape implied by the docs is:

- use `Context.Service` to model capabilities
- use `Layer.effect` to build implementations and wire dependencies
- use `Config` / `ConfigProvider` for runtime config
- use `Schema.TaggedErrorClass` for typed domain/infrastructure failures
- use `Schema.decodeUnknownEffect` at IO boundaries
- use `Logger.layer`, `References.MinimumLogLevel`, `Effect.annotateLogs`, and log spans for observability

Grounding from logging docs:

> “Configure loggers & log-level filtering for production applications.”

Source: `refs/effect4/ai-docs/src/08_observability/10_logging.ts:1-13`

## Current repo state

The repo already has a real Effect foothold on the server.

### Already aligned

- `src/worker.ts` builds a request-scoped runtime from env, D1, KV, request, and logging, then exposes `runEffect` to TanStack Start request context.
- `src/lib/CloudflareEnv.ts` and `src/lib/Request.ts` already model env/request as Effect services.
- `src/lib/D1.ts` and `src/lib/KV.ts` already wrap Cloudflare bindings in `Context.Service` layers, use `Effect.tryPromise`, define tagged errors, and add retry policy.
- `src/lib/LayerEx.ts` already injects `ConfigProvider.fromUnknown(env)`, which makes Effect config access viable everywhere in the runtime.

Important current excerpt:

```ts
const runtimeLayer = Layer.mergeAll(
  d1Layer,
  kvLayer,
  requestLayer,
  makeLoggerLayer(env),
)

const exit = await Effect.runPromiseExit(
  Effect.provide(effect, runtimeLayer),
)
```

Source: `src/worker.ts:43-60`

Important D1 excerpt:

```ts
export class D1 extends Context.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    const { D1: d1 } = yield* CloudflareEnv
```

```ts
export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}
```

Source: `src/lib/D1.ts:5-17`, `src/lib/D1.ts:57-79`

### Still imperative / not fully Effect-native

Most Shopify-specific backend logic is still outside the Effect model.

- `src/lib/Shopify.ts` pulls config from `process.env`, caches it in module state, uses `async` / `await`, and talks to D1 directly with `env.D1.prepare(...)`.
- `src/routes/app.tsx` route auth is an imperative `createServerFn` handler calling `authenticateAdmin({ request, env })`.
- `src/routes/app.index.tsx` product generation is an imperative server fn with thrown `Error` values and raw GraphQL response parsing.
- `src/routes/webhooks.app.uninstalled.ts` and `src/routes/webhooks.app.scopes_update.ts` are still plain async handlers.

Representative current excerpt:

```ts
const getRequiredEnv = (name: string) => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}
```

```ts
await this.env.D1.prepare(
  "select payload from ShopifySession where id = ?1",
)
```

Source: `src/lib/Shopify.ts:19-25`, `src/lib/Shopify.ts:117-123`

Representative route excerpt:

```ts
.handler(async ({ data, context }) => {
  const config = getShopifyAppConfig()
  const request = new Request(`${config.appUrl}${data.pathname}${data.searchStr}`)
  const result = await authenticateAdmin({ request, env: context.env })
```

Source: `src/routes/app.tsx:42-71`

## Best pattern from `refs/tces`

`refs/tces` shows the closest match to the architecture we want.

### 1. Build the backend runtime in `worker.ts`

`refs/tces/src/worker.ts` composes env + infra + domain services into the Worker runtime, then hands a `runEffect` bridge to TanStack Start.

Key excerpt:

```ts
const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer)
const stripeLayer = Layer.provideMerge(
  Stripe.layer,
  Layer.merge(repositoryLayer, d1KvLayer),
)
const authLayer = Layer.provideMerge(Auth.layer, stripeLayer)
```

```ts
return async <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(effect, runtimeLayer),
  )
```

Source: `refs/tces/src/worker.ts:58-95`

This is the same bridge pattern Effect recommends with `ManagedRuntime`, just expressed as a per-request runtime because Workers request/env are request-scoped.

### 2. Put route guards and server functions inside `runEffect`

`refs/tces/src/routes/app.tsx` uses a thin `createServerFn` wrapper and keeps the real logic inside `Effect.gen`.

```ts
const beforeLoadServerFn = createServerFn().handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request
        const auth = yield* Auth
        const session = yield* auth.getSession(request.headers)
```

Source: `refs/tces/src/routes/app.tsx:9-23`

It also uses `Effect.die(redirect(...))` so TanStack control flow still works from inside Effect.

### 3. Wrap third-party SDKs in services, not in routes

`refs/tces/src/lib/Auth.ts` is the best local pattern for integrating an imperative SDK without abandoning Effect.

- config is pulled through `Config.all(...)`
- runtime services are captured with `Effect.context(...)`
- promise APIs are wrapped with `Effect.tryPromise`
- session output is validated with `Schema.decodeUnknownEffect`

Key excerpt:

```ts
const services = yield* Effect.context<KV | Stripe | Repository | Env>()
const runEffect = Effect.runPromiseWith(services)
const authConfig = yield* Config.all({
  betterAuthUrl: Config.nonEmptyString("BETTER_AUTH_URL"),
```

```ts
const result = yield* Effect.tryPromise(() =>
  auth.api.getSession({ headers }),
)
const user = yield* Schema.decodeUnknownEffect(Schema.toType(Domain.User))(
  result.user,
)
```

Source: `refs/tces/src/lib/Auth.ts:28-50`, `refs/tces/src/lib/Auth.ts:70-84`

That is the exact pattern this repo should apply to Shopify.

## Recommended target architecture for this repo

### Keep

- TanStack Start route modules
- TanStack `createServerFn`
- Workers `fetch` / route handlers / webhooks as outer adapters
- Shopify SDK as the underlying integration library

### Change

Move Shopify backend logic behind Effect services.

Recommended service split:

- `ShopifyConfig` or equivalent config module backed by `Config`
- `ShopifySessionStore` backed by the existing `D1` Effect service
- `Shopify` service for auth/session-token/admin-client flows
- optional small `ShopifyWebhook` helpers if webhook validation/update logic grows

Recommended responsibilities:

- `CloudflareEnv` remains the raw bindings service
- `LayerEx.makeEnvLayer` remains the config bridge
- `D1` stays the infra boundary for SQL execution + retries
- `ShopifySessionStore` handles `ShopifySession` persistence/parsing
- `Shopify` handles `shopifyApi(...)`, token exchange, bounce/exit iframe responses, admin GraphQL client creation, and session refresh
- routes only orchestrate request/response shape and UI-specific redirect handling

### Shape of the runtime

The current repo already has the correct outer shell. The main change is to extend the runtime in `src/worker.ts` with Shopify-related layers, the way `refs/tces` extends it with `Repository`, `Stripe`, and `Auth`.

Desired direction:

```ts
const envLayer = makeEnvLayer(env)
const d1Layer = Layer.provideMerge(D1.layer, envLayer)
const requestLayer = Layer.succeedContext(Context.make(AppRequest, request))
const shopifyLayer = Layer.provideMerge(Shopify.layer, Layer.merge(d1Layer, requestLayer))
const runtimeLayer = Layer.mergeAll(d1Layer, requestLayer, shopifyLayer, makeLoggerLayer(env))
```

Not exact code. Target shape.

### Shape of route/server-fn usage

Current imperative style:

- `async ({ context }) => authenticateAdmin({ request: context.request, env: context.env })`

Target style:

- `({ context: { runEffect } }) => runEffect(Effect.gen(function* () { const shopify = yield* Shopify; ... }))`

That lets route guards, mutations, and webhooks all share the same:

- request access via `Request`
- config access via `Config`
- database access via `D1`
- logging/tracing via logger layers
- typed errors and decoding

## Concrete migration recommendations

### 1. Refactor `src/lib/Shopify.ts` into Effect-backed services

Main gaps to remove:

- `process.env` reads
- module-global config cache
- direct `env.D1.prepare(...)`
- raw `JSON.parse` with ad hoc shape checks
- `async` / `await` at the core service layer

Target replacements:

- `Config.nonEmptyString("SHOPIFY_API_KEY")`
- `Config.nonEmptyString("SHOPIFY_API_SECRET")`
- `Config.string("SHOPIFY_APP_URL").pipe(...)` or similar derived config
- `Effect.tryPromise` around Shopify SDK calls
- `D1` service for persistence
- `Schema.decodeUnknownEffect` for webhook payloads / stored payload parsing where practical
- `Schema.TaggedErrorClass` for Shopify/session failures

### 2. Convert `/app` auth and product mutation to `runEffect`

Best first migrations:

- `src/routes/app.tsx`
- `src/routes/app.index.tsx`

Reason:

- these are the highest-value server-side Shopify paths
- they currently bypass the runtime already built in `src/worker.ts`
- `refs/tces` gives a direct route/server-fn pattern to copy

### 3. Convert webhook routes next

Best next targets:

- `src/routes/webhooks.app.uninstalled.ts`
- `src/routes/webhooks.app.scopes_update.ts`

These are clean backend-only boundaries and should become thin handlers around Effect programs.

Good target shape:

- validate webhook via `Effect.tryPromise`
- decode payload via `Schema.decodeUnknownEffect`
- update/delete session data via `ShopifySessionStore` / `D1`
- log structured metadata around shop, topic, and result

### 4. Keep the TanStack/Effect control-flow bridge already in `src/worker.ts`

This is good and should stay.

Why:

- it already handles `redirect` / `notFound` defects correctly
- it normalizes Effect failures into serializable `Error` instances for TanStack Start
- it matches the same bridge pattern used in `refs/tces`

This means the repo does not need a transport rewrite to become “fully Effect” on the backend.

## What “fully Effect on the backend” should mean here

Practical definition for this repo:

- all server-side business logic is authored as Effect programs
- all backend dependencies are accessed as services from the environment
- all runtime config flows through `Config`
- all external promises are wrapped at the boundary with `Effect.tryPromise`
- all database access goes through Effect services
- all validation/decoding happens at boundaries with `Schema`
- all logging/retries/error typing happen inside the Effect runtime
- TanStack route modules remain thin adapters

That is enough to count as a full Effect backend for this stack.

It does not require:

- replacing TanStack Start with Effect HttpApi
- rewriting client-side React code into Effect
- removing every imperative third-party SDK; instead, wrap those SDKs behind Effect services

## Suggested rollout order

1. Introduce an Effect-backed Shopify service layer.
2. Extend `src/worker.ts` runtime with that layer.
3. Migrate `/app` route auth and product mutation.
4. Migrate webhook handlers.
5. Migrate any remaining backend helpers that still depend on `process.env`, raw D1, or thrown ad hoc errors.

## Bottom line

This repo is already partway there.

- The Worker runtime bridge exists.
- D1/KV/env/request already have Effect shape.
- The missing piece is Shopify and server-route orchestration.

The cleanest path is to copy the `refs/tces` pattern, not to invent a new one:

- compose services in `worker.ts`
- expose `runEffect`
- keep TanStack Start as the HTTP shell
- move Shopify/auth/webhook/database workflows into Effect services and `Effect.gen` programs

## Sources

- `refs/effect4/ai-docs/src/01_effect/01_basics/index.md`
- `refs/effect4/ai-docs/src/01_effect/01_basics/02_effect-fn.ts`
- `refs/effect4/ai-docs/src/03_integration/index.md`
- `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts`
- `refs/effect4/ai-docs/src/08_observability/10_logging.ts`
- `refs/tces/src/worker.ts`
- `refs/tces/src/routes/app.tsx`
- `refs/tces/src/lib/Auth.ts`
- `src/worker.ts`
- `src/lib/D1.ts`
- `src/lib/KV.ts`
- `src/lib/LayerEx.ts`
- `src/lib/Shopify.ts`
- `src/routes/app.tsx`
- `src/routes/app.index.tsx`
- `src/routes/webhooks.app.uninstalled.ts`
- `src/routes/webhooks.app.scopes_update.ts`
