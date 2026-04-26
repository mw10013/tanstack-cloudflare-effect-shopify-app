/**
 * JSX types for Polaris web components + App Bridge elements used in this
 * `/app` subtree.
 *
 * Polaris activation: `@shopify/polaris-types` is listed in `tsconfig.json`
 * `compilerOptions.types` identically to the template
 * (`refs/shopify-app-template/tsconfig.json:19`). Template runs on React 18
 * where `JSX` is a global namespace, so the package's
 * `declare global { namespace JSX }` blocks take effect from a triple-slash
 * reference alone. This port uses `@types/react` 19 which scopes `JSX` inside
 * the `react` module, so only the package's `declare module 'react'` blocks
 * apply — and module augmentations only fire when the containing module is
 * imported from a runtime file. The type-only import below activates it
 * (`import type` is erased, so Vite never tries to resolve the package, which
 * ships only a `types` export condition). The empty `{}` specifier is
 * rejected by oxlint's `unicorn/require-module-specifiers`; disabled inline
 * since there's no value to import — we only need the side effect of
 * TypeScript loading the module for its augmentation.
 *
 * App Bridge activation: `s-app-nav` is not covered by `@shopify/polaris-types`
 * (it's an App Bridge element). Template uses it untyped and accepts the
 * error (`refs/shopify-app-template/app/routes/app.tsx:20-23`); we augment it
 * locally so this subtree typechecks.
 */
// oxlint-disable-next-line unicorn/require-module-specifiers -- see JSDoc above
import type {} from "@shopify/polaris-types";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Redacted } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { AppProvider } from "@/components/AppProvider";
import { Shopify } from "@/lib/Shopify";

declare module "react" {
  // oxlint-disable-next-line typescript-eslint/no-namespace -- canonical JSX augmentation pattern
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

/**
 * Route-boundary Shopify auth for `/app` document requests.
 *
 * Rebuilds an absolute app URL from router pathname/search, runs
 * `shopify.authenticateAdmin`, and preserves auth control flow via
 * `runEffect` failures.
 *
 * Redirect nuance:
 * - `Shopify.authenticateAdmin` returns plain `Response.redirect(...)` values.
 * - TanStack router redirect control flow only recognizes redirects created by
 *   `redirect(...)` (redirect `Response` with router metadata).
 * - So redirect Responses are mapped to `redirect({ href })`; non-redirect
 *   Responses are failed through unchanged.
 *
 * Successful auth returns route context with `apiKey` and authenticated `shop`.
 */
const authenticateAppRoute = createServerFn({ method: "GET" })
  .inputValidator(
    (input: {
      readonly searchStr: string;
      readonly pathname: string;
    }) => input,
  )
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const request = yield* CurrentRequest;
        const appRequest = new Request(
          `${shopify.config.appUrl}${data.pathname}${data.searchStr}`,
          {
            method: request.method,
            headers: request.headers,
          },
        );
        const auth = yield* shopify.authenticateAdmin(appRequest);

        if (auth instanceof Response) {
          const location = auth.headers.get("Location") ?? auth.headers.get("location");
          if (location) return yield* Effect.fail(redirect({ href: location }));
          return yield* Effect.fail(auth);
        }

        return {
          apiKey: Redacted.value(shopify.config.apiKey),
          shop: auth.session.shop,
        } as const;
      }),
    ),
);

export const Route = createFileRoute("/app")({
  /**
   * Enforces auth at the `/app` layout boundary before child routes load.
   *
   * Throws TanStack `redirect(...)` when Shopify auth indicates a redirect
   * (login/embed/session-token bounce). Otherwise returns auth context for the
   * `/app` subtree.
   */
  beforeLoad: async ({ location }) => {
    return authenticateAppRoute({
      data: {
        searchStr: location.searchStr,
        pathname: location.pathname,
      },
    });
  },
  component: AppLayout,
});

function AppLayout() {
  const { apiKey } = Route.useRouteContext();
  const { searchStr } = useLocation();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href={`/app${searchStr}`}>Home</s-link>
        <s-link href={`/app/additional${searchStr}`}>Additional page</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}
