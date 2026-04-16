import { createFileRoute } from "@tanstack/react-router";

import { deleteShopifySessionsByShop, getShopifyApi } from "@/lib/Shopify";

export const Route = createFileRoute("/webhooks/app/uninstalled")({
  server: {
    handlers: {
      POST: async ({ request, context }) => {
        const shopify = getShopifyApi();
        const rawBody = await request.text();
        const result = await shopify.webhooks.validate({
          rawBody,
          rawRequest: request,
        });
        if (!result.valid) {
          return new Response("Invalid webhook", { status: 401 });
        }
        await deleteShopifySessionsByShop({
          env: context.env,
          shop: result.domain,
        });
        return new Response(null, { status: 200 });
      },
    },
  },
});
