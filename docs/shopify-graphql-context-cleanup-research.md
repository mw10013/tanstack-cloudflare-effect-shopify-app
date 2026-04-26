# Shopify GraphQL Context Cleanup Research

Question: `src/lib/Shopify.ts` currently has `buildAdminContext`, `ShopifyAdminContext.graphql`, `adminContextRef`, and `graphqlDecode`. Do we really need the admin context GraphQL wrapper, or is this following `refs/shopify-app-template` too closely?

## Executive Summary

- The live app does not call `admin.graphql(...)` directly anywhere.
- The intended project API is already `shopify.graphqlDecode(...)`; `ProductRepository` uses only that API.
- `buildAdminContext` exists mainly to mimic Shopify App JS / template shape, where `authenticate.admin(request)` returns a context with `admin.graphql`, `billing`, `scopes`, `redirect`, `cors`, and `session`.
- In this TanStack + Effect port, that shape is mostly unnecessary and makes the data flow circuitous: auth sets a ref to an object, `graphqlDecode` reads the ref, then calls a function on that object.
- Recommended cleanup: store the authenticated `Session` in a ref, not an admin context. Make `graphqlDecode` construct `new shopify.clients.Graphql({ session })` directly.
- Keep a small session-returning auth result for route/middleware needs: `{ session } | Response` is enough for current code.
- The requestless/background case is real, but it is an offline access-token use case, not a reason to keep a template-shaped `admin.graphql` context. Expose it explicitly, for example `graphqlDecodeForShop(shop, schema, query, options)`.

## Current Usage In This Codebase

Search results for `graphqlDecode`, `.graphql(`, `adminContextRef`, and `buildAdminContext` show the only live GraphQL call path:

```text
src/lib/ProductRepository.ts:26  shopify.graphqlDecode(...)
src/lib/ProductRepository.ts:60  shopify.graphqlDecode(...)
src/lib/Shopify.ts:622          admin.graphql(query, options)
```

`ProductRepository` uses `graphqlDecode` directly in [src/lib/ProductRepository.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/ProductRepository.ts#L24-L76):

```ts
const createProduct = Effect.fn("ProductRepository.createProduct")(
  function* (title: Domain.Product["title"]) {
    const result = yield* shopify.graphqlDecode(
      ProductCreateResponse,
      `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
      { variables: { product: { title } } },
    );
    return result.productCreate?.product;
  },
);
```

The route action that reaches `ProductRepository` is behind auth middleware in [src/routes/app.index.tsx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/app.index.tsx#L10-L25):

```ts
const generateProduct = createServerFn({ method: "POST" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const products = yield* ProductRepository;
        const product = yield* products.createProduct(`${color} Snowboard`);
        const variant = yield* products.updateVariantsBulk(product.id, [{ id: variantId, price: "100.00" }]);
        return { product, variant };
      }),
    ),
  );
```

The middleware authenticates first in [src/lib/ShopifyServerFnMiddleware.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/ShopifyServerFnMiddleware.ts#L31-L48):

```ts
const auth = yield* shopify.authenticateAdmin(request);

if (auth instanceof Response) {
  const location = auth.headers.get("Location") ?? auth.headers.get("location");
  if (location) return yield* Effect.fail(redirect({ href: location }));
  return yield* Effect.fail(auth);
}

return yield* Effect.tryPromise({
  try: () => next({ context: { admin: auth, session: auth.session } }),
  catch: (cause) => cause,
});
```

But no handler reads `context.admin`. The handler immediately enters `runEffect` and obtains `ProductRepository`, which obtains `Shopify` and calls `graphqlDecode`.

## Current Circuitous Flow

`Shopify` currently stores an entire admin context in a ref in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L136-L136):

```ts
const adminContextRef = yield* Ref.make<Option.Option<ShopifyAdminContext>>(Option.none());
```

`authenticateAdmin` populates it in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L530-L570):

```ts
if (
  Option.isSome(existingSession) &&
  existingSession.value.isActive(undefined, WITHIN_MILLISECONDS_OF_EXPIRY)
) {
  const ctx = buildAdminContext(existingSession.value);
  yield* Ref.set(adminContextRef, Option.some(ctx));
  return ctx;
}

...

yield* storeSession(exchanged.session);
const ctx = buildAdminContext(exchanged.session);
yield* Ref.set(adminContextRef, Option.some(ctx));
return ctx;
```

`graphqlDecode` reads the context and calls through to `admin.graphql` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L613-L628):

```ts
const admin = yield* Ref.get(adminContextRef).pipe(
  Effect.flatMap(Effect.fromOption),
  Effect.mapError(() => new ShopifyError({ message: "authenticateAdmin must be called before graphqlDecode", cause: undefined })),
);
const { data, errors } = yield* admin.graphql(query, options);
if (errors) yield* Effect.fail(new ShopifyError({ message: errors.message ?? "Admin GraphQL request failed", cause: errors }));
return yield* Effect.try({
  try: () => Schema.decodeUnknownSync(schema)(data),
  catch: (cause) => new ShopifyError({ message: "Admin GraphQL response validation failed", cause }),
});
```

`buildAdminContext` mostly exists to hold that single function in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L193-L219):

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

That means the current effective flow is:

```text
authenticateAdmin(request)
  -> buildAdminContext(session)
  -> Ref<ShopifyAdminContext>.set(ctx)
