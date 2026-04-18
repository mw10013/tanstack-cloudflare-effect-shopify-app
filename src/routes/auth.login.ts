import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { Request as AppRequest } from "@/lib/Request";
import { Shopify } from "@/lib/Shopify";

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
            const request = yield* AppRequest;
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
            const request = yield* AppRequest;
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
