import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";

import { Request as AppRequest } from "@/lib/Request";
import { Shopify } from "@/lib/Shopify";

interface ShopifyGlobal {
  readonly idToken?: () => Promise<string>;
  readonly auth?: {
    readonly idToken?: () => Promise<string>;
  };
}

const getSessionToken = async () => {
  const shopify = (globalThis as typeof globalThis & { readonly shopify?: ShopifyGlobal }).shopify;
  const token = shopify?.idToken
    ? await shopify.idToken()
    : await shopify?.auth?.idToken?.();
  if (!token) {
    throw new TypeError("Missing Shopify App Bridge session token");
  }
  return token;
};

export const shopifyServerFnMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const sessionToken = await getSessionToken();
    return next({ headers: { Authorization: `Bearer ${sessionToken}` } });
  })
  .server(async ({ next, context }) => {
    const auth = await context.runEffect(
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const request = yield* AppRequest;
        return yield* shopify.authenticateAdmin(request);
      }),
    );
    if (auth instanceof Response) {
      throw new TypeError(`Unexpected Shopify auth response: ${String(auth.status)}`);
    }
    return next({ context: { admin: auth, session: auth.session } });
  });
