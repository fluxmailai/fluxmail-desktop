import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const subject = "ACME × Northwind: pricing for the 2026 rollout";

function messageToggleLabels(page: Page): Promise<Array<string | null>> {
  return page
    .locator(".message-header-toggle")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
}

test("collapses read messages when a conversation opens", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-thread-collapse-e2e-"));
  const electronApp = await electron.launch({
    args: ["--use-mock-keychain", process.cwd()],
    env: {
      ...process.env,
      FLUXMAIL_DESKTOP_FAKE_MAIL: "1",
      FLUXMAIL_DESKTOP_E2E_HEADLESS: "1",
      FLUXMAIL_DESKTOP_TEST_DATA_DIR: dataDirectory,
      FLUXMAIL_DATA_DIR: path.join(dataDirectory, ".fluxmail"),
      FLUXMAIL_TELEMETRY: "0",
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    const row = page.locator(".thread-row", { hasText: subject });
    await expect(row).toHaveClass(/\bunread\b/);

    // The two earlier messages were read before; the newest one is unread.
    await row.locator(".thread-open").click();
    await expect(page.locator(".message-card")).toHaveCount(3);
    expect(await messageToggleLabels(page)).toEqual([
      "Expand message",
      "Expand message",
      "Collapse message",
    ]);
    await expect(page.locator(".message-card .message-body")).toHaveCount(1);
    await expect(row).not.toHaveClass(/\bunread\b/);

    await page.getByRole("button", { name: "Expand message" }).first().click();
    await expect(page.locator(".message-card .message-body")).toHaveCount(2);

    // Reopening shows only the newest message, since every message has now been read.
    await page
      .locator(".thread-row", { hasText: "Re: Founding AE candidate, Riley Nguyen" })
      .locator(".thread-open")
      .click();
    await expect(page.getByRole("heading", { name: /Founding AE candidate/ })).toBeVisible();
    await row.locator(".thread-open").click();
    await expect(page.getByRole("heading", { name: subject })).toBeVisible();
    await expect(page.locator(".message-card")).toHaveCount(3);
    expect(await messageToggleLabels(page)).toEqual([
      "Expand message",
      "Expand message",
      "Collapse message",
    ]);
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
