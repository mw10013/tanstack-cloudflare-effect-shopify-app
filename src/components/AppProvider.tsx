import * as React from "react";
import { useNavigate } from "@tanstack/react-router";

const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";

function AppBridge({ apiKey }: { readonly apiKey: string }) {
  const navigate = useNavigate();

  React.useEffect(() => {
    const handleNavigate = (event: Event) => {
      const href = (event.target as HTMLElement)?.getAttribute("href");
      if (href) {
        void navigate({ to: href });
      }
    };

    document.addEventListener("shopify:navigate", handleNavigate);
    return () => {
      document.removeEventListener("shopify:navigate", handleNavigate);
    };
  }, [navigate]);

  return <script src={APP_BRIDGE_URL} data-api-key={apiKey} />;
}

type AppProviderProps =
  | { readonly embedded: true; readonly apiKey: string; readonly children: React.ReactNode }
  | { readonly embedded?: false; readonly children: React.ReactNode };

/**
 * App-level provider for Shopify App Bridge + Polaris in this TanStack port.
 *
 * What it is:
 * - A thin TanStack Router adapter of Shopify's React Router AppProvider.
 * - Kept local because `@shopify/shopify-app-react-router/react` depends on
 *   React Router hooks.
 *
 * What it provides:
 * - Injects Shopify App Bridge script (`app-bridge.js`) with `data-api-key`.
 * - Injects Polaris web components script (`polaris.js`).
 * - Bridges `shopify:navigate` events into TanStack SPA navigation.
 *
 * `embedded` behavior:
 * - `embedded: true` means the route is running inside Shopify Admin iframe.
 * - In embedded mode we must load App Bridge so `window.shopify` exists and
 *   APIs like toast/intents/idToken are available.
 * - When not embedded, App Bridge script is intentionally skipped.
 */
export function AppProvider(props: AppProviderProps) {
  return (
    <>
      {props.embedded && <AppBridge apiKey={props.apiKey} />}
      <script src={POLARIS_URL} />
      {props.children}
    </>
  );
}
