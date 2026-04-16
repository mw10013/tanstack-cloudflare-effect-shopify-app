# Shopify Polaris research (embedded app perspective)

Scanned sources:

- `refs/shopify-docs/docs/...`
- `refs/phc/...`

## Bottom line for TanStack Start port

Polaris is important for embedded Shopify app UI, but it is a later-stage concern when porting to TanStack Start.

Reason: in Shopify's React Router stack, the "app plumbing" comes first (embedded auth context + App Bridge wiring), and Polaris is layered onto that.

Evidence:

- `refs/shopify-docs/docs/apps/build/admin.md:27`

  > "By combining App Bridge and Polaris, you can make your app display seamlessly in the Shopify admin."

- `refs/shopify-docs/docs/apps/build/app-surfaces.md:27`

  > "App Bridge handles communication between your app and the Shopify admin, while Polaris provides the UI components ..."

## What Polaris is in embedded apps

Polaris is Shopify's unified UI system for app interfaces.

Evidence:

- `refs/shopify-docs/docs/apps/build/app-surfaces.md:15`

  > "All UI surfaces share Polaris, Shopify's unified system for building app interfaces."

- `refs/shopify-docs/docs/apps/build/build.md:981`

  > "Polaris is Shopify's unified system for building app interfaces."

## How embedded setup works in the official React Router ecosystem

In the official template/package, embedded app routes wrap UI in `AppProvider` with `embedded` + `apiKey`.

Evidence:

- `refs/phc/app/routes/app.tsx:4,19`

  > `import { AppProvider } from "@shopify/shopify-app-react-router/react";`
  > `<AppProvider embedded apiKey={apiKey}>`

`AppProvider` injects Polaris and App Bridge scripts for embedded routes.

- `refs/phc/refs/shopify-rr/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:99-101`

  > `{props.embedded && <AppBridge apiKey={props.apiKey} />}`
  > `<script src="https://cdn.shopify.com/shopifycloud/polaris.js" />`

- `refs/phc/refs/shopify-rr/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:129-132`

  > `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey} />`

## Why this is later-stage for TanStack Start

`@shopify/shopify-app-react-router` is explicitly a React Router package.

Evidence:

- `refs/phc/refs/shopify-rr/packages/apps/shopify-app-react-router/README.md:8`

  > "This package makes it easy to use React Router to build Shopify apps."

So, for a TanStack Start port:

1. First recreate embedded Shopify app plumbing (auth/session/App Bridge host context and embedded-safe navigation).
2. Then add Polaris (web components or React package) on top.

## Install paths relevant to embedded apps

### Path A: Polaris web components (template-style)

- Use Shopify app setup and `AppProvider` pattern from template (`refs/phc/README.md:22`, `refs/phc/app/routes/app.tsx:4,19`).
- Polaris script is loaded by provider (`refs/phc/refs/shopify-rr/packages/apps/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx:100`).

### Path B: Polaris React package

- Shopify docs reference `@shopify/polaris` in app UI examples (`refs/shopify-docs/docs/apps/build/discounts/build-ui-with-react-router.md:84`).
- Shopify docs also call out `@shopify/polaris-icons` install (`refs/shopify-docs/docs/apps/build/build.md:38`).

Typical command:

```sh
pnpm add @shopify/polaris @shopify/polaris-icons
```

## Practical recommendation for this repo

- Treat Polaris adoption as phase 2 of TanStack Start Shopify port.
- Phase 1: embedded app foundation (Shopify auth/install/session/App Bridge context).
- Phase 2: UI standardization with Polaris.
