import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

// The divider cells each request 50% of the width; the heading's nowrap supplies its minimum width.
const digestHtml = `<table style="width:100%;max-width:600px;margin:0 auto">
  <tr><td><div style="padding:0 20px">
    <table width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
      <tr>
        <td style="width:50%;vertical-align:middle"><div style="height:1px;background:#d1d5db"></div></td>
        <td style="text-align:center;white-space:nowrap;padding:0 16px;vertical-align:middle">
          <a href="https://example.com" style="font-size:1.15em;font-weight:600;color:#111827;text-decoration:none">Fluxmail</a>
        </td>
        <td style="width:50%;vertical-align:middle"><div style="height:1px;background:#d1d5db"></div></td>
      </tr>
    </table>
  </div></td></tr>
</table>`;

test("keeps newsletter divider headings on one line", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-email-layout-e2e-"));
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
    thread.messages[0].body = { html: digestHtml };
    await electronApp.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler("fluxmail:mail:thread");
      ipcMain.handle("fluxmail:mail:thread", () => fixture);
    }, thread);
    await page
      .locator(".thread-row")
      .filter({ hasText: "Welcome to Fluxmail" })
      .locator(".thread-open")
      .click();

    const frame = page.locator('iframe[title="Email message"]');
    const heading = page
      .frameLocator('iframe[title="Email message"]')
      .getByRole("link", { name: "Fluxmail", exact: true });
    for (const width of [600, 320]) {
      await frame.evaluate((element, pixels) => {
        element.style.width = `${pixels}px`;
      }, width);
      await expect(heading).toBeVisible();
      await expect
        .poll(() => heading.evaluate((element) => element.getClientRects().length))
        .toBe(1);
      expect(
        await heading.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= window.innerWidth;
        }),
      ).toBe(true);
    }
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
