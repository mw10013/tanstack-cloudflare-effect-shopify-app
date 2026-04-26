import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { ProductRepository } from "@/lib/ProductRepository";
import { CurrentSession, Shopify, ShopifyAdmin } from "@/lib/Shopify";

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

        const runEffect = <A, E>(effect: Effect.Effect<A, E, ProductRepository | ShopifyAdmin | CurrentSession>) =>
          context.runEffect(
            effect.pipe(
              Effect.provide(ProductRepository.layer),
              Effect.provide(ShopifyAdmin.layer),
              Effect.provideService(CurrentSession, session),
            ),
          );

        return yield* Effect.tryPromise({
          try: () => next({ context: { session, runEffect } }),
          catch: (cause) => cause,
        });
      }),
    ),
  );
