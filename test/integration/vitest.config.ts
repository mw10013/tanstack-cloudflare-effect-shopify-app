/* oxlint-disable */
import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const rootDir = path.resolve(import.meta.dirname, "../..");
  const migrationsPath = path.join(rootDir, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    root: rootDir,
    plugins: [
      cloudflareTest({
        main: "./src/test-worker.ts",
        remoteBindings: false,
        wrangler: {
          configPath: path.join(rootDir, "wrangler.jsonc"),
        },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
      tsconfigPaths({
        projects: [path.join(rootDir, "tsconfig.json")],
      }),
      tanstackStart(),
      viteReact({
        babel: {
          plugins: [
            ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.join(rootDir, "src"),
      },
    },
    test: {
      // TanStack server-fn RPC helpers read `process.env.TSS_SERVER_FN_BASE` at
      // runtime when building their request URL, so the worker test env must
      // inject it for direct RPC calls used by integration tests.
      env: {
        TSS_SERVER_FN_BASE: process.env.TSS_SERVER_FN_BASE ?? "/_serverFn/",
      },
      include: ["test/integration/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
      testTimeout: 30000,
    },
  };
});
