import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { AppProvider } from "@/components/AppProvider";
import { authenticateAdmin, getShopifyAppConfig } from "@/lib/Shopify";

const authenticateAppRoute = createServerFn({ method: "GET" })
  .inputValidator(
    (input: {
      readonly searchStr: string;
      readonly pathname: string;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const config = getShopifyAppConfig();
    const request = new Request(
      `${config.appUrl}${data.pathname}${data.searchStr}`,
    );

    try {
      const result = await authenticateAdmin({ request, env: context.env });
      return {
        apiKey: config.apiKey,
        shop: result.session.shop,
      } as const;
    } catch (error) {
      if (error instanceof Response) {
        const location =
          error.headers.get("Location") ?? error.headers.get("location");
        if (location) {
          return { redirect: location } as const;
        }
      }
      throw error;
    }
  },
);

export const Route = createFileRoute("/app")({
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
  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/additional">Additional page</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}
