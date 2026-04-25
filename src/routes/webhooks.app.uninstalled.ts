import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { Shopify } from "@/lib/Shopify";

/**
 * Handles the app/uninstalled webhook from Shopify.
 *
 * When a merchant uninstalls the app, their OAuth tokens are immediately
 * invalidated. Retaining stale sessions risks conflicting OAuth flows on
 * re-install and breaks the GDPR compliance chain — shop/redact fires 48 hours
 * later and expects sessions already gone.
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
            const request = yield* CurrentRequest;
            const shopify = yield* Shopify;
            const result = yield* shopify.authenticateWebhook(request);
            if (result instanceof Response) return result;
            yield* shopify.deleteSessionsByShop(result.shop);
            return new Response();
          }),
        ),
    },
  },
});
