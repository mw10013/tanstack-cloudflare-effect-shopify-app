import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { Shopify } from "@/lib/Shopify";

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
 * - injects `{ admin, session }` into middleware context for handlers
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
        const auth = yield* shopify.authenticateAdmin(request);

        if (auth instanceof Response) {
          const location = auth.headers.get("Location") ?? auth.headers.get("location");
          if (location) return yield* Effect.fail(redirect({ href: location }));
          return yield* Effect.fail(auth);
        }

        return yield* Effect.tryPromise({
          try: () => next({ context: { admin: auth, session: auth.session } }),
          catch: (cause) => cause,
        });
      }),
    ),
  );
