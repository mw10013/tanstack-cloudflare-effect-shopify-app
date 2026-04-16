import { createFileRoute } from "@tanstack/react-router";

import { getShopifyApi, storeShopifySession } from "@/lib/Shopify";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const shopify = getShopifyApi();
        const callback = await shopify.auth.callback<Headers>({
          rawRequest: request,
        });
        await storeShopifySession({
          env: context.env,
          session: callback.session,
        });
        const destination = new URL("/app", request.url);
        const query = new URL(request.url).searchParams;
        const shopParam = query.get("shop");
        const hostParam = query.get("host");
        const shop = shopParam ? shopify.utils.sanitizeShop(shopParam, true) : null;
        const host = hostParam ? shopify.utils.sanitizeHost(hostParam) : null;
        if (shop) {
          destination.searchParams.set("shop", shop);
        }
        if (host) {
          destination.searchParams.set("host", host);
        }
        destination.searchParams.set("embedded", "1");
        const headers = new Headers(callback.headers);
        headers.set("location", destination.toString());
        return new Response(null, {
          status: 302,
          headers,
        });
      },
    },
  },
});
