import { createFileRoute } from "@tanstack/react-router";

import { authenticateAdmin } from "@/lib/Shopify";

export const Route = createFileRoute("/auth/$")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        try {
          await authenticateAdmin({ request, env: context.env });
          return new Response(null, { status: 200 });
        } catch (response) {
          if (response instanceof Response) {
            return response;
          }
          throw response;
        }
      },
    },
  },
});
