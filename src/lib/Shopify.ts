import "@shopify/shopify-api/adapters/web-api";
import * as ShopifyApi from "@shopify/shopify-api";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import type * as Domain from "@/lib/Domain";
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
  ) => Effect.Effect<Response, ShopifyError>;
}

export type ShopifyAuthenticateAdminResult = ShopifyAdminContext | Response;

export type ShopifyLoginResult = { readonly shop?: string } | Response;

const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";
const CDN_URL = "https://cdn.shopify.com";
const WITHIN_MILLISECONDS_OF_EXPIRY = 5 * 60 * 1000;

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

/**
 * Sessions are stored as a JSON blob of `Session.toPropertyArray(true)` rather than flat columns.
 * This deviates from the official Shopify session storage adapters (SQLite, Prisma), which map
 * each session field to a dedicated column and ship their own migration runners to handle SDK
 * field additions or renames.
 *
 * The blob approach avoids painful column-level migrations for additive SDK changes (new fields
 * just appear in the blob), but carries a risk if `@shopify/shopify-api` changes field names or
 * encoding: old blobs may deserialize incorrectly without throwing.
 *
 * Hard failures (e.g. `Session.fromPropertyArray` throws `InvalidSession`) are caught as
 * `ShopifyError` and cause `loadSession` to return `Option.none()`, which triggers OAuth
 * re-authentication and a fresh session blob written by `storeSession`. This self-heals the row.
 *
 * For any upgrade to `@shopify/shopify-api`, audit `node_modules/@shopify/shopify-api/lib/session/session.ts`
 * for changes to `propertiesToSave`, `toPropertyArray`, and `fromPropertyArray`. If session
 * serialization changed, it is advisable to wipe the `ShopifySession` table via a D1 migration
 * so all merchants re-authenticate and receive a fresh blob in the current format.
 */
/**
 * Deserializes a stored session payload back into a `Session` object.
 *
 * `Repository` decodes the stored JSON string through `Domain.ShopifySession`,
 * so this function only needs to hand the validated tuple array to
 * `Session.fromPropertyArray`. The domain payload stays readonly; this function
 * makes a shallow mutable copy only to satisfy Shopify's mutable tuple-array
 * signature. Shopify still owns field coercion and session hydration semantics.
 */
const decodeSessionPayload = Effect.fn("Shopify.decodeSessionPayload")(
  (payload: Domain.ShopifySessionPayload) =>
    tryShopify(() =>
      ShopifyApi.Session.fromPropertyArray(
        payload.map<[string, string | number | boolean]>(([key, value]) => [key, value]),
        true,
      ),
    ),
);

const setShopifyDocumentHeaders = (headers: Headers, shop: string) => {
  headers.set(
    "Link",
    `<${CDN_URL}>; rel="preconnect", <${APP_BRIDGE_URL}>; rel="preload"; as="script", <${POLARIS_URL}>; rel="preload"; as="script"`,
  );
  headers.set(
    "Content-Security-Policy",
    `frame-ancestors https://${shop} https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;`,
  );
};

const buildDocumentResponseHeaders = (shop: string | null) => {
  const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
  if (shop) {
    setShopifyDocumentHeaders(headers, shop);
  }
  return headers;
};

const renderBouncePage = (apiKey: string, shop: string | null): Response =>
  new Response(
    `<script data-api-key="${apiKey}" src="${APP_BRIDGE_URL}"></script>`,
    { headers: buildDocumentResponseHeaders(shop) },
  );

const renderExitIframePage = (
  apiKey: string,
  shop: string | null,
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
    return Response.json(apiResponse);
  }),
});

export class Shopify extends Context.Service<Shopify>()("Shopify", {
  make: Effect.gen(function* () {
    const repository = yield* Repository;
    const config = yield* shopifyConfig;
    const shopify = makeShopifyApi(config);
    const storeSession = Effect.fn("Shopify.storeSession")(function* (
      session: ShopifyApi.Session,
    ) {
      yield* repository.upsertShopifySession(session);
    });
    const loadSession = Effect.fn("Shopify.loadSession")(function* (id: string) {
      const row = yield* repository.findShopifySessionById(id);
      if (Option.isNone(row)) {
        return Option.none();
      }
      return yield* decodeSessionPayload(row.value.payload).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ShopifyError", () => Effect.succeed(Option.none())),
      );
    });
    const deleteSessionsByShop = Effect.fn("Shopify.deleteSessionsByShop")(
      function* (shop: string) {
        yield* repository.deleteShopifySessionsByShop(shop);
      },
    );
    const updateSessionScope = Effect.fn("Shopify.updateSessionScope")(
      function* ({ id, scope }: { id: string; scope: string }) {
        const row = yield* repository.findShopifySessionById(id);
        if (Option.isNone(row)) {
          return;
        }
        const sessionOption = yield* decodeSessionPayload(
          row.value.payload,
        ).pipe(
          Effect.map(Option.some),
          Effect.catchTag("ShopifyError", () => Effect.succeed(Option.none())),
        );
        if (Option.isNone(sessionOption)) {
          return;
        }
        sessionOption.value.scope = scope;
        yield* repository.updateShopifySessionPayload({
          id,
          payload: sessionOption.value.toPropertyArray(true),
        });
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
        const shop = shopParam ? shopify.utils.sanitizeShop(shopParam) : null;
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
    const authenticateAdmin = Effect.fn("Shopify.authenticateAdmin")(
      function* (request: Request) {
        const url = new URL(request.url);
        const shopParam = url.searchParams.get("shop");
        const hostParam = url.searchParams.get("host");
        const shop = shopParam
          ? shopify.utils.sanitizeShop(shopParam, true)
          : null;
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
        const sessionShop = new URL(payload.dest).hostname;
        const sessionId = shopify.session.getOfflineId(sessionShop);
        const existingSession = yield* loadSession(sessionId);

        if (
          Option.isSome(existingSession) &&
          existingSession.value.isActive(undefined, WITHIN_MILLISECONDS_OF_EXPIRY)
        ) {
          return buildAdminContext(shopify, existingSession.value);
        }

        const { session } = yield* tryShopifyPromise(() =>
          shopify.auth.tokenExchange({
            shop: sessionShop,
            sessionToken,
            requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
          }),
        );
        yield* storeSession(session);
        return buildAdminContext(shopify, session);
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
    const offlineSessionId = (shop: string) =>
      Effect.succeed(shopify.session.getOfflineId(shop));
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
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
