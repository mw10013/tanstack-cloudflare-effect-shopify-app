import { createFileRoute } from "@tanstack/react-router";
import { Effect, Schema } from "effect";

import { Request as AppRequest } from "@/lib/Request";
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
            const request = yield* AppRequest;
            const shopify = yield* Shopify;
            const result = yield* shopify.validateWebhook(request);
            if (!result.valid) {
              return new Response("Invalid webhook", { status: 401 });
            }
            const payload = yield* Schema.decodeUnknownEffect(
              ScopesUpdatePayload,
            )(JSON.parse(result.rawBody));
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
