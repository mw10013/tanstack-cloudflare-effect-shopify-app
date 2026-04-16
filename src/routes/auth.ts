import { createFileRoute } from "@tanstack/react-router";

import { getShopifyApi } from "@/lib/Shopify";

export const Route = createFileRoute("/auth")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const shopify = getShopifyApi();
        const url = new URL(request.url);
        const shopParam = url.searchParams.get("shop");
        const shop = shopParam
          ? shopify.utils.sanitizeShop(shopParam, true)
          : null;
        if (!shop) {
          return Response.redirect(new URL("/auth/login", request.url).toString(), 302);
        }
        return (await shopify.auth.begin({
          shop,
          callbackPath: "/auth/callback",
          isOnline: false,
          rawRequest: request,
        })) as Response;
      },
    },
  },
});
