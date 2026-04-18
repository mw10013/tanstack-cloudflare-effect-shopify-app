import { defineConfig, devices } from "@playwright/test";
import path from "path";

try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch (_error) {
  void _error;
}

const storageStatePath = path.join(
  process.cwd(),
  "playwright",
  ".auth",
  "shopify-admin.json",
);

export default defineConfig({
  testDir: "./playwright/tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: storageStatePath },
    },
  ],
});
