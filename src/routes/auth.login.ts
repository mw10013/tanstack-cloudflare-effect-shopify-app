import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { Shopify } from "@/lib/Shopify";

/**
 * Shopify OAuth login entry point. Intentionally a pure server-route (no React component).
 *
 * Why not a component: this page submits a plain HTML form with no client-side
 * routing or React state — TanStack SSR/hydration would be pure overhead. Polaris
 * web components work without React.
 *
 * Why not redirect on error: returning the error inline in the POST response avoids
 * an extra round-trip (POST → redirect → GET) that the search-param approach requires.
 */
const renderLoginPage = (error?: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Log in</title>
    <link rel="preconnect" href="https://cdn.shopify.com/" />
    <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>
  </head>
  <body>
    <s-page>
      <form method="post" action="/auth/login">
        <s-section heading="Log in">
          <s-text-field
            name="shop"
            label="Shop domain"
            details="example.myshopify.com"
            autocomplete="on"
            ${error ? `error="${error}"` : ""}
          ></s-text-field>
          <s-button type="submit">Log in</s-button>
        </s-section>
      </form>
    </s-page>
  </body>
</html>`;

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* CurrentRequest;
            const shopify = yield* Shopify;
            const result = yield* shopify.login(request);
            if (result instanceof Response) {
              return result;
            }
            const error =
              result.shop === "invalid" ? "Invalid shop domain" : undefined;
            return new Response(renderLoginPage(error), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }),
        ),
      POST: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* CurrentRequest;
            const shopify = yield* Shopify;
            const result = yield* shopify.login(request);
            if (result instanceof Response) {
              return result;
            }
            const error =
              result.shop === "invalid" ? "Invalid shop domain" : undefined;
            return new Response(renderLoginPage(error), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }),
        ),
    },
  },
});
