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

export function AppProvider(props: AppProviderProps) {
  return (
    <>
      {props.embedded && <AppBridge apiKey={props.apiKey} />}
      <script src={POLARIS_URL} />
      {props.children}
    </>
  );
}