ProductRepository
  -> shopify.graphqlDecode(schema, query, options)
  -> Ref<ShopifyAdminContext>.get()
  -> ctx.graphql(query, options)
  -> new shopify.clients.Graphql({ session }).request(...)
  -> decode response
```

For this app, the middle object is unnecessary. The session is the actual state needed to create the Shopify GraphQL client.

## Why The Template Has An Admin Context

The template uses Shopify App JS React Router, where `authenticate.admin(request)` returns a rich route/action context. In [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts#L87-L143):

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
    billing: {
      require: requireBillingFactory(params, request, session),
      check: checkBillingFactory(params, request, session),
      request: requestBillingFactory(params, request, session),
      cancel: cancelBillingFactory(params, request, session),
      createUsageRecord: createUsageRecordFactory(params, request, session),
      updateUsageCappedAmount: updateUsageCappedAmountFactory(
        params,
        request,
        session,
      ),
    },

    session,
    cors: ensureCORSHeadersFactory(params, request),
  };

  context = addEmbeddedFeatures(context, request, session, sessionToken);
  context = addScopesFeatures(context);

  return context as AdminContext<ConfigArg>;
}
```

That context makes sense in React Router because route loaders/actions destructure `{ admin, session, billing, cors, redirect, scopes }` from `authenticate.admin(request)`. This port has not adopted that surface. Its app code uses an Effect service API instead: `Shopify.graphqlDecode`.

The template's `admin.graphql` implementation simply creates a Shopify API GraphQL client around the session in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/graphql.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/graphql.ts#L11-L39):

```ts
export function graphqlClientFactory({
  params,
  handleClientError,
  session,
}: AdminClientOptions): GraphQLClient<AdminOperations> {
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

      return new Response(JSON.stringify(apiResponse));
    } catch (error) {
      if (handleClientError) {
        throw await handleClientError({error, params, session});
      }

      throw error;
    }
  };
}
```

For this port, that client construction can happen directly inside `graphqlDecode`.

## Request-Bound vs Offline/Batch GraphQL

There are two valid GraphQL modes, but the current `buildAdminContext` hides the difference.

Request-bound GraphQL:
: A browser/server-function request first calls `authenticateAdmin(request)`, which validates a Shopify session token and establishes the current shop session for the request. Current app path: `shopifyServerFnMiddleware` -> `ProductRepository` -> `shopify.graphqlDecode(...)`.

Offline/batch GraphQL:
: A queue, cron, workflow, webhook handler, or maintenance job has no browser request. It should load the stored offline session by shop, refresh it if needed, and then create the Admin GraphQL client. This maps to Shopify's offline access-token model.

Shopify docs say in [refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md#L13-L27):

> "Tokens with offline access mode are meant for service-to-service requests where no user interaction is involved. Offline access mode is ideal for background work in response to webhooks, or for maintenance work in backgrounded jobs."

> "Apps can continue performing background operations without user interaction"

> "Token refresh: Apps can refresh expired tokens without merchant intervention."

This repo already stores offline access-token sessions. `authenticateAdmin` requests offline tokens in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L539-L546):

```ts
requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
expiring: true,
```

The D1 schema stores the token fields in [migrations/0001_init.sql](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/migrations/0001_init.sql#L1-L19):

```sql
accessToken text,
refreshToken text,
refreshTokenExpires integer
```

`ensureValidOfflineSession(shop)` already loads and refreshes by offline session id in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L252-L260):

```ts
const loaded = yield* loadSession(yield* offlineSessionId(shop));
if (Option.isNone(loaded)) return Option.none();
const session = loaded.value;
return session.isExpired(WITHIN_MILLISECONDS_OF_EXPIRY) && session.refreshToken
  ? Option.some(yield* refreshOfflineToken(shop, session.refreshToken))
  : Option.some(session);
```

So the cleanup should not remove offline/batch capability. It should make it explicit.

Clear API split:

```ts
graphqlDecode(schema, query, options)
```

Use after `authenticateAdmin(request)` in request-bound code. Reads the current authenticated session from the request-scoped ref.

```ts
graphqlDecodeForShop(shop, schema, query, options)
```

