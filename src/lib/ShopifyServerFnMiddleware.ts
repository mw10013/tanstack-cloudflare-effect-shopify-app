import type { useAppBridge } from "@shopify/app-bridge-react";
import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { Shopify } from "@/lib/Shopify";

type ShopifyGlobal = ReturnType<typeof useAppBridge>;

/**
 * Resolves the current Shopify App Bridge session token in the browser.
 *
 * The App Bridge script exposes `shopify` on the global object; this token is
 * short-lived and intended to be sent per request in `Authorization`.
 */
const getSessionToken = async () => {
  const shopify = (globalThis as typeof globalThis & { readonly shopify?: ShopifyGlobal }).shopify;
  const token = shopify?.idToken ? await shopify.idToken() : undefined;
  if (!token) {
    throw new TypeError("Missing Shopify App Bridge session token");
  }
  return token;
};

/**
 * Server-function auth middleware for Shopify embedded requests.
 *
 * Client phase:
 * - obtains a fresh App Bridge session token
 * - adds `Authorization: Bearer <token>` to the RPC request
 *
 * Server phase:
 * - verifies request/session with `shopify.authenticateAdmin(request)`
 * - injects `{ admin, session }` into middleware context for handlers
 */
export const shopifyServerFnMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const sessionToken = await getSessionToken();
    return next({ headers: { Authorization: `Bearer ${sessionToken}` } });
  })
  .server(async ({ next, context }) => {
    const auth = await context.runEffect(
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const request = yield* CurrentRequest;
        return yield* shopify.authenticateAdmin(request);
      }),
    );
    if (auth instanceof Response) {
      const location = auth.headers.get("Location") ?? auth.headers.get("location");
      if (location) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect({ href: location });
      }
      throw new Error(`Shopify admin auth failed (${String(auth.status)})`);
    }
    return next({ context: { admin: auth, session: auth.session } });
  });
