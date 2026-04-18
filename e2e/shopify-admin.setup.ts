import { test as setup } from "@playwright/test";
import * as fs from "fs";
import path from "path";
import { requiredEnv } from "./env";
import { storageStatePath } from "./storage-state";

setup("shopify admin auth", async ({ page }) => {
  setup.setTimeout(15 * 60 * 1000);
  await fs.promises.mkdir(path.dirname(storageStatePath), { recursive: true });

  try {
    await fs.promises.stat(storageStatePath);
    return;
  } catch (_error) {
    void _error;
  }

  if (process.env.CI) {
    throw new Error(
      `Missing ${storageStatePath}. Run locally (non-CI) once to complete manual login ` +
        "and produce storage state; delete the file to re-bootstrap.",
    );
  }

  await page.goto(requiredEnv("SHOPIFY_PREVIEW_URL"));
  await page.pause();
  await page.context().storageState({ path: storageStatePath });
});
