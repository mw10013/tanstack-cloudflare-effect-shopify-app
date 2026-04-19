import { createFileRoute } from "@tanstack/react-router";
import { WebhookValidationErrorReason } from "@shopify/shopify-api";
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
              return result.reason === WebhookValidationErrorReason.InvalidHmac
                ? new Response("Unauthorized", { status: 401 })
                : new Response("Bad Request", { status: 400 });
            }
            yield* shopify.deleteSessionsByShop(result.domain);
            return new Response(null, { status: 200 });
          }),
        ),
    },
  },
});
