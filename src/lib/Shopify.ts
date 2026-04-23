import "@shopify/shopify-api/adapters/web-api";
import * as ShopifyApi from "@shopify/shopify-api";
import { Config, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";

interface ShopifyConfig {
  readonly apiKey: Redacted.Redacted;
  readonly apiSecretKey: Redacted.Redacted;
  readonly appUrl: string;
}

export class ShopifyError extends Schema.TaggedErrorClass<ShopifyError>()(
  "ShopifyError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export interface ShopifyAdminContext {
  readonly session: ShopifyApi.Session;
  readonly graphql: (
    query: string,
    options?: { readonly variables?: Record<string, unknown> },
  ) => Effect.Effect<Awaited<ReturnType<InstanceType<typeof ShopifyApi.GraphqlClient>["request"]>>, ShopifyError>;
}

export type ShopifyAuthenticateAdminResult = ShopifyAdminContext | Response;

export type ShopifyLoginResult = { readonly shop?: string } | Response;

const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";
const CDN_URL = "https://cdn.shopify.com";
const WITHIN_MILLISECONDS_OF_EXPIRY = 5 * 60 * 1000;

/**
 * Local `shopify app dev` injects `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and
 * `HOST`/`APP_URL` into the `shopify.web.toml` dev process. This repo relies on
 * that injection for local dev, so `.env` should not define blank placeholders
 * for those keys because `pnpm dev` sources `.env` into the shell first.
 */
const shopifyConfig = Config.all({
  apiKey: Config.nonEmptyString("SHOPIFY_API_KEY").pipe(
    Config.map(Redacted.make),
  ),
  apiSecretKey: Config.nonEmptyString("SHOPIFY_API_SECRET").pipe(
    Config.map(Redacted.make),
  ),
  appUrl: Config.nonEmptyString("SHOPIFY_APP_URL").pipe(
    Config.orElse(() => Config.nonEmptyString("APP_URL")),
    Config.orElse(() => Config.nonEmptyString("HOST")),
    Config.map((value) =>
      value.startsWith("http://") || value.startsWith("https://")
        ? value
        : `https://${value}`,
    ),
  ),
});

const makeShopifyApi = ({ apiKey, apiSecretKey, appUrl }: ShopifyConfig) => {
  const { host, protocol } = new URL(appUrl);
  return ShopifyApi.shopifyApi({
    apiKey: Redacted.value(apiKey),
    apiSecretKey: Redacted.value(apiSecretKey),
    hostName: host,
    hostScheme: protocol.replace(":", "") as "http" | "https",
    apiVersion: ShopifyApi.ApiVersion.January26,
    isEmbeddedApp: true,
  });
};

const tryShopify = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      new ShopifyError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const tryShopifyPromise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new ShopifyError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const setShopifyDocumentHeaders = (headers: Headers, shop: Domain.Shop) => {
  headers.set(
    "Link",
    `<${CDN_URL}>; rel="preconnect", <${APP_BRIDGE_URL}>; rel="preload"; as="script", <${POLARIS_URL}>; rel="preload"; as="script"`,
  );
  headers.set(
    "Content-Security-Policy",
    `frame-ancestors https://${shop} https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;`,
  );
};

const buildDocumentResponseHeaders = (shop: Domain.Shop | null) => {
  const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
  if (shop) {
    setShopifyDocumentHeaders(headers, shop);
  }
  return headers;
};

const renderBouncePage = (apiKey: string, shop: Domain.Shop | null): Response =>
  new Response(
    `<script data-api-key="${apiKey}" src="${APP_BRIDGE_URL}"></script>`,
    { headers: buildDocumentResponseHeaders(shop) },
  );

const renderExitIframePage = (
  apiKey: string,
  shop: Domain.Shop | null,
  destination: string,
): Response =>
  new Response(
    `<script data-api-key="${apiKey}" src="${APP_BRIDGE_URL}"></script>
<script>window.open(${JSON.stringify(destination)}, "_top")</script>`,
    { headers: buildDocumentResponseHeaders(shop) },
  );

const buildAdminContext = (
  shopify: ReturnType<typeof makeShopifyApi>,
  session: ShopifyApi.Session,
): ShopifyAdminContext => ({
  session,
  graphql: Effect.fn("Shopify.graphql")(function* (query, options) {
    const client = new shopify.clients.Graphql({ session });
    const apiResponse = yield* tryShopifyPromise(() =>
      client.request(query, {
        variables: options?.variables,
      }),
    );
    return apiResponse;
  }),
});

export class Shopify extends Context.Service<Shopify>()("Shopify", {
  make: Effect.gen(function* () {
    const repository = yield* Repository;
    const config = yield* shopifyConfig;
    const shopify = makeShopifyApi(config);
    const adminContextRef = yield* Ref.make<Option.Option<ShopifyAdminContext>>(Option.none());
    const storeSession = Effect.fn("Shopify.storeSession")(function* (
      session: ShopifyApi.Session,
    ) {
      const associatedUser = session.onlineAccessInfo?.associated_user;
      yield* Schema.decodeUnknownEffect(Domain.Session)({
        id: session.id,
        shop: session.shop,
        state: session.state,
        isOnline: session.isOnline ? 1 : 0,
        scope: session.scope ?? null,
        expires: session.expires?.getTime() ?? null,
        accessToken: session.accessToken ?? null,
        userId: associatedUser?.id ?? null,
        firstName: associatedUser?.first_name ?? null,
        lastName: associatedUser?.last_name ?? null,
        email: associatedUser?.email ?? null,
        accountOwner:
          associatedUser?.account_owner === undefined
            ? null
            : Number(associatedUser.account_owner),
        locale: associatedUser?.locale ?? null,
        collaborator:
          associatedUser?.collaborator === undefined
            ? null
            : Number(associatedUser.collaborator),
        emailVerified:
          associatedUser?.email_verified === undefined
            ? null
            : Number(associatedUser.email_verified),
        refreshToken: session.refreshToken ?? null,
        refreshTokenExpires: session.refreshTokenExpires?.getTime() ?? null,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ShopifyError({
              message: "Invalid session payload",
              cause,
            }),
        ),
        Effect.flatMap(repository.upsertSession),
      );
    });
    const loadSession = Effect.fn("Shopify.loadSession")(function* (id: Domain.Session["id"]) {
      const storedSession = yield* repository.findSessionById(id);
      if (Option.isNone(storedSession)) return Option.none();
      return yield* tryShopify(() =>
        ShopifyApi.Session.fromPropertyArray(
          Object.entries(storedSession.value).filter(
            (entry): entry is [string, string | number] => entry[1] !== null,
          ),
          true,
        ),
      ).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ShopifyError", () => Effect.succeed(Option.none())),
      );
    });
    const deleteSessionsByShop = Effect.fn("Shopify.deleteSessionsByShop")(
      (shop: Domain.Session["shop"]) => repository.deleteSessionsByShop(shop),
    );
    const updateSessionScope = Effect.fn("Shopify.updateSessionScope")(
      function* ({ id, scope }: Pick<Domain.Session, "id" | "scope">) {
        yield* repository.updateSessionScope(id, scope);
      },
    );
    /**
     * Returns a Response with Shopify document headers applied when needed.
     *
     * Behavior:
     * - Non-HTML responses are returned unchanged.
     * - HTML responses without a valid `shop` query param are returned unchanged.
     * - HTML responses with a valid `shop` are returned as a new Response with
     *   Link preload/preconnect and frame-ancestors CSP headers.
     *
     * Cloudflare Workers documents upstream responses as immutable, so header
     * changes are applied by cloning headers and returning a new Response.
     */
    const withShopifyDocumentHeaders = Effect.fn(
      "Shopify.withShopifyDocumentHeaders",
    )((request: Request, response: Response) =>
      // Lift sync header/response logic into the Effect description so it runs
      // when the Effect is executed by the runtime, not at definition time.
      Effect.sync(() => {
        if (!response.headers.get("content-type")?.startsWith("text/html")) {
          return response;
        }
        const shopParam = new URL(request.url).searchParams.get("shop");
        const sanitizedShop = shopParam ? shopify.utils.sanitizeShop(shopParam) : null;
        const shop = sanitizedShop !== null ? Schema.decodeUnknownSync(Domain.Shop)(sanitizedShop) : null;
        if (!shop) {
          return response;
        }
        const headers = new Headers(response.headers);
        setShopifyDocumentHeaders(headers, shop);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }),
    );
    /**
     * Validates an incoming Shopify webhook request.
     *
     * Deviates from `shopify.webhooks.validate({ rawBody, rawRequest })`: reads
     * the body internally (stream can only be consumed once) and returns it
     * alongside the validation result so callers that need the payload don't
     * have to read the body themselves.
     */
    const validateWebhook = Effect.fn("Shopify.validateWebhook")(
      function* (request: Request) {
        const rawBody = yield* tryShopifyPromise(() => request.text());
        const result = yield* tryShopifyPromise(() =>
          shopify.webhooks.validate({
            rawBody,
            rawRequest: request,
          }),
        );
        return { ...result, rawBody };
      },
    );
    /**
     * Authenticates Shopify Admin requests for embedded app flows.
     *
     * Supported request shapes:
     * - document/navigation requests using `shop`, `host`, and `id_token` query params
     * - XHR/RPC requests carrying `Authorization: Bearer <session_token>`
     *
     * Behavior:
     * - renders App Bridge bounce/exit pages for `/auth/session-token` and `/auth/exit-iframe`
     * - redirects to login/embedded/bounce routes when required auth params are missing
     * - validates and decodes the session token, derives shop from token payload, loads stored offline session
     * - exchanges token and persists session when no active stored session exists
     *
     * Returns either:
     * - `ShopifyAdminContext` on success
     * - `Response` for redirect/bounce/unauthorized document control flow
     */
    const authenticateAdmin = Effect.fn("Shopify.authenticateAdmin")(
      function* (request: Request) {
        const url = new URL(request.url);
        const shopParam = url.searchParams.get("shop");
        const hostParam = url.searchParams.get("host");
        const sanitizedShop = shopParam ? shopify.utils.sanitizeShop(shopParam, true) : null;
        const shop = sanitizedShop !== null ? Schema.decodeUnknownSync(Domain.Shop)(sanitizedShop) : null;
        const host = hostParam ? shopify.utils.sanitizeHost(hostParam) : null;

        if (url.pathname.endsWith("/auth/session-token")) {
          return renderBouncePage(Redacted.value(config.apiKey), shop);
        }

        if (url.pathname.endsWith("/auth/exit-iframe")) {
          return renderExitIframePage(
            Redacted.value(config.apiKey),
            shop,
            url.searchParams.get("exitIframe") ?? config.appUrl,
          );
        }

        const headerSessionToken = request.headers
          .get("authorization")
          ?.replace("Bearer ", "");
        const searchParamSessionToken = url.searchParams.get("id_token");
        const sessionToken = headerSessionToken ?? searchParamSessionToken;
        const isDocumentRequest = !headerSessionToken;

        if (isDocumentRequest) {
          if (!shop || !host) {
            return Response.redirect(
              new URL("/auth/login", request.url).toString(),
            );
          }
          if (url.searchParams.get("embedded") !== "1") {
            const embeddedUrl = yield* tryShopifyPromise(() =>
              shopify.auth.getEmbeddedAppUrl({ rawRequest: request }),
            );
            return Response.redirect(embeddedUrl);
          }
          if (!searchParamSessionToken) {
            const searchParams = new URLSearchParams(url.searchParams);
            searchParams.delete("id_token");
            searchParams.set(
              "shopify-reload",
              `${config.appUrl}${url.pathname}?${searchParams.toString()}`,
            );
            return Response.redirect(
              new URL(
                `/auth/session-token?${searchParams.toString()}`,
                request.url,
              ).toString(),
            );
          }
        }

        if (!sessionToken) {
          return new Response("Unauthorized", { status: 401 });
        }

        const payload = yield* tryShopifyPromise(() =>
          shopify.session.decodeSessionToken(sessionToken),
        );
        const sessionShop = yield* Schema.decodeUnknownEffect(Domain.Shop)(
          new URL(payload.dest).hostname,
        ).pipe(Effect.mapError((cause) => new ShopifyError({ message: "Invalid shop domain", cause })));
        const sessionId = yield* offlineSessionId(sessionShop);
        const existingSession = yield* loadSession(sessionId);

        if (
          Option.isSome(existingSession) &&
          existingSession.value.isActive(undefined, WITHIN_MILLISECONDS_OF_EXPIRY)
        ) {
          const ctx = buildAdminContext(shopify, existingSession.value);
          yield* Ref.set(adminContextRef, Option.some(ctx));
          return ctx;
        }

        const { session } = yield* tryShopifyPromise(() =>
          shopify.auth.tokenExchange({
            shop: sessionShop,
            sessionToken,
            requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
          }),
        );
        yield* storeSession(session);
        const ctx = buildAdminContext(shopify, session);
        yield* Ref.set(adminContextRef, Option.some(ctx));
        return ctx;
      },
    );
    const login = Effect.fn("Shopify.login")(function* (request: Request) {
      const url = new URL(request.url);
      const shopParam = url.searchParams.get("shop");

      if (request.method === "GET" && !shopParam) {
        return {};
      }

      const formData = shopParam
        ? null
        : yield* tryShopifyPromise(() => request.formData());
      const shopInput =
        shopParam ?? (formData?.get("shop") as string | null) ?? "";
      const shopWithoutProtocol = shopInput
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");
      const shopWithDomain =
        !shopWithoutProtocol.includes(".")
          ? `${shopWithoutProtocol}.myshopify.com`
          : shopWithoutProtocol;
      const sanitizedShop = shopify.utils.sanitizeShop(shopWithDomain);

      if (!sanitizedShop) {
        return { shop: "invalid" };
      }

      const adminPath = shopify.utils.legacyUrlToShopAdminUrl(sanitizedShop);
      if (!adminPath) {
        return { shop: "invalid" };
      }

      return Response.redirect(
        `https://${adminPath}/oauth/install?client_id=${Redacted.value(config.apiKey)}`,
      );
    });
    const offlineSessionId = Effect.fn("Shopify.offlineSessionId")(function* (shop: Domain.Session["shop"]) {
      return yield* Schema.decodeUnknownEffect(Domain.SessionId)(
        shopify.session.getOfflineId(shop),
      ).pipe(Effect.mapError((cause) => new ShopifyError({ message: "Invalid session id", cause })));
    });
    const graphqlDecode = Effect.fn("Shopify.graphqlDecode")(function* <A>(
      schema: Schema.Decoder<A>,
      query: string,
      options?: { readonly variables?: Record<string, unknown> },
    ) {
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
    });
    return {
      config,
      authenticateAdmin,
      login,
      withShopifyDocumentHeaders,
      validateWebhook,
      storeSession,
      loadSession,
      deleteSessionsByShop,
      updateSessionScope,
      offlineSessionId,
      graphqlDecode,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
