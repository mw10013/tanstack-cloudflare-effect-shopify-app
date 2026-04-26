# Shopify Authentication And Authorization Parity Research

Question: does [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts) achieve authentication and authorization parity with [refs/shopify-app-template](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template), especially session tokens and access tokens? Are we duplicating anything that should be leveraged from [refs/shopify-app-js](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js)?

## Executive Summary

- Core embedded-admin auth is close to template-default parity: document requests, XHR `Authorization: Bearer ...` requests, App Bridge bounce, offline token exchange, expiring offline token refresh, webhook auth, login, and document CSP/preload headers are all manually represented.
- Authorization parity is narrower: the port persists `scope` and handles `app/scopes_update`, but it does not expose the template/library `scopes`, `billing`, `cors`, `redirect`, or `sessionToken` admin-context helpers.
- The biggest behavioral gap is Admin API 401 handling. Shopify App JS invalidates the stored access token and throws an invalid-session response for the current request. This port invalidates the stored token but converts the current failure to `ShopifyError`.
- The biggest duplication is that `src/lib/Shopify.ts` manually ports large parts of the behavior implemented by `@shopify/shopify-app-react-router/server`: `authenticate.admin`, `authenticate.webhook`, `unauthenticated.admin`, `login`, `addDocumentResponseHeaders`, token exchange, refresh, invalid session token responses, and session serialization.
- The project already leverages `@shopify/shopify-api` for low-level validation, token exchange, refresh, GraphQL client creation, shop/host sanitization, and webhook validation. It does not currently depend on `@shopify/shopify-app-react-router`.
- Do not add `@shopify/shopify-app-react-router` to this TanStack Start port by default. It would couple framework-native auth control flow to React Router-specific redirects, boundaries, and route conventions.
- Better direction: keep the implementation TanStack Start + Cloudflare + Effect native, use `@shopify/shopify-api` as the dependency boundary, and use Shopify App JS React Router code only as a behavioral reference.

## Baseline: What The Template Uses

