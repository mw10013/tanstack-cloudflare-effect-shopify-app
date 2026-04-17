import "@shopify/shopify-api/adapters/web-api";
import * as ShopifyApi from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";

interface ShopifyRuntimeConfig {
  readonly apiKey: string;
  readonly apiSecretKey: string;
  readonly appUrl: string;
  readonly scopes: string[] | undefined;
}

type SessionEntry = [string, string | number | boolean];

const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";
const CDN_URL = "https://cdn.shopify.com";
const WITHIN_MILLISECONDS_OF_EXPIRY = 5 * 60 * 1000;

const getRequiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const parseScopes = (value: string | undefined) => {
  const scopes =
    value
      ?.split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0) ?? [];
  return scopes.length > 0 ? scopes : undefined;
};

const parseAppUrl = (value: string | undefined) => {
  if (!value) {
    throw new Error("SHOPIFY_APP_URL or APP_URL or HOST is required");
  }
  return value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `https://${value}`;
};

let shopifyRuntimeConfig: ShopifyRuntimeConfig | undefined;

const getShopifyRuntimeConfig = (): ShopifyRuntimeConfig => {
  if (shopifyRuntimeConfig) {
    return shopifyRuntimeConfig;
  }
  // Local dev: Shopify CLI provides dynamic HOST/APP_URL per tunnel, and Cloudflare
  // runtime only sees those parent-process env vars when
  // CLOUDFLARE_INCLUDE_PROCESS_ENV=true in `.shopify-cli/shopify.web.toml`.
  // Production: SHOPIFY_APP_URL must come from platform vars/secrets.
  const appUrl = parseAppUrl(
    process.env.SHOPIFY_APP_URL ?? process.env.APP_URL ?? process.env.HOST,
  );
  shopifyRuntimeConfig = {
    // These come from `.env` in local dev; `.env` values must be exported in
    // package.json `dev` (`set -a && source .env && set +a`) so child processes see them.
    apiKey: getRequiredEnv("SHOPIFY_API_KEY"),
    apiSecretKey: getRequiredEnv("SHOPIFY_API_SECRET"),
    appUrl,
    scopes: parseScopes(process.env.SCOPES),
  };
  return shopifyRuntimeConfig;
};

export const getShopifyApi = () => {
  const { apiKey, apiSecretKey, appUrl, scopes } = getShopifyRuntimeConfig();
  const appUrlObject = new URL(appUrl);
  return ShopifyApi.shopifyApi({
    apiKey,
    apiSecretKey,
    scopes,
    hostName: appUrlObject.host,
    hostScheme: appUrlObject.protocol.replace(":", "") as "http" | "https",
    apiVersion: ShopifyApi.ApiVersion.January26,
    isEmbeddedApp: true,
  });
};

export const getShopifyAppConfig = () => getShopifyRuntimeConfig();

const parseSessionPayload = (payload: string) => {
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    return;
  }
  return ShopifyApi.Session.fromPropertyArray(parsed as SessionEntry[], true);
};

class ShopifyD1SessionStorage implements SessionStorage {
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  public async storeSession(session: ShopifyApi.Session): Promise<boolean> {
    const payload = JSON.stringify(session.toPropertyArray(true));
    await this.env.D1.prepare(
      `
insert into ShopifySession (id, shop, payload)
values (?1, ?2, ?3)
on conflict(id) do update set
  shop = excluded.shop,
  payload = excluded.payload,
  updatedAt = datetime('now')
`,
    )
      .bind(session.id, session.shop, payload)
      .run();
    return true;
  }

  public async loadSession(id: string): Promise<ShopifyApi.Session | undefined> {
    const row = await this.env.D1.prepare(
      "select payload from ShopifySession where id = ?1",
    )
      .bind(id)
      .first<{ payload: string }>();
    if (!row?.payload) {
      return;
    }
    try {
      return parseSessionPayload(row.payload);
    } catch {
      return undefined;
    }
  }

