import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect, Layer } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { CurrentSession } from "@/lib/CurrentSession";
import { ProductRepository } from "@/lib/ProductRepository";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";

/**
 * Server-function auth middleware for Shopify embedded requests.
 *
 * No client phase:
 * - App Bridge patches global browser `fetch` and auto-attaches
 *   `Authorization: Bearer <session_token>` for embedded app requests.
 * - App Bridge also handles the retry contract for
 *   `401 + X-Shopify-Retry-Invalid-Session-Request: 1`.
 *
 * Server phase:
 * - verifies request/session with `shopify.authenticateAdmin(request)`
 * - injects `{ session }` into middleware context for handlers
 * - builds a session-scoped layer graph for server-function handlers:
 *   `CurrentSession -> ShopifyAdmin -> ProductRepository`
 * - `runEffect` provides that composed layer in one shot, rather than chaining
 *   multiple `Effect.provide...` calls for each handler effect
 * - this keeps dependency wiring explicit and lets Effect construct the graph as
 *   layers: `ShopifyAdmin` needs `CurrentSession`; `ProductRepository` needs
 *   `ShopifyAdmin`
 * - this is more efficient than repeated nested provides because the layer graph
 *   is built once per authenticated server-function request and then reused by
 *   each handler effect executed through `runEffect`
 *
 * Redirect nuance:
 * - `Shopify.authenticateAdmin` returns plain `Response.redirect(...)` values.
 * - TanStack router redirect control flow only recognizes redirects created by
 *   `redirect(...)` (redirect `Response` with router metadata).
 * - So redirect Responses are mapped to `redirect({ href })`; non-redirect
 *   Responses are failed through unchanged.
 *
 * Non-redirect `Response` values are re-thrown unchanged so status/headers
 * (for example Shopify's 401 retry contract) reach TanStack Start transport.
 */
export const shopifyServerFnMiddleware = createMiddleware({ type: "function" })
  .server(({ next, context }) =>
    context.runEffect(
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const request = yield* CurrentRequest;
        const session = yield* shopify.authenticateAdmin(request);

        if (session instanceof Response) {
          const location = session.headers.get("Location") ?? session.headers.get("location");
          if (location) return yield* Effect.fail(redirect({ href: location }));
          return yield* Effect.fail(session);
        }

        const currentSessionLayer = Layer.succeed(CurrentSession, session);
        const shopifyAdminLayer = Layer.provide(ShopifyAdmin.layer, currentSessionLayer);
        const productRepositoryLayer = Layer.provide(ProductRepository.layer, shopifyAdminLayer);
        const serverFnLayer = Layer.mergeAll(currentSessionLayer, shopifyAdminLayer, productRepositoryLayer);
        const runEffect = <A, E>(effect: Effect.Effect<A, E, ProductRepository | ShopifyAdmin | CurrentSession>) =>
          context.runEffect(effect.pipe(Effect.provide(serverFnLayer)));

        return yield* Effect.tryPromise({
          try: () => next({ context: { session, runEffect } }),
          catch: (cause) => cause,
        });
      }),
    ),
  );
