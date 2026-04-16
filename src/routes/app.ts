import { createFileRoute } from "@tanstack/react-router";

import {
  getShopifyApi,
  getShopifyOfflineSessionId,
  getShopifyRequiredScopes,
  loadShopifySession,
} from "@/lib/Shopify";

const redirectToAuth = (request: Request, shop: string, host: string | null) => {
  const destination = new URL("/auth", request.url);
  destination.searchParams.set("shop", shop);
  if (host) {
    destination.searchParams.set("host", host);
  }
  return Response.redirect(destination.toString(), 302);
};

export const Route = createFileRoute("/app")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const shopify = getShopifyApi();
        const query = new URL(request.url).searchParams;
        const shopParam = query.get("shop");
        const hostParam = query.get("host");
        const shop = shopParam ? shopify.utils.sanitizeShop(shopParam, true) : null;
        const host = hostParam ? shopify.utils.sanitizeHost(hostParam) : null;
        if (!shop) {
          return Response.redirect(new URL("/auth/login", request.url).toString(), 302);
        }
        const sessionId = getShopifyOfflineSessionId(shop);
        const session = await loadShopifySession({
          env: context.env,
          id: sessionId,
        });
        if (!session || !session.isActive(getShopifyRequiredScopes())) {
          return redirectToAuth(request, shop, host);
        }
        return new Response(`Phase 1 works for ${shop}`, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        });
      },
    },
  },
});
