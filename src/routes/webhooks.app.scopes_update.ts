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
            const result = yield* shopify.authenticateWebhook(request);
            if (result instanceof Response) return result;
            const payload = yield* Schema.decodeUnknownEffect(ScopesUpdatePayload)(
              result.payload,
            );
            if (result.session) {
              yield* shopify.updateSessionScope({
                id: yield* Schema.decodeUnknownEffect(Domain.SessionId)(
                  result.session.id,
                ),
                scope: payload.current.toString(),
              });
            }
            return new Response();
          }),
        ),
    },
  },
});