  public async deleteSession(id: string): Promise<boolean> {
    await this.env.D1.prepare("delete from ShopifySession where id = ?1")
      .bind(id)
      .run();
    return true;
  }

  public async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) {
      return true;
    }
    const placeholders = ids
      .map((_, index) => `?${String(index + 1)}`)
      .join(", ");
    await this.env.D1.prepare(
      `delete from ShopifySession where id in (${placeholders})`,
    )
      .bind(...ids)
      .run();
    return true;
  }

  public async findSessionsByShop(shop: string): Promise<ShopifyApi.Session[]> {
    const rows = await this.env.D1.prepare(
      "select payload from ShopifySession where shop = ?1",
    )
      .bind(shop)
      .all<{ payload: string }>();
    return rows.results.flatMap(({ payload }) => {
      try {
        const parsed = parseSessionPayload(payload);
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }
}

export const createShopifySessionStorage = (env: Env): SessionStorage =>
  new ShopifyD1SessionStorage(env);

export const storeShopifySession = async ({
  env,
  session,
}: {
  readonly env: Env;
  readonly session: ShopifyApi.Session;
}) => {
  await createShopifySessionStorage(env).storeSession(session);
};

export const loadShopifySession = async ({
  env,
  id,
}: {
  readonly env: Env;
  readonly id: string;
}) => {
  return createShopifySessionStorage(env).loadSession(id);
};

export const deleteShopifySessionsByShop = async ({
  env,
  shop,
}: {
  readonly env: Env;
  readonly shop: string;
}) => {
  await env.D1.prepare("delete from ShopifySession where shop = ?1")
    .bind(shop)
    .run();
};

export const updateShopifySessionScope = async ({
  env,
  id,
  scope,
}: {
  readonly env: Env;
  readonly id: string;
  readonly scope: string;
}) => {
  const row = await env.D1.prepare(
    "select payload from ShopifySession where id = ?1",
  )
    .bind(id)
    .first<{ payload: string }>();
  if (!row?.payload) {
    return;
  }
  let session: ShopifyApi.Session | undefined;
  try {
    session = parseSessionPayload(row.payload);
  } catch {
    session = undefined;
  }
  if (!session) {
    return;
  }
  session.scope = scope;
  await env.D1.prepare(
    "update ShopifySession set payload = ?1, updatedAt = datetime('now') where id = ?2",
  )
    .bind(JSON.stringify(session.toPropertyArray(true)), id)
    .run();
};

const getSessionTokenFromHeader = (request: Request): string | undefined =>
  request.headers.get("authorization")?.replace("Bearer ", "");

const getSessionTokenFromUrlParam = (request: Request): string | null =>
  new URL(request.url).searchParams.get("id_token");

const applyDocumentHeaders = (headers: Headers, shop: string | null) => {
  if (!shop) {
    return;
  }
  headers.set(
    "Link",
    `<${CDN_URL}>; rel="preconnect", <${APP_BRIDGE_URL}>; rel="preload"; as="script", <${POLARIS_URL}>; rel="preload"; as="script"`,
  );
  headers.set(
    "Content-Security-Policy",
    `frame-ancestors https://${shop} https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;`,
  );
};

export const addDocumentResponseHeaders = (
  request: Request,
  headers: Headers,
) => {
  const shopify = getShopifyApi();
  const shopParam = new URL(request.url).searchParams.get("shop");
  const shop = shopParam ? shopify.utils.sanitizeShop(shopParam) : null;
  applyDocumentHeaders(headers, shop);
};

const buildDocumentResponseHeaders = (shop: string | null) => {
  const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
  applyDocumentHeaders(headers, shop);
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

export interface AuthenticateAdminResult {
  readonly session: ShopifyApi.Session;
  readonly admin: {
    readonly graphql: (
      query: string,
      options?: { readonly variables?: Record<string, unknown> },
    ) => Promise<Response>;
  };
}

export const authenticateAdmin = async ({
  request,
  env,
}: {
  readonly request: Request;
  readonly env: Env;
}): Promise<AuthenticateAdminResult> => {
  const shopify = getShopifyApi();
  const config = getShopifyAppConfig();
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const hostParam = url.searchParams.get("host");
  const shop = shopParam ? shopify.utils.sanitizeShop(shopParam, true) : null;
  const host = hostParam ? shopify.utils.sanitizeHost(hostParam) : null;

  if (url.pathname.endsWith("/auth/session-token")) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw renderBouncePage(config.apiKey, shop);
  }

  if (url.pathname.endsWith("/auth/exit-iframe")) {
    const destination = url.searchParams.get("exitIframe") ?? config.appUrl;
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw renderExitIframePage(config.apiKey, shop, destination);
  }

  const headerSessionToken = getSessionTokenFromHeader(request);
  const searchParamSessionToken = getSessionTokenFromUrlParam(request);
  const sessionToken = headerSessionToken ?? searchParamSessionToken;
  const isDocumentRequest = !headerSessionToken;

  if (isDocumentRequest) {
    if (!shop) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw Response.redirect(new URL("/auth/login", request.url).toString());
    }
    if (!host) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw Response.redirect(new URL("/auth/login", request.url).toString());
    }
    if (url.searchParams.get("embedded") !== "1") {
      const embeddedUrl = await shopify.auth.getEmbeddedAppUrl({
        rawRequest: request,
      });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw Response.redirect(embeddedUrl);
    }
    if (!searchParamSessionToken) {
      const searchParams = new URLSearchParams(url.searchParams);
      searchParams.delete("id_token");
      searchParams.set(
        "shopify-reload",
        `${config.appUrl}${url.pathname}?${searchParams.toString()}`,
      );
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw Response.redirect(
        new URL(
          `/auth/session-token?${searchParams.toString()}`,
          request.url,
        ).toString(),
      );
    }
  }

  if (!sessionToken) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw new Response("Unauthorized", { status: 401 });
  }

  const payload = await shopify.session.decodeSessionToken(sessionToken);
  const dest = new URL(payload.dest);
  const sessionShop = dest.hostname;
  const sessionId = shopify.session.getOfflineId(sessionShop);
  const sessionStorage = createShopifySessionStorage(env);

  const existingSession = await sessionStorage.loadSession(sessionId);

  if (
    existingSession?.isActive(undefined, WITHIN_MILLISECONDS_OF_EXPIRY)
  ) {
    return buildAdminContext(existingSession, shopify);
  }

  const { session: newSession } = await shopify.auth.tokenExchange({
    shop: sessionShop,
    sessionToken,
    requestedTokenType: ShopifyApi.RequestedTokenType.OfflineAccessToken,
  });

  await sessionStorage.storeSession(newSession);

  return buildAdminContext(newSession, shopify);
};

/**
 * Wraps `@shopify/shopify-api`'s `GraphqlClient.request` (returns a parsed
 * `RequestReturn` object) in a `Response` so callers use `.json()`, matching
 * the template's `admin.graphql` shape.
 *
 * Ref: refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/clients/admin/graphql.ts:22-31
 */
const buildAdminContext = (
  session: ShopifyApi.Session,
  shopify: ReturnType<typeof getShopifyApi>,
): AuthenticateAdminResult => ({
  session,
  admin: {
    graphql: async (query, options) => {
      const client = new shopify.clients.Graphql({ session });
      const apiResponse = await client.request(query, {
        variables: options?.variables,
      });
      return Response.json(apiResponse);
    },
  },
});

export const shopifyLogin = async (
  request: Request,
): Promise<{ readonly shop?: string }> => {
  const shopify = getShopifyApi();
  const config = getShopifyAppConfig();
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");

  if (request.method === "GET" && !shopParam) {
    return {};
  }

  const formData = shopParam ? null : await request.formData();
  const shopInput = shopParam ?? (formData?.get("shop") as string | null) ?? "";

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
  const installUrl = `https://${adminPath}/oauth/install?client_id=${config.apiKey}`;

  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw Response.redirect(installUrl);
};
