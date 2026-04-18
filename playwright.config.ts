import { defineConfig } from "@playwright/test";
import path from "path";

try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch (_error) {
  void _error;
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/*.setup.ts", "**/*.spec.ts"],
  outputDir: "./playwright/test-results",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "./playwright/report" }]],
  use: {
    trace: "on-first-retry",
  },
});
