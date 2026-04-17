import { createFileRoute } from "@tanstack/react-router";

import { getShopifyApi, updateShopifySessionScope } from "@/lib/Shopify";

export const Route = createFileRoute("/webhooks/app/scopes_update")({
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
        const payload = JSON.parse(rawBody) as {
          readonly current?: readonly string[];
        };
        if (!Array.isArray(payload.current)) {
          return new Response(null, { status: 200 });
        }
        await updateShopifySessionScope({
          env: context.env,
          id: shopify.session.getOfflineId(result.domain),
          scope: payload.current.toString(),
        });
        return new Response(null, { status: 200 });
      },
    },
  },
});