The template creates a `shopifyApp` with Prisma-backed session storage, App Store distribution, and expiring offline tokens in [refs/shopify-app-template/app/shopify.server.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/shopify.server.ts#L10-L25):

```ts
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
});
```

The template protects its app shell by calling `authenticate.admin(request)` in [refs/shopify-app-template/app/routes/app.tsx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/routes/app.tsx#L8-L13):

```ts
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};
```

The template routes `/auth/*` through `authenticate.admin(request)` in [refs/shopify-app-template/app/routes/auth.$.tsx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/routes/auth.$.tsx#L6-L10):

```ts
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};
```

The template authenticates webhooks before acting in [refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx#L5-L16):

```ts
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  return new Response();
};
```

## Shopify Auth Model

Shopify distinguishes backend request authentication from API authorization.

Shopify session-token docs say in [refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/session-tokens.md#L31-L57):

> "After the frontend code has loaded, your app calls a Shopify App Bridge action to get the session token. Your app includes the session token in an authorization header when it makes any HTTPS requests to its backend."

> "The lifetime of a session token is one minute."

> "Session tokens are for authentication, and aren't a replacement for authorization."

> "Unlike API access tokens, session tokens can't be used to make authenticated requests to Shopify APIs."

Token exchange docs say in [refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/token-exchange.md#L29-L40):

> "Your app's frontend must acquire a session token from App Bridge."

> "Your app's backend is responsible for authenticating all incoming requests using the session token."

> "If your app doesn't have a valid access token, then it can exchange its session token for an access token using token exchange."

Offline token docs say in [refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens.md#L13-L27):

> "Tokens with offline access mode are meant for service-to-service requests where no user interaction is involved."

> "90-day refresh token lifetime"

> "Token refresh: Apps can refresh expired tokens without merchant intervention."

> "Only one expiring offline token can be active per app/shop combination"

Online token docs say in [refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/online-access-tokens.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens/online-access-tokens.md#L13-L32):

> "Online access is meant to be used when a user is interacting with your app through the web, or when an app must respect an individual user's permission level."

> "An API request made using an online mode access token is guaranteed to respect the user's individual permissions."

> "After an access token has expired, Shopify returns a `401 Unauthorized` response code."

## Current Port Behavior

`src/lib/Shopify.ts` builds `shopifyApi(...)` directly rather than `shopifyApp(...)` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L63-L73):

```ts
return ShopifyApi.shopifyApi({
  apiKey: Redacted.value(apiKey),
  apiSecretKey: Redacted.value(apiSecretKey),
  hostName: host,
  hostScheme: protocol.replace(":", "") as "http" | "https",
  apiVersion: ShopifyApi.ApiVersion.January26,
  isEmbeddedApp: true,
});
```

The port protects the TanStack `/app` boundary with `beforeLoad`, which fits TanStack Router guidance. TanStack docs say in [refs/tan-start/docs/router/api/router/RouteOptionsType.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/tan-start/docs/router/api/router/RouteOptionsType.md#L111-L117):

> "This async function is called before a route is loaded. If an error is thrown here, the route's loader will not be called and the route will not render."

> "It's common to use this function to check if a user is authenticated and redirect them to a login page if they are not."

The port does this in [src/routes/app.tsx](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/app.tsx#L95-L110):

```ts
export const Route = createFileRoute("/app")({
  beforeLoad: async ({ location }) => {
    return authenticateAppRoute({
      data: {
        searchStr: location.searchStr,
        pathname: location.pathname,
      },
    });
  },
  component: AppLayout,
});
```

Effect usage is idiomatic for this port. Effect docs say in [refs/effect4/ai-docs/src/01_effect/01_basics/index.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/ai-docs/src/01_effect/01_basics/index.md#L1-L5):

> "Prefer writing Effect code with `Effect.gen` & `Effect.fn("name")`."

Effect integration docs say in [refs/effect4/ai-docs/src/03_integration/index.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/effect4/ai-docs/src/03_integration/index.md#L1-L5):

> "ManagedRuntime bridges Effect programs with non-Effect code. Build one runtime from your application Layer, then use it anywhere you need imperative execution, like web handlers, framework hooks, worker queues, or legacy callback APIs."

The worker builds a per-request runtime in [src/worker.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/worker.ts#L76-L83):

```ts
const makeRunEffect = (env: Env, request: Request) => {
  const appLayer = makeAppLayer(env, request);
  const managedRuntime = ManagedRuntime.make(appLayer);
  const runEffect = async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof appLayer>>,
  ): Promise<A> => {
    const exit = await managedRuntime.runPromiseExit(effect);
```

## Parity Matrix

| Area | Template / Shopify App JS | Current port | Parity |
| - | - | - | - |
| App Store embedded config | `shopifyApp`, `distribution: AppDistribution.AppStore`, `isEmbeddedApp: true` | `shopifyApi`, `isEmbeddedApp: true`, manual App Store-style flow | Close |
| API version | Template uses `October25` | Port uses `January26` | Intentional difference, not auth-specific |
| Session storage | `PrismaSessionStorage` implementing Shopify `SessionStorage` | D1 repository with equivalent session fields | Close |
| Session token from header/query | Header or `id_token` query param | Header or `id_token` query param | Close |
| Session token validation | `decodeSessionToken`, invalid tokens bounce or 401 retry | `decodeSessionToken`, `InvalidJwtError` bounces or 401 retry | Mostly close |
| Document auth | validate `shop`/`host`, ensure embedded, ensure `id_token` | validate `shop`/`host`, ensure embedded, ensure `id_token` | Close |
| Bounce and exit iframe | App Bridge script render | App Bridge script render | Close |
| Token exchange | Offline token exchange by default, expiring flag from config | Offline token exchange, `expiring: true` | Close for template default |
| Online tokens | Supported if `useOnlineTokens: true`, not enabled by template | Not implemented | OK for template default, not library feature parity |
| Offline token refresh | Refreshes in webhook/unauthenticated contexts | Refreshes in webhook/unauthenticated contexts | Close |
| Admin GraphQL client | Returns `Response`, handles client error hook | Returns raw `client.request(...)` result in `Effect` | API shape differs |
| Admin API 401 | Invalidate access token and throw invalid-session response | Invalidate access token and throw `ShopifyError` | Gap |
| Webhook auth | POST only, HMAC validation, optional offline session/admin | Same shape, using `Effect` | Close |
| Document response headers | Adds Link and CSP headers via boundary/header hook | Adds Link and CSP headers to HTML responses in Worker | Close |
| Login | Redirects to Admin `oauth/install?client_id=...` | Same redirect | Close |
| Admin context helpers | `admin`, `billing`, `session`, `cors`, `redirect`, `sessionToken`, `scopes` | `session`, `graphql` | Gap if app needs template helper surface |
| CORS/bot/OPTIONS helpers | Built into `authenticate.admin` | Not represented | Gap for full library parity |
| Hooks/register webhooks/public/flow/POS/fulfillment/storefront | Built into package | Not represented | Out of template route scope |

## Session Token Parity

Shopify App JS gets the token from the same two places as this port. The React Router helper is in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/get-session-token-header.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/get-session-token-header.ts#L3-L10):

```ts
export function getSessionTokenHeader(request: Request): string | undefined {
  return request.headers.get('authorization')?.replace('Bearer ', '');
}

export function getSessionTokenFromUrlParam(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get(SESSION_TOKEN_PARAM);
}
```

This port does the same in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L467-L472):

```ts
const headerSessionToken = request.headers
  .get("authorization")
  ?.replace("Bearer ", "");
const searchParamSessionToken = url.searchParams.get("id_token");
const sessionToken = headerSessionToken ?? searchParamSessionToken;
```

Shopify App JS handles invalid tokens in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/respond-to-invalid-session-token.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/respond-to-invalid-session-token.ts#L11-L28):

```ts
const isDocumentRequest = !request.headers.get('authorization');
if (isDocumentRequest) {
  return redirectToBouncePage({api, logger, config}, new URL(request.url));
}

throw new Response(undefined, {
  status: 401,
  statusText: 'Unauthorized',
  headers: retryRequest ? RETRY_INVALID_SESSION_HEADER : {},
});
```

This port mirrors that split in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L403-L428):

```ts
if (request.headers.get("authorization")) {
  return new Response(undefined, {
    status: 401,
    headers: retryRequest
      ? { "X-Shopify-Retry-Invalid-Session-Request": "1" }
      : {},
  });
}
```

The template catches any session-token validation error and responds as invalid-session in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/validate-session-token.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/validate-session-token.ts#L23-L39):

```ts
try {
  const payload = await api.session.decodeSessionToken(token, {
    checkAudience,
  });
  return payload;
} catch (error) {
  throw respondToInvalidSessionToken({params, request, retryRequest});
}
```

This port only special-cases `InvalidJwtError` around `decodeSessionToken` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L506-L522):

```ts
Effect.catchIf(
  (cause): cause is ShopifyApi.InvalidJwtError =>
    cause instanceof ShopifyApi.InvalidJwtError,
  () => Effect.succeed(respondToInvalidSessionToken(request, true)),
),
```

Assessment: this is probably enough for normal expired/malformed JWT cases, but not identical. Full parity would route all `decodeSessionToken` failures to invalid-session recovery.

## Access Token Parity

Shopify App JS token-exchange strategy requests offline tokens when the stored session is missing or inactive in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts#L100-L114):

```ts
if (
  !session ||
  !session.isActive(undefined, WITHIN_MILLISECONDS_OF_EXPIRY)
) {
  const {session: offlineSession} = await exchangeToken({
    request,
    sessionToken,
    shop,
    requestedTokenType: RequestedTokenType.OfflineAccessToken,
  });
  await config.sessionStorage!.storeSession(offlineSession);
```

This port does the same in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L530-L568):

```ts
if (
  Option.isSome(existingSession) &&
  existingSession.value.isActive(undefined, WITHIN_MILLISECONDS_OF_EXPIRY)
) {
  const ctx = buildAdminContext(existingSession.value);
  return ctx;
}

const exchanged = yield* Effect.tryPromise({
  try: () =>
    shopify.auth.tokenExchange({
      shop: sessionShop,
      sessionToken,
      requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
      expiring: true,
    }),
```

The template's expiring-offline refresh helper is in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts#L10-L31):

```ts
if (
  config.future?.expiringOfflineAccessTokens &&
  session.isExpired(WITHIN_MILLISECONDS_OF_EXPIRY) &&
  config.distribution !== AppDistribution.ShopifyAdmin &&
  session.refreshToken
) {
  const offlineSession = await refreshToken(
    params,
    shop,
    session.refreshToken,
  );
  await config.sessionStorage!.storeSession(offlineSession);
  return offlineSession;
}
```

This port implements the same refresh path in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L252-L260):

```ts
const session = loaded.value;
return session.isExpired(WITHIN_MILLISECONDS_OF_EXPIRY) && session.refreshToken
  ? Option.some(yield* refreshOfflineToken(shop, session.refreshToken))
  : Option.some(session);
```

Assessment: access-token acquisition and refresh are close to template-default parity. The port intentionally does not support online-token mode, which is fine for the template as configured because the template does not set `useOnlineTokens: true`.

## Authorization And Scopes

Shopify's managed-install docs say required scopes are guaranteed after install in [refs/shopify-docs/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes.md#L21-L49):

> "Merchants must grant access before your app can be installed. Your app is guaranteed to have these access scopes after it's installed on the merchant's store."

Shopify App JS adds a `scopes` helper to the admin context in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/authenticate.ts#L138-L143):

```ts
function addScopesFeatures(context: AdminContextBase) {
  return {
    ...context,
    scopes: scopesApiFactory(params, context.session, context.admin),
  };
}
```

This port stores `scope`, updates it from `app/scopes_update`, and otherwise relies on the access token Shopify returns. The update path is in [src/routes/webhooks.app.scopes_update.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/routes/webhooks.app.scopes_update.ts#L20-L33):

```ts
const result = yield* shopify.authenticateWebhook(request);
if (result instanceof Response) return result;
const payload = yield* Schema.decodeUnknownEffect(ScopesUpdatePayload)(
  result.payload,
);
if (result.session) {
  yield* shopify.updateSessionScope({
    id: yield* Schema.decodeUnknownEffect(Domain.SessionId)(
      result.session.id,
    ),
    scope: payload.current.toString(),
  });
}
```

Assessment: required-scope authorization is likely acceptable if Shopify managed installation is authoritative. Optional/dynamic scope parity is missing because the port does not expose `scopes.query`, `scopes.request`, or `scopes.revoke` equivalents.

## Important Gap: Admin API 401 Handling

Shopify App JS invalidates a bad access token and then responds to the current request as invalid-session. The invalidate helper is in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/invalidate-access-token.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/invalidate-access-token.ts#L5-L17):

```ts
session.accessToken = undefined;
await config.sessionStorage!.storeSession(session);
```

The token-exchange admin client error hook is in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts#L154-L169):

```ts
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
```

This port invalidates in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L201-L208):

```ts
Effect.tapError((cause) =>
  cause instanceof ShopifyApi.HttpResponseError && cause.response.code === 401
    ? Effect.gen(function* () {
        session.accessToken = undefined;
        yield* Effect.ignore(storeSession(session));
      })
    : Effect.void,
),
```

But the port then maps the current failure to `ShopifyError` in [src/lib/Shopify.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/lib/Shopify.ts#L209-L215):

```ts
Effect.mapError(
  (cause) =>
    new ShopifyError({
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
),
```

Assessment: next request recovery is present, current request recovery is not template-equivalent. For XHR parity, current Admin API 401 should become a 401 invalid-session response. For document parity, it should bounce back through `/auth/session-token`.

## Duplication Versus Shopify App JS

The high-level Shopify App JS React Router factory wires the exact capabilities this port manually reconstructs. In [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/shopify-app.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/shopify-app.ts#L86-L105):

```ts
const shopify = {
  sessionStorage: config.sessionStorage,
  addDocumentResponseHeaders: addDocumentResponseHeadersFactory(params),
  registerWebhooks: registerWebhooksFactory(params),
  authenticate: {
    admin: authStrategy,
    flow: authenticateFlowFactory(params),
    fulfillmentService: authenticateFulfillmentServiceFactory(params),
    pos: authenticatePOSFactory(params),
    public: authenticatePublicFactory(params),
    webhook: authenticateWebhookFactory<string>(params),
  },
  unauthenticated: {
    admin: unauthenticatedAdminContextFactory(params),
    storefront: unauthenticatedStorefrontContextFactory(params),
  },
};
```

The package also derives config defaults, including auth paths and offline-token defaults, in [refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/shopify-app.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/shopify-app.ts#L191-L208):

```ts
return {
  ...appConfig,
  ...apiConfig,
  useOnlineTokens: appConfig.useOnlineTokens ?? false,
  future: appConfig.future ?? {},
  auth: {
    path: authPathPrefix,
    callbackPath: `${authPathPrefix}/callback`,
    patchSessionTokenPath: `${authPathPrefix}/session-token`,
    exitIframePath: `${authPathPrefix}/exit-iframe`,
    loginPath: `${authPathPrefix}/login`,
  },
```

Current project dependencies in [package.json](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/package.json#L65-L82) include `@shopify/shopify-api` and `@shopify/shopify-app-session-storage`, but not `@shopify/shopify-app-react-router`:

```json
"@shopify/shopify-api": "13.0.0",
"@shopify/shopify-app-session-storage": "5.0.0",
```

The reusable `SessionStorage` interface already exists in [node_modules/@shopify/shopify-app-session-storage/src/types.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/node_modules/@shopify/shopify-app-session-storage/src/types.ts#L6-L40):

```ts
export interface SessionStorage {
  storeSession(session: Session): Promise<boolean>;
  loadSession(id: string): Promise<Session | undefined>;
  deleteSession(id: string): Promise<boolean>;
  deleteSessions(ids: string[]): Promise<boolean>;
  findSessionsByShop(shop: string): Promise<Session[]>;
}
```

Assessment: this is useful as a parity oracle, not necessarily as a dependency. The most stable direct dependency boundary for this port remains `@shopify/shopify-api`, because it is framework-neutral and already provides the primitives that matter: session-token decoding, token exchange, token refresh, webhook validation, GraphQL clients, and URL sanitization. The least stable reuse point is importing internal helper files such as `authenticate/helpers/respond-to-invalid-session-token.ts`, because those are not public package API.

## Reuse Options

| Option | What changes | Pros | Cons |
| - | - | - | - |
| Keep current framework-native port | Patch gaps in `src/lib/Shopify.ts` | Small dependency surface, Effect-native, Cloudflare-native, TanStack-native | Requires tracking Shopify App JS behavior manually |
| Add D1 `SessionStorage` adapter | Implement Shopify `SessionStorage` over existing D1 repository | Reuses a framework-neutral interface and clarifies storage parity | Does not reduce auth-flow duplication by itself |
| Adopt `@shopify/shopify-app-react-router/server` | Add React Router-specific package and adapt its control flow | Maximum template parity from one public package | Poor fit for this project: imports React Router semantics into TanStack Start |
| Import Shopify App JS internals | Import copied/internal helper paths | Minimizes copied code initially | Brittle, not public API, path/package changes likely |

Recommended path: keep the current TanStack Start + Cloudflare + Effect-native implementation, continue using framework-neutral `@shopify/shopify-api`, and patch parity gaps against Shopify App JS behavior.

Do not adopt `@shopify/shopify-app-react-router/server` unless the project explicitly chooses template parity over framework purity.

## Concrete Follow-Ups

1. Fix Admin API 401 parity: after invalidating the stored access token, return/throw the same invalid-session recovery response that `respondToInvalidSessionToken` builds.
2. Broaden session-token decode recovery: handle all `decodeSessionToken` failures as invalid-session, matching `validateSessionToken`.
3. Decide whether the app needs template admin-context helper parity: `cors`, `redirect`, `sessionToken`, `billing`, and `scopes`.
4. If reducing duplication matters, first prototype a D1 `SessionStorage` adapter around the existing repository and evaluate whether it simplifies tests or storage parity without importing React Router-specific auth code.
5. Add tests around document request bounce, XHR invalid JWT retry header, token exchange invalid subject token, expiring offline refresh, webhook HMAC failure, and Admin API 401 invalidation/recovery.
