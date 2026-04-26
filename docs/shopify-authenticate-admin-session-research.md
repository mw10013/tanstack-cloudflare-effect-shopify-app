# Shopify Authenticate Admin Session Research

Question: can `src/lib/Shopify.ts` make `authenticateAdmin` return `ShopifyApi.Session | Response` instead of `ShopifyAdminContext | Response`, with minimal `/app` route changes and a cleaner server-function service model?

## Executive Summary

- Yes. This is a reasonable deviation from the Shopify React Router template for this port.
- The current app code only needs the session after admin auth. `src/routes/app.tsx` reads `auth.session.shop`; it can read `session.shop` instead.
- The template returns a rich admin context because React Router loaders/actions directly use `{ admin, session, billing, cors, redirect, scopes }`.
- This port is already Effect-service oriented. Keeping a template-shaped `ShopifyAdminContext` mostly adds indirection.
- Recommended shape: `authenticateAdmin(request): Effect<ShopifyApi.Session | Response, ShopifyError, never>`.
- Rename `CurrentShopifyAdmin` to `CurrentSession`, typed as `ShopifyApi.Session`.
- Add a `ShopifyAdmin` service that depends on `Shopify` and `CurrentSession`, owns `graphql` / `graphqlDecode`, and preserves current 401 token invalidation behavior.
- Make `ProductRepository` depend on `ShopifyAdmin` and call `shopifyAdmin.graphqlDecode(...)`.

## Current Code

`authenticateAdmin` currently returns a context object on success in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L22-L30):

```ts
export interface ShopifyAdminContext {
  readonly session: ShopifyApi.Session;
  readonly graphql: (
    query: string,
    options?: { readonly variables?: Record<string, unknown> },
  ) => Effect.Effect<Awaited<ReturnType<InstanceType<typeof ShopifyApi.GraphqlClient>["request"]>>, ShopifyError>;
}

export type ShopifyAuthenticateAdminResult = ShopifyAdminContext | Response;
```

The `CurrentShopifyAdmin` service stores that entire context in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L34-L36):

```ts
export class CurrentShopifyAdmin extends Context.Service<CurrentShopifyAdmin, ShopifyAdminContext>()(
  "CurrentShopifyAdmin",
) {}
```

`buildAdminContext` only wraps a session plus GraphQL client creation in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L196-L222):

```ts
const buildAdminContext = (session: ShopifyApi.Session): ShopifyAdminContext => ({
  session,
  graphql: Effect.fn("Shopify.graphql")(function* (query, options) {
    const client = new shopify.clients.Graphql({ session });
    const result = yield* Effect.tryPromise({
      try: () => client.request(query, { variables: options?.variables }),
      catch: (cause) => cause,
    }).pipe(...);
    return result;
  }),
});
```

`authenticateAdmin` returns that context for both existing and exchanged sessions in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L537-L573):

```ts
if (
  Option.isSome(existingSession) &&
  existingSession.value.isActive(undefined, WITHIN_MILLISECONDS_OF_EXPIRY)
) {
  return buildAdminContext(existingSession.value);
}

...

yield* storeSession(exchanged.session);
return buildAdminContext(exchanged.session);
```

## `/app` Route Impact

