# auth.login route: renderLoginPage vs React component

## What's there now

`src/routes/auth.login.ts` is a pure server-route file (`.ts`, no `.tsx`). Both GET and POST handlers call `Shopify.login()` and return either a raw `Response.redirect()` or a raw `new Response(renderLoginPage(error), ...)` where `renderLoginPage` is a tagged-template HTML string.

```ts
const renderLoginPage = (error?: string) => `<!doctype html>
<html>…
  <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>
  <s-page><form method="post" action="/auth/login">…</form></s-page>
…</html>`;

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: ({ context: { runEffect } }) => runEffect(…),
      POST: ({ context: { runEffect } }) => runEffect(…),
    },
  },
  // no component
});
```

There is no `component`, no `loader`, and no React rendering.

---

## What the template does

`refs/shopify-app-template/app/routes/auth.login/route.tsx` is a React Router route with:
- A `loader` that calls `login(request)` and returns `{ errors }`
- An `action` that does the same for POST form submissions
- A default React component that uses `useLoaderData` / `useActionData` and renders inside `<AppProvider embedded={false}>` (which injects the Polaris script)

```tsx
// refs/shopify-app-template/app/routes/auth.login/route.tsx
export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export default function Auth() {
  const { errors } = useActionData() || useLoaderData();
  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post">…</Form>
      </s-page>
    </AppProvider>
  );
}
```

The `AppProvider embedded={false}` from `@shopify/shopify-app-react-router/react` injects only `polaris.js` (no App Bridge):

```tsx
// refs/shopify-app-js/…/AppProvider/AppProvider.tsx
export function AppProvider(props: AppProviderProps) {
  return (
    <>
      {props.embedded && <AppBridge apiKey={props.apiKey} />}
      <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
      {props.children}
    </>
  );
}
```

---

## Why the port diverged

### 1. Shopify's `AppProvider` is React Router-coupled

`AppProvider` from `@shopify/shopify-app-react-router/react` calls `useNavigate` from `react-router`:

```tsx
// refs/shopify-app-js/…/AppProvider/AppProvider.tsx
import {useNavigate} from 'react-router'; // ← React Router hook
function AppBridge({apiKey}) {
  const navigate = useNavigate();
  …
}
```

It cannot be imported into a TanStack Start route. The port already has a TanStack-aware substitute at `src/components/AppProvider.tsx` using `useNavigate` from `@tanstack/react-router`, but it was not wired into the login route.

### 2. The login flow is a redirect machine, not a page

`Shopify.login()` returns `Response.redirect()` for any valid shop domain (GET with `?shop=` or POST with body). It only falls back to showing the form when no shop is present (GET, no param) or when the shop is invalid. The dominant path is "receive request → redirect to Shopify OAuth". Using `server.handlers` and returning raw `Response` objects matches this shape directly.

### 3. React Router's `loader`/`action` don't exist in TanStack Start

TanStack Start has `loader` (data fetching, parallel, runs after `beforeLoad`) and `server.handlers` (raw HTTP). It has no `action` concept. POST form handling normally goes through a `createServerFn` or a `server.handlers.POST`. The template's `action` pattern has no direct TanStack equivalent, which breaks the straightforward port.

### 4. Error state bridging is awkward without `action`

The template passes error state via `useActionData()` — same-request data that doesn't survive a redirect. In TanStack Start, the natural substitute is a search param (`?error=invalid`) or a `createServerFn`. The port avoided this by rendering the error inline in the raw HTML response, which is simpler.

---

## What idiomatic TanStack Start would look like

TanStack Start explicitly supports mixing `server.handlers` with a `component` in the same file (`.tsx`):

```tsx
// refs/tan-start/docs/start/framework/react/guide/server-routes.md
export const Route = createFileRoute('/hello')({
  server: {
    handlers: {
      POST: async ({ request }) => { … return new Response(…) },
    },
  },
  component: HelloComponent,
})
```

An idiomatic port would:

1. Keep `server.handlers.GET` and `server.handlers.POST` for the redirect case (valid shop → `Response.redirect()`).
2. On invalid/missing shop, redirect back to `/auth/login?error=invalid` (or similar) instead of returning raw HTML.
3. Add a `component` that reads `?error` from search params and renders the form using Polaris web components inside the port's own `AppProvider`.

```tsx
// hypothetical idiomatic version
export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const request = yield* AppRequest;
            const shopify = yield* Shopify;
            const result = yield* shopify.login(request);
            if (result instanceof Response) return result;
            const error = result.shop === "invalid" ? "invalid" : undefined;
            return Response.redirect(
              `/auth/login${error ? "?error=" + error : ""}`,
            );
          }),
        ),
      POST: // same shape
    },
  },
  validateSearch: (search) => ({
    error: (search.error as string | undefined),
  }),
  component: LoginComponent,
});

function LoginComponent() {
  const { error } = Route.useSearch();
  return (
    <AppProvider>
      <s-page>
        <form method="post" action="/auth/login">
          <s-section heading="Log in">
            <s-text-field
              name="shop"
              label="Shop domain"
              details="example.myshopify.com"
              autocomplete="on"
              error={error === "invalid" ? "Invalid shop domain" : undefined}
            />
            <s-button type="submit">Log in</s-button>
          </s-section>
        </form>
      </s-page>
    </AppProvider>
  );
}
```

The `AppProvider` here would be the local one from `src/components/AppProvider.tsx` with `embedded` omitted/false, which only loads `polaris.js`.

---

## Summary

| | Template (React Router) | Port (current) | Idiomatic TanStack Start |
|---|---|---|---|
| GET/POST handling | `loader` + `action` | `server.handlers.GET/POST` | `server.handlers.GET/POST` |
| Form UI | React component via `useLoaderData`/`useActionData` | Raw HTML string (`renderLoginPage`) | React `component` + `useSearch()` |
| Error passing | `useActionData()` same-request | Inline in HTML response | Search param (`?error=invalid`) |
| Polaris script | `<AppProvider embedded={false}>` | Inlined in HTML template | Port's `AppProvider` |
| File extension | `.tsx` | `.ts` | `.tsx` |

The current approach is functional but non-idiomatic. The login page bypasses React/TanStack entirely and returns raw HTML. The primary reason is the redirect-heavy nature of the Shopify login flow combined with the absence of React Router's `action` concept in TanStack Start. The port could be refactored to use a `component` with error state via search params.
