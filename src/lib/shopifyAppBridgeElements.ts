/**
 * React 19 JSX bridge for Shopify App Bridge web components.
 *
 * `@shopify/app-bridge-types` provides the public element typings, including
 * `s-app-nav` and `ui-save-bar`, but exposes them through global `JSX`.
 * This app's TSX files use React's module-scoped JSX lookup, so the global
 * Shopify entries are not picked up automatically. Import this module from
 * TSX files that render raw App Bridge elements to copy Shopify's official
 * global entries into React's JSX namespace without retyping the attributes.
 */
// oxlint-disable-next-line unicorn/require-module-specifiers -- loads Shopify's global JSX augmentation only
import type {} from "@shopify/app-bridge-types";

declare module "react" {
  // oxlint-disable-next-line typescript-eslint/no-namespace -- canonical JSX augmentation pattern
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": globalThis.JSX.IntrinsicElements["s-app-nav"];
      "ui-save-bar": globalThis.JSX.IntrinsicElements["ui-save-bar"];
    }
  }
}
