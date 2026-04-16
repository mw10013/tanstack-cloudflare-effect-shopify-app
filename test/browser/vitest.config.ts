/* oxlint-disable */
import path from "node:path";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const rootDir = path.resolve(import.meta.dirname, "../..");
const headless = process.env.VITEST_BROWSER_HEADLESS !== "false";

export default defineConfig({
  root: rootDir,
  plugins: [
    tsconfigPaths({
      projects: [path.join(rootDir, "tsconfig.json")],
    }),
    tanstackStart(),
    viteReact({
      babel: {
        plugins: [["@babel/plugin-proposal-decorators", { version: "2023-11" }]],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.join(rootDir, "src"),
    },
  },
  test: {
    browser: {
      enabled: true,
      headless,
      instances: [
        {
          browser: "chromium",
          viewport: { width: 1280, height: 800 },
        },
      ],
      provider: playwright(),
    },
    include: ["test/browser/**/*.test.{ts,tsx}"],
    testTimeout: 30000,
  },
});