The `/app` route uses the successful auth result only to reach the session shop in [src/routes/app.tsx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/app.tsx#L79-L90):

```ts
const auth = yield* shopify.authenticateAdmin(appRequest);

if (auth instanceof Response) {
  const location = auth.headers.get("Location") ?? auth.headers.get("location");
  if (location) return yield* Effect.fail(redirect({ href: location }));
  return yield* Effect.fail(auth);
}

return {
  apiKey: Redacted.value(shopify.config.apiKey),
  shop: auth.session.shop,
} as const;
```

Minimal change if `authenticateAdmin` returns `Session | Response`:

```ts
const session = yield* shopify.authenticateAdmin(appRequest);

if (session instanceof Response) {
  const location = session.headers.get("Location") ?? session.headers.get("location");
  if (location) return yield* Effect.fail(redirect({ href: location }));
  return yield* Effect.fail(session);
}

return {
  apiKey: Redacted.value(shopify.config.apiKey),
  shop: session.shop,
} as const;
```

`src/routes/auth.$.tsx` already only checks `result instanceof Response`, so no meaningful behavior change is needed there.

## Server Function Middleware Impact

The middleware currently injects `CurrentShopifyAdmin` and exposes `{ admin, session, runEffect }` in [src/lib/ShopifyServerFnMiddleware.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/ShopifyServerFnMiddleware.ts#L38-L56):

```ts
const auth = yield* shopify.authenticateAdmin(request);

if (auth instanceof Response) {
  const location = auth.headers.get("Location") ?? auth.headers.get("location");
  if (location) return yield* Effect.fail(redirect({ href: location }));
  return yield* Effect.fail(auth);
}

const runEffect = <A, E>(effect: Effect.Effect<A, E, ProductRepository | CurrentShopifyAdmin>) =>
  context.runEffect(
    effect.pipe(
      Effect.provide(ProductRepository.layer),
      Effect.provideService(CurrentShopifyAdmin, auth),
    ),
  );

return yield* Effect.tryPromise({
  try: () => next({ context: { admin: auth, session: auth.session, runEffect } }),
  catch: (cause) => cause,
});
```

With session auth, this should become session-first:

```ts
const session = yield* shopify.authenticateAdmin(request);

if (session instanceof Response) {
  const location = session.headers.get("Location") ?? session.headers.get("location");
  if (location) return yield* Effect.fail(redirect({ href: location }));
  return yield* Effect.fail(session);
}

const runEffect = <A, E>(effect: Effect.Effect<A, E, ProductRepository | ShopifyAdmin | CurrentSession>) =>
  context.runEffect(
    effect.pipe(
      Effect.provide(ProductRepository.layer),
      Effect.provide(ShopifyAdmin.layer),
      Effect.provideService(CurrentSession, session),
    ),
  );

return yield* Effect.tryPromise({
  try: () => next({ context: { session, runEffect } }),
  catch: (cause) => cause,
});
```

Whether to keep `context.admin` is a compatibility decision. Current searches show no live handler reads it:

```text
src/routes/app.index.tsx:12  .handler(({ context: { runEffect } }) =>
```

So the smallest internal API is `{ session, runEffect }`. If there is concern about future template parity, keep `admin: undefined` out of the context rather than carrying a misleading context object.

## Proposed Services

### `CurrentSession`

Replace `CurrentShopifyAdmin` with a direct session service:

```ts
export class CurrentSession extends Context.Service<CurrentSession, ShopifyApi.Session>()(
  "CurrentSession",
) {}
```

This name is intentionally generic within `Shopify.ts` because it represents the authenticated Shopify session for the current request, not a Shopify Admin API client.

### `ShopifyAdmin`

Add a service that depends on `Shopify` and `CurrentSession`:

```ts
export class ShopifyAdmin extends Context.Service<ShopifyAdmin>()("ShopifyAdmin", {
  make: Effect.gen(function* () {
    const shopify = yield* Shopify;
    const session = yield* CurrentSession;

    const graphql = Effect.fn("ShopifyAdmin.graphql")(function* (query, options) {
      return yield* shopify.graphql(session, query, options);
    });

    const graphqlDecode = Effect.fn("ShopifyAdmin.graphqlDecode")(function* <A>(
      schema: Schema.Decoder<A>,
      query: string,
      options?: { readonly variables?: Record<string, unknown> },
    ) {
      const { data, errors } = yield* graphql(query, options);
      if (errors) yield* Effect.fail(new ShopifyError({ message: errors.message ?? "Admin GraphQL request failed", cause: errors }));
      return yield* Effect.try({
        try: () => Schema.decodeUnknownSync(schema)(data),
        catch: (cause) => new ShopifyError({ message: "Admin GraphQL response validation failed", cause }),
      });
    });

    return { graphql, graphqlDecode };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
```

The exact implementation can be denser, but the separation is important:

- `Shopify` owns app config, session storage, token exchange, token refresh, document headers, webhook auth, and low-level API client access.
- `CurrentSession` owns per-request authenticated session identity.
- `ShopifyAdmin` owns current-session Admin API operations.
- `ProductRepository` owns product-specific GraphQL documents and domain decoding.

## Where GraphQL Should Live

Move the current `buildAdminContext(...).graphql` behavior into `Shopify` as a session-parameterized helper, then let `ShopifyAdmin` bind it to `CurrentSession`.

Suggested low-level helper on `Shopify`:

```ts
const graphql = Effect.fn("Shopify.graphql")(function* (
  session: ShopifyApi.Session,
  query: string,
  options?: { readonly variables?: Record<string, unknown> },
) {
  const client = new shopify.clients.Graphql({ session });
  const result = yield* Effect.tryPromise({
    try: () => client.request(query, { variables: options?.variables }),
    catch: (cause) => cause,
  }).pipe(
    Effect.tapError((cause) =>
      cause instanceof ShopifyApi.HttpResponseError && cause.response.code === 401
        ? Effect.gen(function* () {
            session.accessToken = undefined;
            yield* Effect.ignore(storeSession(session));
          })
        : Effect.void,
    ),
    Effect.mapError(
      (cause) =>
        new ShopifyError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );
  return result;
});
```

This preserves the existing 401 invalidation path documented in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L182-L195):

```ts
* On 401 from Shopify, clears `session.accessToken` and re-stores the row.
* This does not rescue the current request — the 401 still propagates as
* `ShopifyError` — but it forces the next `authenticateAdmin` browser
* request to see `isActive() === false` and fall through to token exchange
```

`ShopifyAdmin.graphqlDecode` should contain the decode logic currently in `ProductRepository` in [src/lib/ProductRepository.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/ProductRepository.ts#L23-L34):

```ts
const graphqlDecode = Effect.fn("ProductRepository.graphqlDecode")(function* <A>(
  schema: Schema.Decoder<A>,
  query: string,
  options?: { readonly variables?: Record<string, unknown> },
) {
  const { data, errors } = yield* admin.graphql(query, options);
  if (errors) yield* Effect.fail(new ShopifyError({ message: errors.message ?? "Admin GraphQL request failed", cause: errors }));
  return yield* Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(data),
    catch: (cause) => new ShopifyError({ message: "Admin GraphQL response validation failed", cause }),
  });
});
```

Then `ProductRepository` can be product-specific only:

```ts
const admin = yield* ShopifyAdmin;

const result = yield* admin.graphqlDecode(
  ProductCreateResponse,
  `#graphql ...`,
  { variables: { product: { title } } },
);
```

## Template Comparison

The template returns an admin context because its route API exposes many features at once. In [refs/shopify-app-js/.../authenticate/admin/authenticate.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts#L87-L119):

```ts
function createContext(
  request: Request,
  session: Session,
  authStrategy: AuthorizationStrategy,
  sessionToken?: JwtPayload,
): AdminContext<ConfigArg> {
  let context: AdminContextBase = {
    admin: createAdminApiContext(
      session,
      params,
      authStrategy.handleClientError(request),
    ),
    billing: {...},

    session,
    cors: ensureCORSHeadersFactory(params, request),
  };

  context = addEmbeddedFeatures(context, request, session, sessionToken);
  context = addScopesFeatures(context);

  return context as AdminContext<ConfigArg>;
}
```

The admin API context in the template is just GraphQL in [refs/shopify-app-js/.../clients/admin/factory.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/factory.ts#L14-L21):

```ts
export function adminClientFactory({
  params,
  handleClientError,
  session,
}: AdminClientOptions): AdminApiContext {
  return {
    graphql: graphqlClientFactory({params, session, handleClientError}),
  };
}
```

The GraphQL factory creates the client from the session in [refs/shopify-app-js/.../clients/admin/graphql.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/graphql.ts#L16-L29):

```ts
return async function query(operation, options) {
  const client = new params.api.clients.Graphql({
    session,
    apiVersion: options?.apiVersion,
  });

  try {
    const apiResponse = await client.request(operation, {
      variables: options?.variables,
      retries: options?.tries ? options.tries - 1 : 0,
      headers: options?.headers,
      signal: options?.signal,
    });
```

This supports the refactor: the session is the essential dependency. The template context is an adapter layer for its framework API, not a requirement of Shopify Admin API access.

## Implementation Plan

1. In `src/lib/Shopify.ts`, remove `ShopifyAdminContext` and change `ShopifyAuthenticateAdminResult` to `ShopifyApi.Session | Response`.
2. Rename `CurrentShopifyAdmin` to `CurrentSession` and type it as `ShopifyApi.Session`.
3. Replace `buildAdminContext` with a session-parameterized `graphql(session, query, options)` helper on `Shopify`.
4. Change `authenticateAdmin` success returns from `buildAdminContext(session)` to `session`.
5. Add `ShopifyAdmin` service with `graphql` and `graphqlDecode`, depending on `Shopify` and `CurrentSession`.
6. Update `src/lib/ProductRepository.ts` to depend on `ShopifyAdmin`, delete local `graphqlDecode`, and call `admin.graphqlDecode`.
7. Update `src/lib/ShopifyServerFnMiddleware.ts` to provide `CurrentSession`, provide `ShopifyAdmin.layer`, and expose `session` in middleware context.
8. Update `src/routes/app.tsx` to use `session.shop` instead of `auth.session.shop`.
9. Update `src/routes/auth.$.tsx` variable names only if desired.
10. Run `pnpm typecheck` and `pnpm lint`.

## Risks And Decisions

- 401 invalidation must remain in the low-level GraphQL helper so all Admin API callers share the behavior.
- `ProductRepository.layer` will depend on `ShopifyAdmin.layer`; middleware must provide both layers in the right order.
- Returning raw `Session` means losing template-shaped `context.admin`; current code does not use it.
- Keep `unauthenticatedAdmin(shop)` returning a session. A future background-job admin service can provide `CurrentSession` from that returned session and reuse `ShopifyAdmin`.
- Avoid adding backward compatibility unless needed. There are no current call sites requiring `ShopifyAdminContext`.

## Recommendation

Proceed with the session-returning auth refactor.

The final target flow is simpler:

```text
authenticateAdmin(request)
  -> Session | Response
middleware
  -> provide CurrentSession(session)
  -> provide ShopifyAdmin.layer
ProductRepository
  -> ShopifyAdmin.graphqlDecode(schema, query, options)
ShopifyAdmin
  -> Shopify.graphql(session, query, options)
```

This keeps auth, current request state, Admin API operations, and product domain operations separated without carrying the template's broader admin context surface.