Use from batch/webhook/cron/queue code. Calls `ensureValidOfflineSession(shop)` and then creates `new shopify.clients.Graphql({ session })`.

This is clearer than `unauthenticatedAdmin(shop).graphql(...)` because the method name says exactly where the session comes from: stored offline access token for a shop.

## Recommended Cleanup

### 1. Replace `adminContextRef` with `adminSessionRef`

Store the authenticated session directly:

```ts
const adminSessionRef = yield* Ref.make<Option.Option<ShopifyApi.Session>>(Option.none());
```

Then `authenticateAdmin` does:

```ts
yield* Ref.set(adminSessionRef, Option.some(existingSession.value));
return { session: existingSession.value };
```

And after token exchange:

```ts
yield* storeSession(exchanged.session);
yield* Ref.set(adminSessionRef, Option.some(exchanged.session));
return { session: exchanged.session };
```

This preserves current route needs because callers only use `auth.session.shop` and middleware passes `session: auth.session`.

### 2. Remove `graphql` from `ShopifyAdminContext`

Current type in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L22-L30):

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

Can become:

```ts
export interface ShopifyAdminContext {
  readonly session: ShopifyApi.Session;
}

export type ShopifyAuthenticateAdminResult = ShopifyAdminContext | Response;
```

Potential rename after cleanup:

```ts
export interface ShopifyAuthenticatedSession {
  readonly session: ShopifyApi.Session;
}
```

The rename is clearer, but optional. Minimal first step: remove `graphql` only.

### 3. Inline Shopify GraphQL request in `graphqlDecode`

Move the `new shopify.clients.Graphql({ session })` logic into `graphqlDecode`:

```ts
const session = yield* Ref.get(adminSessionRef).pipe(
  Effect.flatMap(Effect.fromOption),
  Effect.mapError(() => new ShopifyError({ message: "authenticateAdmin must be called before graphqlDecode", cause: undefined })),
);
const client = new shopify.clients.Graphql({ session });
const { data, errors } = yield* Effect.tryPromise({
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
  Effect.mapError((cause) => new ShopifyError({ message: cause instanceof Error ? cause.message : String(cause), cause })),
);
```

This keeps the existing 401 invalidation behavior in one place while removing the context indirection. The later 401 parity fix can be applied here instead of inside `buildAdminContext`.

### 4. Remove or narrow `buildAdminContext`

After `graphqlDecode` owns GraphQL client creation, `buildAdminContext` has no current value for `authenticateAdmin`.

Options:

| Option | Shape | Pros | Cons |
| - | - | - | - |
| Remove entirely | Return `{ session }` from `authenticateAdmin` | Clearest for current app | Drops `unauthenticatedAdmin().graphql` and webhook `admin` unless replaced |
| Narrow to `buildSessionContext` | `const buildSessionContext = (session) => ({ session })` | Minimal churn, keeps return shape | Still a helper for a one-field object |
| Keep only for requestless APIs | `unauthenticatedAdmin` / webhook return `{ session, graphqlDecode }` | Preserves future background API concept | Not used today; keeps extra surface |

Recommended first cleanup: remove `buildAdminContext` from the authenticated request flow and return `{ session }`. Then decide separately whether requestless/background GraphQL needs a public API.

### 5. Replace requestless `admin.graphql` with explicit offline GraphQL

`unauthenticatedAdmin` currently returns `buildAdminContext(session)` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L274-L288):

```ts
const unauthenticatedAdmin = Effect.fn("Shopify.unauthenticatedAdmin")(
  function* (shop: Domain.Shop) {
    const session = yield* Effect.fromOption(
      yield* ensureValidOfflineSession(shop),
    ).pipe(...);
    return buildAdminContext(session);
  },
);
```

`authenticateWebhook` currently includes `admin` in its return object in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L379-L387):

```ts
return {
  ...rest,
  shop,
  payload: JSON.parse(rawBody) as unknown,
  session,
  admin: session ? buildAdminContext(session) : undefined,
} as const;
```

No current route uses either returned GraphQL API:

```text
src/routes/webhooks.app.scopes_update.ts   uses result.session only
src/routes/webhooks.app.uninstalled.ts     uses result.shop only
```

Recommended options:

- Minimal cleanup: make both return `{ session }`-style contexts without GraphQL and remove `admin` from webhook result.
- Compatibility cleanup: keep `admin` temporarily, but make it `{ session }` only and do not advertise GraphQL there.
- Better offline API: add explicit `graphqlDecodeForShop(shop, schema, query, options)` for background jobs/webhooks.

The explicit API is clearer than a template-style `unauthenticatedAdmin(shop).admin.graphql(...)` chain in an Effect service.

Recommended implementation shape:

