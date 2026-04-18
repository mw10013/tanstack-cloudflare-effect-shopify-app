import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { Request as AppRequest } from "@/lib/Request";
import { Shopify } from "@/lib/Shopify";

export const Route = createFileRoute("/webhooks/app/uninstalled")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* AppRequest;
            const shopify = yield* Shopify;
            const rawBody = yield* Effect.tryPromise(() => request.text());
            const result = yield* shopify.validateWebhook({ rawBody, request });
            if (!result.valid) {
              return new Response("Invalid webhook", { status: 401 });
            }
            yield* shopify.deleteSessionsByShop(result.domain);
            return new Response(null, { status: 200 });
          }),
        ),
    },
  },
});
