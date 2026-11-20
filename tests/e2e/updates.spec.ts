import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

async function launch(fakeUpdates?: string) {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-updates-e2e-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FLUXMAIL_DESKTOP_FAKE_MAIL: "1",
    FLUXMAIL_DESKTOP_E2E_HEADLESS: "1",
    FLUXMAIL_DESKTOP_TEST_DATA_DIR: dataDirectory,
    FLUXMAIL_DATA_DIR: path.join(dataDirectory, ".fluxmail"),
    FLUXMAIL_TELEMETRY: "0",
  };
  delete env.FLUXMAIL_DESKTOP_FAKE_UPDATES;
  if (fakeUpdates) {
    env.FLUXMAIL_DESKTOP_FAKE_UPDATES = fakeUpdates;
    // Long enough that a slow runner still sees the checking and downloading states.
    env.FLUXMAIL_DESKTOP_FAKE_UPDATE_DELAY_MS = "2500";
  }
  const electronApp = await electron.launch({
    args: ["--use-mock-keychain", process.cwd()],
    env,
  });
  const page = await electronApp.firstWindow();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  return {
    electronApp,
    page,
    cleanup: async () => {
      await electronApp.close().catch(() => undefined);
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

test("finds an update from Settings, shows it in the sidebar, and restarts to install it", async () => {
  test.setTimeout(60_000);
  const { electronApp, page, cleanup } = await launch("current,available");
  try {
    const settings = page.getByRole("dialog", { name: "Settings" });
    const sidebar = page.locator(".sidebar");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings.getByText("You have the latest version.")).toBeVisible();
    await expect(sidebar.getByText("Downloading update")).toHaveCount(0);

    await settings.getByRole("button", { name: "Check for updates" }).click();

    await expect(settings.getByRole("button", { name: "Checking..." })).toBeDisabled();
    await expect(settings.getByRole("button", { name: "Downloading..." })).toBeDisabled();
    await expect(sidebar.getByRole("status")).toHaveText("Downloading update");
    await expect(
      settings.getByText("Version 99.0.0 is ready. Restart Fluxmail to install it."),
    ).toBeVisible();
    await settings.getByRole("button", { name: "Close settings" }).click();
    const restart = sidebar.getByRole("button", { name: "Restart to update" });
    await expect(restart).toBeVisible();
    await expect(sidebar.getByText("Downloading update")).toHaveCount(0);

    const closed = electronApp.waitForEvent("close");
    await restart.click();
    await closed;
  } finally {
    await cleanup();
  }
});

test("keeps a failed background check quiet and reports a failed manual check", async () => {
  const { page, cleanup } = await launch("error");
  try {
    const settings = page.getByRole("dialog", { name: "Settings" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      settings.getByText("Fluxmail checks for updates in the background."),
    ).toBeVisible();

    await settings.getByRole("button", { name: "Check for updates" }).click();

    await expect(settings.getByRole("alert")).toHaveText(
      "Fluxmail couldn't check for updates. Check your internet connection and try again.",
    );
    await expect(settings.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  } finally {
    await cleanup();
  }
});

test("reports a failed download that the sidebar was showing", async () => {
  const { page, cleanup } = await launch("download-error");
  try {
    await expect(page.locator(".sidebar").getByRole("status")).toHaveText("Downloading update");
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("alert")).toHaveText(
      "Fluxmail couldn't download the update. Try again later.",
    );
    await expect(page.locator(".sidebar").getByText("Downloading update")).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("explains that a development build can't install updates", async () => {
  const { page, cleanup } = await launch();
  try {
    const settings = page.getByRole("dialog", { name: "Settings" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    await expect(settings.getByText("Development builds can't install updates.")).toBeVisible();
    await expect(settings.getByRole("button", { name: "Check for updates" })).toBeDisabled();
  } finally {
    await cleanup();
  }
});
