import { defineConfig } from "@playwright/test";
import path from "path";
import { storageStatePath } from "./e2e/storage-state";

try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch (_error) {
  void _error;
}

try {
  process.loadEnvFile(path.join(process.cwd(), ".env.playwright"));
} catch (_error) {
  void _error;
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./playwright/test-results",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "./playwright/report" }]],
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "setup",
      testMatch: ["**/*.setup.ts"],
      use: {
        channel: "chrome",
      },
    },
    {
      name: "e2e",
      testMatch: ["**/*.spec.ts"],
      dependencies: ["setup"],
      use: {
        channel: "chrome",
        storageState: storageStatePath,
      },
    },
  ],
});
