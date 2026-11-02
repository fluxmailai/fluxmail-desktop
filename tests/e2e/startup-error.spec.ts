import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";

test("asks for an update when the shared store is newer than this version", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-startup-error-e2e-"));
  const fluxmailDirectory = path.join(dataDirectory, ".fluxmail");
  const dbPath = path.join(fluxmailDirectory, "fluxmail.db");
  mkdirSync(fluxmailDirectory);
  const store = new DatabaseSync(dbPath);
  store.exec("PRAGMA user_version = 9999");
  store.close();

  const electronApp = await electron.launch({
    args: ["--use-mock-keychain", process.cwd()],
    env: {
      ...process.env,
      FLUXMAIL_DESKTOP_E2E_HEADLESS: "1",
      FLUXMAIL_DESKTOP_TEST_DATA_DIR: dataDirectory,
      FLUXMAIL_DATA_DIR: fluxmailDirectory,
      FLUXMAIL_DB_PATH: dbPath,
      FLUXMAIL_TELEMETRY: "0",
    },
  });
  const electronProcess = electronApp.process();

  try {
    const page = await electronApp.firstWindow();
    await expect(page.getByRole("heading", { name: "Update Fluxmail to continue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    const exited = new Promise((resolve) => electronProcess.once("exit", resolve));
    await electronApp.evaluate(({ app }) => app.quit());
    await exited;
  } finally {
    electronProcess.kill();
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
