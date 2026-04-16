import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

/**
 * Vite's `server.allowedHosts` expects hostnames (no scheme/path).
 * Shopify CLI tunnels rotate hostnames on each `shopify app dev` run, and may provide
 * either bare hosts or full URLs through `HOST`/`APP_URL`/`SHOPIFY_APP_URL`.
 *
 * This helper normalizes both shapes to a hostname and safely ignores invalid values.
 */
const parseAllowedHost = (value: string | undefined) => {
  if (!value) {
    return;
  }
  const normalized =
    value.startsWith("http://") || value.startsWith("https://")
      ? value
      : `https://${value}`;
  return URL.canParse(normalized) ? new URL(normalized).hostname : undefined;
};

/**
 * Keep local and tunnel preview hosts accepted by Vite's host check.
 * Without this, Shopify preview requests can fail with:
 * `Blocked request. This host (....trycloudflare.com) is not allowed.`
 */
const allowedHosts = [
  "localhost",
  "127.0.0.1",
  ".trycloudflare.com",
  parseAllowedHost(process.env.HOST),
  parseAllowedHost(process.env.APP_URL),
  parseAllowedHost(process.env.SHOPIFY_APP_URL),
].flatMap((host) => (host ? [host] : []));

const config = defineConfig({
  server: {
    allowedHosts,
  },
  // `vite-tsconfig-paths` should cover `@/*`, but Vite's dependency scan / SSR pre-bundling
  // doesn't always apply that resolver. This explicit alias ensures `@/…` imports resolve
  // consistently during optimizeDeps and SSR module execution.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      external: ["node:stream", "node:stream/web", "node:async_hooks"],
    },
  },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact({
      babel: {
        plugins: [
          ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
        ],
      },
    }),
  ],
});

export default config;