```ts
const graphqlDecodeWithSession = Effect.fn("Shopify.graphqlDecodeWithSession")(
  function* <A>(
    session: ShopifyApi.Session,
    schema: Schema.Decoder<A>,
    query: string,
    options?: { readonly variables?: Record<string, unknown> },
  ) {
    const client = new shopify.clients.Graphql({ session });
    const { data, errors } = yield* Effect.tryPromise({
      try: () => client.request(query, { variables: options?.variables }),
      catch: (cause) => cause,
    }).pipe(...);
    if (errors) yield* Effect.fail(new ShopifyError({ message: errors.message ?? "Admin GraphQL request failed", cause: errors }));
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(data),
      catch: (cause) => new ShopifyError({ message: "Admin GraphQL response validation failed", cause }),
    });
  },
);

const graphqlDecode = Effect.fn("Shopify.graphqlDecode")(function* <A>(schema, query, options) {
  const { session } = yield* current authenticated request ref;
  return yield* graphqlDecodeWithSession(session, schema, query, options);
});

const graphqlDecodeForShop = Effect.fn("Shopify.graphqlDecodeForShop")(function* <A>(shop, schema, query, options) {
  const session = yield* Effect.fromOption(yield* ensureValidOfflineSession(shop)).pipe(...);
  return yield* graphqlDecodeWithSession(session, schema, query, options);
});
```

This keeps the actual GraphQL request/decode logic in one place while making session source explicit.

## How This Changes The 401 Fix

The previous Admin API 401 research suggested making `buildAdminContext(session, request?)` request-aware. If `buildAdminContext` is removed, the same parity fix should move into `graphqlDecode`.

`graphqlDecode` needs access to the request only when called from an authenticated browser/server-function request. There are two clean approaches:

1. Store the authenticated request alongside the session:

```ts
const adminAuthRef = yield* Ref.make<Option.Option<{ readonly session: ShopifyApi.Session; readonly request: Request }>>(Option.none());
```

2. Keep only session in the ref now, preserve current best-effort 401 invalidation, and apply current-request response parity in a second pass when request storage is intentionally designed.

Recommended sequence:

1. First cleanup `buildAdminContext` and make `graphqlDecode` direct.
2. Then add request-aware 401 parity to `graphqlDecode`, because the code path will be obvious.

This avoids baking the 401 fix into an abstraction that the project likely does not need.

## Proposed End State

Desired service shape:

```ts
export interface ShopifyAdminContext {
  readonly session: ShopifyApi.Session;
}

const adminAuthRef = Ref<Option<{ session: ShopifyApi.Session; request: Request }>>;

authenticateAdmin(request): Effect<ShopifyAdminContext | Response, ShopifyError>

graphqlDecode(schema, query, options): Effect<A, ShopifyError | Response>

graphqlDecodeForShop(shop, schema, query, options): Effect<A, ShopifyError>
```

Desired call path:

```text
shopifyServerFnMiddleware
  -> authenticateAdmin(request)
  -> stores { session, request } in ref
ProductRepository
  -> shopify.graphqlDecode(schema, query, options)
  -> reads { session, request }
  -> new shopify.clients.Graphql({ session }).request(...)
  -> on 401: clear token, fail with request-aware Response
  -> decode data
```

This matches how the app is written: repositories ask the Shopify service for typed GraphQL data; they do not carry an admin client around.

Offline/batch call path:

```text
queue / cron / webhook / workflow
  -> shopify.graphqlDecodeForShop(shop, schema, query, options)
  -> ensureValidOfflineSession(shop)
  -> refresh offline token if expiring
  -> new shopify.clients.Graphql({ session }).request(...)
  -> decode data
```

## Implementation Plan

1. Replace `adminContextRef` with a ref that stores at least `session`, ideally `{ session, request }` for the later 401 parity fix.
2. Remove `graphql` from `ShopifyAdminContext`.
3. Delete or narrow `buildAdminContext`.
4. Update `authenticateAdmin` to return `{ session }` and set the auth ref.
5. Move GraphQL client creation and request error handling directly into `graphqlDecode`.
6. Replace requestless `admin.graphql` surface with `graphqlDecodeForShop` if background/webhook GraphQL is needed.
7. Run `pnpm typecheck` and `pnpm lint`.

## Test Plan

- Existing product generation path still works: `generateProduct` → `ProductRepository` → `graphqlDecode`.
- Calling `graphqlDecode` before `authenticateAdmin` still fails with `authenticateAdmin must be called before graphqlDecode`.
- `authenticateAdmin` still returns enough data for `src/routes/app.tsx` to read `auth.session.shop`.
- `shopifyServerFnMiddleware` still passes `session: auth.session` to downstream context.
- GraphQL API errors still become `ShopifyError`.
- Shopify Admin API `401` still clears `session.accessToken` and persists the invalidated session.
- `graphqlDecodeForShop` loads the stored offline session and refreshes expiring offline tokens before making the GraphQL request.
