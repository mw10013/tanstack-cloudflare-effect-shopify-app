import "@shopify/shopify-api/adapters/web-api";
import * as ShopifyApi from "@shopify/shopify-api";

interface ShopifyRuntimeConfig {
  readonly apiKey: string;
  readonly apiSecretKey: string;
  readonly appUrl: string;
  readonly scopes: string[] | undefined;
}

type SessionEntry = [string, string | number | boolean];

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
  const appUrl = parseAppUrl(
    process.env.SHOPIFY_APP_URL ?? process.env.APP_URL ?? process.env.HOST,
  );
  shopifyRuntimeConfig = {
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

const parseSessionPayload = (payload: string) => {
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    return;
  }
  return ShopifyApi.Session.fromPropertyArray(parsed as SessionEntry[], true);
};

export const storeShopifySession = async ({
  env,
  session,
}: {
  readonly env: Env;
  readonly session: ShopifyApi.Session;
}) => {
  const payload = JSON.stringify(session.toPropertyArray(true));
  await env.D1.prepare(
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
};

export const loadShopifySession = async ({
  env,
  id,
}: {
  readonly env: Env;
  readonly id: string;
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
  return session;
};

export const findShopifySessionsByShop = async ({
  env,
  shop,
}: {
  readonly env: Env;
  readonly shop: string;
}) => {
  const result = await env.D1.prepare(
    "select payload from ShopifySession where shop = ?1",
  )
    .bind(shop)
    .all<{ payload: string }>();
  const rows = result.results ?? [];
  return rows.flatMap((row) => {
    const session = parseSessionPayload(row.payload);
    return session ? [session] : [];
  });
};

export const deleteShopifySession = async ({
  env,
  id,
}: {
  readonly env: Env;
  readonly id: string;
}) => {
  await env.D1.prepare("delete from ShopifySession where id = ?1")
    .bind(id)
    .run();
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

export const getShopifyOfflineSessionId = (shop: string) =>
  getShopifyApi().session.getOfflineId(shop);

export const getShopifyRequiredScopes = () => getShopifyRuntimeConfig().scopes;
