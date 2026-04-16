import { createFileRoute } from "@tanstack/react-router";

import { getShopifyApi } from "@/lib/Shopify";

const renderLoginPage = (error: string | null) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Shopify Login</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; background: #f4f4f5; color: #18181b; }
      main { max-width: 34rem; margin: 0 auto; background: #fff; border: 1px solid #e4e4e7; border-radius: 0.75rem; padding: 1.25rem; }
      h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
      p { margin: 0 0 1rem; color: #52525b; }
      label { display: block; font-size: 0.875rem; margin-bottom: 0.4rem; }
      input { width: 100%; box-sizing: border-box; padding: 0.625rem 0.75rem; border: 1px solid #d4d4d8; border-radius: 0.5rem; font: inherit; }
      button { margin-top: 0.75rem; padding: 0.625rem 0.875rem; border: 1px solid #18181b; background: #18181b; color: #fff; border-radius: 0.5rem; font: inherit; cursor: pointer; }
      .error { margin-top: 0.75rem; color: #b91c1c; font-size: 0.875rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Log in to your Shopify store</h1>
      <p>Enter your shop domain to start installation/authentication.</p>
      <form method="post" action="/auth/login">
        <label for="shop">Shop domain</label>
        <input id="shop" name="shop" placeholder="example.myshopify.com" required />
        <button type="submit">Continue</button>
      </form>
      ${error ? `<p class="error">${error}</p>` : ""}
    </main>
  </body>
</html>`;

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const error = new URL(request.url).searchParams.get("error");
        return new Response(renderLoginPage(error), {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        });
      },
      POST: async ({ request }) => {
        const shopify = getShopifyApi();
        const form = await request.formData();
        const shopInput = form.get("shop");
        const shopValue = typeof shopInput === "string" ? shopInput : "";
        const shop = shopify.utils.sanitizeShop(shopValue, true);
        if (!shop) {
          return Response.redirect(
            new URL("/auth/login?error=Invalid%20shop%20domain", request.url).toString(),
            302,
          );
        }
        const destination = new URL("/auth", request.url);
        destination.searchParams.set("shop", shop);
        return Response.redirect(destination.toString(), 302);
      },
    },
  },
});
