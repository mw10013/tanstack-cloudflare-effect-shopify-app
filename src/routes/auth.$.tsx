import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { Request as AppRequest } from "@/lib/Request";
import { Shopify } from "@/lib/Shopify";

export const Route = createFileRoute("/auth/$")({
  server: {
    handlers: {
      GET: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* AppRequest;
            const shopify = yield* Shopify;
            const result = yield* shopify.authenticateAdmin(request);
            return result instanceof Response
              ? result
              : new Response(null, { status: 200 });
          }),
        ),
    },
  },
});
