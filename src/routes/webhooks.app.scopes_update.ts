import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { Request as AppRequest } from "@/lib/Request";
import { Shopify } from "@/lib/Shopify";

export const Route = createFileRoute("/webhooks/app/scopes_update")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* AppRequest;
            const shopify = yield* Shopify;
            const result = yield* shopify.validateWebhook(request);
            if (!result.valid) {
              return new Response("Invalid webhook", { status: 401 });
            }
            const payload = JSON.parse(result.rawBody) as {
              readonly current?: readonly string[];
            };
            if (!Array.isArray(payload.current)) {
              return new Response();
            }
            const id = yield* shopify.offlineSessionId(result.domain);
            yield* shopify.updateSessionScope({
              id,
              scope: payload.current.toString(),
            });
            return new Response();
          }),
        ),
    },
  },
});
