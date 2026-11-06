import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const linkHtml = `<p>Read the <a href="https://example.com/launch?ref=mail">launch notes</a>.</p>`;

test("copies a link from the email context menu", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-context-menu-e2e-"));
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
    const thread = await page.evaluate(async () => {
      const { items } = await window.fluxmail.mail.listThreads({ view: "inbox" });
      const welcome = items.find((item) => item.subject === "Welcome to Fluxmail")!;
      return window.fluxmail.mail.getThread({
        accountId: welcome.accountId,
        threadId: welcome.id,
      });
    });
    thread.messages[0].body = { html: linkHtml };
    await electronApp.evaluate(({ clipboard, ipcMain, Menu }, fixture) => {
      ipcMain.removeHandler("fluxmail:mail:thread");
      ipcMain.handle("fluxmail:mail:thread", () => fixture);
      clipboard.clear();
      // Native menus block the test, so record the menu and run "Copy Link" instead of showing it.
      const state = globalThis as typeof globalThis & { contextMenuLabels?: string[] };
      Menu.prototype.popup = function popup(this: Electron.Menu) {
        state.contextMenuLabels = this.items.map((item) => item.label);
        const copyLink = this.items.find((item) => item.label === "Copy Link");
        Reflect.apply(copyLink!.click, copyLink, [copyLink, undefined, {}]);
      };
    }, thread);
    await page
      .locator(".thread-row")
      .filter({ hasText: "Welcome to Fluxmail" })
      .locator(".thread-open")
      .click();

    await page
      .frameLocator('iframe[title="Email message"]')
      .getByRole("link", { name: "launch notes" })
      .click({ button: "right" });

    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("https://example.com/launch?ref=mail");
    expect(
      await electronApp.evaluate(
        () =>
          (globalThis as typeof globalThis & { contextMenuLabels?: string[] }).contextMenuLabels,
      ),
    ).toEqual(expect.arrayContaining(["Open Link in Browser", "Copy Link"]));
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("acts on conversations from the thread list context menu", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-thread-menu-e2e-"));
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
    await electronApp.evaluate(({ Menu }) => {
      const state = globalThis as typeof globalThis & { nativeMenuShown?: boolean };
      Menu.prototype.popup = function popup() {
        state.nativeMenuShown = true;
      };
    });
    const rows = page.locator(".thread-row");
    const first = rows.nth(0);
    const second = rows.nth(1);
    const firstSubject = await first.locator(".subject-line").innerText();
    const secondSubject = await second.locator(".subject-line").innerText();
    const menu = page.getByRole("menu", { name: "Conversation actions" });

    await first.locator(".thread-open").click({ button: "right" });
    await expect(menu).toBeVisible();
    await expect(first).toHaveClass(/context-open/);
    await expect(page.locator(".reading-placeholder")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await first.locator(".thread-open").click({ button: "right" });
    await menu.getByRole("menuitem", { name: /^Star/ }).click();
    await expect(menu).toHaveCount(0);
    await expect(first.getByRole("button", { name: "Unstar conversation" })).toBeAttached();

    const third = rows.nth(2);
    await third.locator(".thread-open").click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Reply", exact: true }).click();
    await expect(page.locator(".quick-reply")).toBeVisible();
    await expect(page.locator(".quick-reply").getByText("Write a reply")).toBeVisible();
    await expect(third).toHaveClass(/active/);

    await first.locator(".row-check").click();
    await second.locator(".row-check").click();
    await second.locator(".thread-open").click({ button: "right" });
    await expect(menu.getByText("2 conversations")).toBeVisible();
    await menu.getByRole("menuitem", { name: /^Archive/ }).click();
    await expect(page.getByText("2 conversations archived")).toBeVisible();
    await expect(rows.filter({ hasText: firstSubject })).toHaveCount(0);
    await expect(rows.filter({ hasText: secondSubject })).toHaveCount(0);

    expect(
      await electronApp.evaluate(
        () => (globalThis as typeof globalThis & { nativeMenuShown?: boolean }).nativeMenuShown,
      ),
    ).toBeUndefined();
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
