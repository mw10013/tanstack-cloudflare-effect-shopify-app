import { createFileRoute } from "@tanstack/react-router";
import { Effect, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { Shopify } from "@/lib/Shopify";

const ScopesUpdatePayload = Schema.Struct({
  current: Schema.Array(Schema.String),
});

export const Route = createFileRoute("/webhooks/app/scopes_update")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* CurrentRequest;
            const shopify = yield* Shopify;
            const result = yield* shopify.validateWebhook(request);
            if (!result.valid) {
              return new Response("Invalid webhook", { status: 401 });
            }
            const payload = yield* Schema.decodeUnknownEffect(
              ScopesUpdatePayload,
            )(JSON.parse(result.rawBody));
            const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(result.domain);
            // Webhooks target the offline (shop-level) session; same session type authenticate.webhook() returns in the official library.
            const id = yield* shopify.offlineSessionId(shop);
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
