# Shopify Admin API 401 Parity Fix Research

Question: how should this TanStack Start + Cloudflare + Effect port fix Admin API `401 Unauthorized` parity with `refs/shopify-app-template` without adding React Router-specific Shopify dependencies?

## Executive Summary

- Current behavior clears the stored access token when Admin GraphQL returns `401`, then fails the current request with `ShopifyError`.
- Template behavior for `authenticate.admin` contexts clears the stored access token, then fails the current request with Shopify's invalid-session response path.
- For XHR/server-function requests, that response is `401 Unauthorized` without `X-Shopify-Retry-Invalid-Session-Request`, because the access token is invalid, not the browser session token.
- For document requests, that response redirects through the App Bridge bounce page so the browser can re-enter with a fresh `id_token` and then token exchange can acquire a new offline token.
- Recommended fix: make `buildAdminContext` request-aware for contexts produced by `authenticateAdmin(request)`, fail with a raw `Response` after invalidating on `401`, and widen the `graphql` / `graphqlDecode` error type to include `Response`.
- Do not import `@shopify/shopify-app-react-router` or its internals. Use its code only as the parity reference.

## Current Port Behavior

The current Admin context is built without request context in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L193-L219):

```ts
const buildAdminContext = (session: ShopifyApi.Session): ShopifyAdminContext => ({
  session,
  graphql: Effect.fn("Shopify.graphql")(function* (query, options) {
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
  }),
});
```

The comment says the current request is not rescued in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L180-L191):

> "On 401 from Shopify, clears `session.accessToken` and re-stores the row."

> "This does not rescue the current request — the 401 still propagates as `ShopifyError` — but it forces the next `authenticateAdmin` browser request to see `isActive() === false` and fall through to token exchange"

That is only partial parity. It gets next-request recovery, but not current-request response semantics.

## Template Behavior

