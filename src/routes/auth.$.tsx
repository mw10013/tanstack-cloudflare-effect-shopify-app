import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { Shopify } from "@/lib/Shopify";

export const Route = createFileRoute("/auth/$")({
  server: {
    handlers: {
      GET: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* CurrentRequest;
            const shopify = yield* Shopify;
            const session = yield* shopify.authenticateAdmin(request);
            return session instanceof Response
              ? session
              : new Response(null, { status: 200 });
          }),
        ),
    },
  },
});
