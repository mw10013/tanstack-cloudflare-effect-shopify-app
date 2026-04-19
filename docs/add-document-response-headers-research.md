# `addDocumentResponseHeaders` on HTML responses - research

## Question

At `src/worker.ts:137`, why call `addDocumentResponseHeaders` only for `text/html` responses?
What problem does it solve, and what happens if we skip it?

## Short answer

- It adds Shopify-required iframe/CSP headers on document responses.
- It protects embedded apps from clickjacking issues and ensures the app is frame-embeddable in allowed Shopify admin origins.
- It is scoped to `text/html` because those are document responses loaded in the iframe.
- The mutate-then-new-`Response` pattern is expected in Workers: clone/mutate headers, then return a new response.

## Grounding from Shopify docs and template

From Shopify App React Router docs:

`refs/shopify-docs/docs/api/shopify-app-react-router/v1/entrypoints/shopifyapp.md:2110`

> Adds the required Content Security Policy headers for Shopify apps to the given Headers object.

`refs/shopify-docs/docs/api/shopify-app-react-router/v1/entrypoints/shopifyapp.md:2483`

> Add headers to all HTML requests by calling `shopify.addDocumentResponseHeaders` in `entry.server.tsx`.

From Shopify app template:

`refs/shopify-app-template/app/entry.server.tsx:17`

```tsx
addDocumentResponseHeaders(request, responseHeaders);
```

and it sets HTML content type on the document response:

`refs/shopify-app-template/app/entry.server.tsx:34`

```tsx
responseHeaders.set("Content-Type", "text/html");
```

From Shopify package docs:

`refs/shopify-app-js/packages/apps/shopify-app-remix/README.md:141-145`

> your app will need to add the required `Content-Security-Policy` header directives ...
> You should return these headers from any endpoint that renders HTML in your app.

## What `addDocumentResponseHeaders` actually does

Upstream implementation mutates the passed `Headers` object in place:

`refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/add-response-headers.ts:24-45`

- sets `Link` preconnect/preload headers (Shopify CDN/App Bridge/Polaris) when `shop` exists
- sets `Content-Security-Policy` with `frame-ancestors ...` for embedded apps
- sets `frame-ancestors 'none'` for non-embedded apps

Clickjacking intent is explicit in Shopify's Express CSP docs:

`refs/shopify-app-js/packages/apps/shopify-app-express/docs/reference/cspHeaders.md:3`

> ... set correctly to prevent clickjacking attacks.

Also grounded in Shopify docs text about `frame-ancestors` for clickjacking defense:

`refs/shopify-docs/docs/apps/build/payments/credit-card/use-the-cli.md:717`

> To defend against clickjacking, Shopify sets the `frame-ancestors` directive ...

## Why only for `text/html`

In this repo:

`src/worker.ts:132-134`

```ts
if (!response.headers.get("content-type")?.startsWith("text/html")) {
  return response;
}
```

Reason:

- `addDocumentResponseHeaders` is a document-level policy concern.
- Shopify guidance says apply it to HTML document requests.
- JSON/API/webhook/static asset responses are not app documents rendered in Shopify admin iframe.
- Scoping avoids unnecessary policy/header mutation on non-document traffic.

## What happens if we do not add it

Practical outcomes:

1. Missing Shopify-required CSP header behavior on HTML routes.
2. Embedded framing policy can be wrong or absent:
   - too strict and app can fail to frame in admin (browser blocks due to CSP `frame-ancestors`)
   - too loose and app is more exposed to clickjacking framing risks
3. You also lose the `Link` preconnect/preload hints added by Shopify helper.

## Why the current worker code looks "mutate then recreate"

Current code:

`src/worker.ts:135-142`

```ts
const headers = new Headers(response.headers);
yield* shopify.addDocumentResponseHeaders(request, headers);
return new Response(response.body, {
  status: response.status,
  statusText: response.statusText,
  headers,
});
```

This is intentional and standard for Fetch/Workers responses:

- `shopify.addDocumentResponseHeaders` expects a mutable `Headers` object and mutates it.
- We create `new Headers(response.headers)` as a mutable copy.
- We return a new `Response` carrying original body/status/statusText plus updated headers.

Cloudflare docs describe this clone-and-return-new-response pattern for immutable responses:

`refs/cloudflare-docs/src/content/docs/pages/how-to/add-custom-http-headers.mdx:23`

> The response a Worker receives is immutable ... clone the response and modify the headers on a new `Response` instance.

## Notes specific to this repo

Our wrapper in `src/lib/Shopify.ts:256-261` sanitizes `shop` from query params and applies headers only when `shop` exists.
That means if `shop` is absent, no CSP/Link header is added by this helper for that response.

This is close to upstream for embedded-app flow (where `shop` is expected), but different from upstream's non-embedded fallback (`frame-ancestors 'none'`).
