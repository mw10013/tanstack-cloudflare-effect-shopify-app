import { createFileRoute } from "@tanstack/react-router";
import { WebhookValidationErrorReason } from "@shopify/shopify-api";
import { Effect } from "effect";

import { Request as AppRequest } from "@/lib/Request";
import { Shopify } from "@/lib/Shopify";

/**
 * Handles the app/uninstalled webhook from Shopify.
 *
 * Deletes all sessions for the shop unconditionally — a single DB call whether
 * this is the first delivery or a retry after sessions are already gone.
 * The template pattern (load session → guard delete) costs two DB calls on
 * first uninstall; the unconditional delete costs one in all cases.
 */
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
