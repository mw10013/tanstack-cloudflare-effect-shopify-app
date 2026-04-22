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

import { Request as AppRequest } from "@/lib/Request";
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
 * `shopify.authenticateAdmin`, and normalizes redirect Responses into
 * `{ redirect }` for `beforeLoad` to throw via TanStack `redirect(...)`.
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
  .handler(async ({ data, context: { runEffect } }) => {
    const result = await runEffect(
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const request = yield* AppRequest;
        const appRequest = new Request(
          `${shopify.config.appUrl}${data.pathname}${data.searchStr}`,
          {
            method: request.method,
            headers: request.headers,
          },
        );
        const authResult = yield* shopify.authenticateAdmin(appRequest);
        return authResult instanceof Response
          ? authResult
          : {
              apiKey: Redacted.value(shopify.config.apiKey),
              shop: authResult.session.shop,
            } as const;
      }),
    );
    if (result instanceof Response) {
      const location =
        result.headers.get("Location") ?? result.headers.get("location");
      if (location) {
        return { redirect: location } as const;
      }
      throw new Error(
        `Unexpected Shopify auth response: ${String(result.status)}`,
      );
    }
    return result;
  },
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
    const result = await authenticateAppRoute({
      data: {
        searchStr: location.searchStr,
        pathname: location.pathname,
      },
    });

    if ("redirect" in result) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ href: result.redirect });
    }

    return result;
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