Shopify App JS wires a request-bound client error handler for admin contexts created by `authenticate.admin(request)`. In [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts#L154-L169):

```ts
function handleClientError(request: Request): HandleAdminClientError {
  return handleClientErrorFactory({
    request,
    onError: async ({session, error}: OnErrorOptions) => {
      if (error.response.code === 401) {
        logger.debug('Responding to invalid access token', {
          shop: getShopFromRequest(request),
        });
        await invalidateAccessToken({config, api, logger}, session);

        respondToInvalidSessionToken({
          params: {config, api, logger},
          request,
        });
      }
    },
  });
}
```

The invalidation helper clears and stores the token in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/invalidate-access-token.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/invalidate-access-token.ts#L5-L17):

```ts
export async function invalidateAccessToken(
  params: BasicParams,
  session: Session,
): Promise<void> {
  const {logger, config} = params;

  logger.debug(`Invalidating access token for session - ${session.id}`, {
    shop: session.shop,
  });

  session.accessToken = undefined;
  await config.sessionStorage!.storeSession(session);
}
```

The invalid-session response helper splits document versus XHR requests in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/respond-to-invalid-session-token.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/respond-to-invalid-session-token.ts#L11-L28):

```ts
export function respondToInvalidSessionToken({
  params,
  request,
  retryRequest = false,
}: RespondToInvalidSessionTokenParams) {
  const {api, logger, config} = params;

  const isDocumentRequest = !request.headers.get('authorization');
  if (isDocumentRequest) {
    return redirectToBouncePage({api, logger, config}, new URL(request.url));
  }

  throw new Response(undefined, {
    status: 401,
    statusText: 'Unauthorized',
    headers: retryRequest ? RETRY_INVALID_SESSION_HEADER : {},
  });
}
```

Important detail: `handleClientError` calls `respondToInvalidSessionToken` without `retryRequest: true`. That means Admin API access-token `401` is not treated like an invalid browser session token. XHR gets a bare `401`, not `401 + X-Shopify-Retry-Invalid-Session-Request: 1`.

The GraphQL client calls this handler on errors in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/graphql.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/graphql.ts#L22-L38):

```ts
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
```

## Current TanStack Transport Supports Raw Responses

This port already expects non-redirect `Response` values to propagate through server functions. [src/lib/ShopifyServerFnMiddleware.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/ShopifyServerFnMiddleware.ts#L21-L30) says:

> "Non-redirect `Response` values are re-thrown unchanged so status/headers (for example Shopify's 401 retry contract) reach TanStack Start transport."

The implementation fails raw responses through Effect in [src/lib/ShopifyServerFnMiddleware.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/ShopifyServerFnMiddleware.ts#L39-L43):

```ts
if (auth instanceof Response) {
  const location = auth.headers.get("Location") ?? auth.headers.get("location");
  if (location) return yield* Effect.fail(redirect({ href: location }));
  return yield* Effect.fail(auth);
}
```

The worker also preserves raw `Response` failures in [src/worker.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/worker.ts#L52-L56):

> "Raw `Response` values, TanStack `redirect`, and TanStack `notFound` objects are thrown as-is after `Cause.squash` so TanStack Start can route them correctly"

So the parity fix should integrate naturally if `admin.graphql` can fail with a `Response`.

## Recommended Fix

### 1. Make `ShopifyAdminContext.graphql` able to fail with `Response`

Current type in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L22-L28):

```ts
export interface ShopifyAdminContext {
  readonly session: ShopifyApi.Session;
  readonly graphql: (
    query: string,
    options?: { readonly variables?: Record<string, unknown> },
  ) => Effect.Effect<Awaited<ReturnType<InstanceType<typeof ShopifyApi.GraphqlClient>["request"]>>, ShopifyError>;
}
```

Change the error channel to `ShopifyError | Response`:

```ts
export interface ShopifyAdminContext {
  readonly session: ShopifyApi.Session;
  readonly graphql: (
    query: string,
    options?: { readonly variables?: Record<string, unknown> },
  ) => Effect.Effect<Awaited<ReturnType<InstanceType<typeof ShopifyApi.GraphqlClient>["request"]>>, ShopifyError | Response>;
}
```

`graphqlDecode` should also naturally widen because it yields `admin.graphql(...)` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L618-L627):

```ts
const { data, errors } = yield* admin.graphql(query, options);
if (errors) yield* Effect.fail(new ShopifyError({ message: errors.message ?? "Admin GraphQL request failed", cause: errors }));
return yield* Effect.try({
  try: () => Schema.decodeUnknownSync(schema)(data),
  catch: (cause) => new ShopifyError({ message: "Admin GraphQL response validation failed", cause }),
});
```

No custom wrapper should catch the raw `Response` and turn it into `ShopifyError`.

### 2. Make `buildAdminContext` request-aware

Template parity applies to admin contexts produced by `authenticateAdmin(request)`, because that is where Shopify App JS has the original request needed to decide document bounce versus XHR `401`.

Recommended shape:

```ts
const buildAdminContext = (
  session: ShopifyApi.Session,
  request?: Request,
): ShopifyAdminContext => ({
  session,
  graphql: Effect.fn("Shopify.graphql")(function* (query, options) {
    const client = new shopify.clients.Graphql({ session });
    return yield* Effect.tryPromise({
      try: () => client.request(query, { variables: options?.variables }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchIf(
        (cause): cause is ShopifyApi.HttpResponseError =>
          cause instanceof ShopifyApi.HttpResponseError && cause.response.code === 401,
        (cause) =>
          Effect.gen(function* () {
            session.accessToken = undefined;
            yield* Effect.ignore(storeSession(session));
            if (request) return yield* Effect.fail(respondToInvalidSessionToken(request, false));
            return yield* Effect.fail(
              new ShopifyError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
            );
          }),
      ),
      Effect.mapError((cause) =>
        cause instanceof Response
          ? cause
          : cause instanceof ShopifyError
            ? cause
          : new ShopifyError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
      ),
    );
  }),
});
```

Important: `respondToInvalidSessionToken(request, false)` is intentional for Admin API `401` parity. Use `true` only for invalid browser session-token cases, as the current code already does for `decodeSessionToken` and `tokenExchange` invalid subject-token recovery.

### 3. Pass `request` only from `authenticateAdmin`

Current `authenticateAdmin` builds contexts in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L530-L570):

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
const ctx = buildAdminContext(exchanged.session);
yield* Ref.set(adminContextRef, Option.some(ctx));
return ctx;
```

Change both calls to pass the request:

```ts
const ctx = buildAdminContext(existingSession.value, request);
```

```ts
const ctx = buildAdminContext(exchanged.session, request);
```

Keep `unauthenticatedAdmin(shop)` requestless unless a concrete background recovery contract is defined. It currently calls `buildAdminContext(session)` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L274-L288):

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

That means background jobs still invalidate best-effort and fail with `ShopifyError`, which is reasonable because there is no browser request to bounce and no App Bridge client to receive a response.

### 4. Update the existing comment

The existing comment in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L180-L191) will become stale. Replace it with the actual behavior:

```ts
/**
 * Builds an admin context around a stored offline session.
 *
 * For request-bound admin contexts, a Shopify Admin API 401 invalidates the
 * stored access token and fails the current request with the same invalid-session
 * recovery response as the template. For requestless contexts, the token is
 * still invalidated best-effort and the upstream failure is reported as
 * `ShopifyError`.
 */
```

## Expected Behavior After Fix

| Request shape | Trigger | Stored session | Current response | Next request |
| - | - | - | - | - |
| Server function / XHR | Admin GraphQL returns `401` | `accessToken = undefined` persisted | raw `401 Unauthorized`, no retry header | `authenticateAdmin` sees inactive session and token-exchanges |
| Document request | Admin GraphQL returns `401` | `accessToken = undefined` persisted | redirect to `/auth/session-token?...shopify-reload=...` | bounce gets fresh `id_token`, then token-exchanges |
| Background / `unauthenticatedAdmin` | Admin GraphQL returns `401` | `accessToken = undefined` persisted | `ShopifyError` | next interactive admin request token-exchanges |
| Webhook admin context | Admin GraphQL returns `401` | depends on chosen request policy | avoid bounce unless explicitly desired | next interactive admin request token-exchanges |

The webhook row is the only ambiguous case. The current implementation returns `admin` from `authenticateWebhook` by calling `buildAdminContext(session)` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L379-L387):

```ts
return {
  ...rest,
  shop,
  payload: JSON.parse(rawBody) as unknown,
  session,
  admin: session ? buildAdminContext(session) : undefined,
} as const;
```

Do not pass the webhook `request` unless the desired behavior is explicitly a webhook `302` bounce on Admin API 401. That would be surprising for webhook senders and is not useful to App Bridge.

## Test Plan

There are currently no Shopify auth tests under `test/`; searches for `Shopify.graphql`, `HttpResponseError`, and `X-Shopify-Retry-Invalid-Session-Request` returned no matches.

Add targeted tests around `Shopify` with mocked `shopify.clients.Graphql` behavior or a small seam around `buildAdminContext` if extracted.

Minimum cases:

1. XHR request-bound admin context: when GraphQL throws `HttpResponseError` with `response.code === 401`, session is re-stored with `accessToken` cleared and the effect fails with `Response` status `401`.
2. XHR request-bound admin context: the `401` response does not include `X-Shopify-Retry-Invalid-Session-Request`.
3. Document request-bound admin context: when GraphQL throws `401`, session is re-stored with `accessToken` cleared and the effect fails with a redirect `Response` whose location is `/auth/session-token?...shopify-reload=...`.
4. Non-401 `HttpResponseError`: token is not cleared and the effect fails with `ShopifyError`.
5. Store failure during invalidation: still fail the current request with the same 401 recovery response, matching the current best-effort invalidation intent.
6. Requestless context: `401` clears token and fails with `ShopifyError`, not a browser response.

## Implementation Notes

- Keep the fix in `src/lib/Shopify.ts`; no new dependency is needed.
- Preserve `respondToInvalidSessionToken(request, true)` for invalid session tokens and invalid token exchange subject tokens.
- Use `respondToInvalidSessionToken(request, false)` for Admin API access-token `401` parity.
- Widen Effect error types instead of throwing imperatively inside `graphql`; raw `Response` should stay in the error channel so `runEffect` can preserve it.
- Run `pnpm typecheck` and `pnpm lint` after implementation.
