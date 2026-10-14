import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { _electron as electron, expect, test } from "@playwright/test";

const mockKeychainArgument = "--use-mock-keychain";

test("uses the desktop bridge for the inbox, secure reading, search, compose, and settings", async () => {
  test.setTimeout(60_000);
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-e2e-"));
  writeFileSync(
    path.join(dataDirectory, "desktop-preferences.json"),
    JSON.stringify({
      version: 5,
      appearance: "system",
      dockBadge: true,
      blockRemoteImages: true,
      imageRelay: false,
      undoSendDelaySeconds: 10,
    }),
  );
  const electronApp = await electron.launch({
    args: [mockKeychainArgument, process.cwd()],
    env: {
      ...process.env,
      FLUXMAIL_DESKTOP_FAKE_MAIL: "1",
      FLUXMAIL_DESKTOP_FAKE_ARCHIVE_DELAY_MS: "600",
      FLUXMAIL_DESKTOP_E2E_HEADLESS: "1",
      FLUXMAIL_DESKTOP_TEST_DATA_DIR: dataDirectory,
      FLUXMAIL_DATA_DIR: path.join(dataDirectory, ".fluxmail"),
      // The development analytics transport remains disabled, while Settings can exercise the
      // shared preference without an environment-enforced lock.
      FLUXMAIL_TELEMETRY: "1",
    },
  });

  try {
    const page = await electronApp.firstWindow();
    expect(await electronApp.evaluate(({ app }) => app.getName())).toBe("Fluxmail");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page.getByText("Welcome to Fluxmail", { exact: true }).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('14px "Fluxmail Inter"'))).toBe(true);
    await expect(page.locator(".sidebar .brand")).toHaveCount(0);
    await expect(page.locator(".reading-placeholder .brand-mark")).toHaveCount(0);
    await expect(page.locator(".reading-placeholder")).toHaveCSS("user-select", "none");
    expect(
      await page.evaluate(() => {
        const emptyReading = document.querySelector<HTMLElement>(".empty-reading")!;
        const emptyReadingTitlebar = getComputedStyle(emptyReading, "::before");
        const sidebarTitlebar = getComputedStyle(
          document.querySelector<HTMLElement>(".sidebar-titlebar")!,
        );
        return {
          appRegion: emptyReadingTitlebar.getPropertyValue("-webkit-app-region"),
          emptyReadingHeight: emptyReadingTitlebar.height,
          sidebarHeight: sidebarTitlebar.height,
        };
      }),
    ).toEqual({ appRegion: "drag", emptyReadingHeight: "46px", sidebarHeight: "46px" });
    await expect(page.locator(".account-picker-icon")).toHaveCount(0);
    await expect(page.getByText(/connected$/)).toHaveCount(0);
    await expect(page.locator(".sidebar").getByRole("button", { name: "Receipts" })).toHaveCount(0);
    const accountPicker = page.getByRole("button", { name: "Choose account" });
    await expect(accountPicker.locator(".lucide-chevrons-up-down")).toBeVisible();
    await accountPicker.click();
    await expect(page.getByRole("menuitem", { name: "All accounts" })).toBeVisible();
    await accountPicker.click();
    await expect(page.locator(".sidebar")).toHaveCSS("user-select", "none");
    const inboxNav = page.locator(".sidebar").getByRole("button", { name: "Inbox" });
    const starredNav = page.getByRole("button", { name: "Starred" });
    await accountPicker.hover();
    await expect
      .poll(async () => {
        const [accountBackground, activeBackground] = await Promise.all([
          accountPicker.evaluate((node) => getComputedStyle(node).backgroundColor),
          inboxNav.evaluate((node) => getComputedStyle(node).backgroundColor),
        ]);
        return accountBackground === activeBackground;
      })
      .toBe(true);
    await starredNav.hover();
    await expect(inboxNav).toHaveCSS("border-top-width", "0px");
    await expect
      .poll(async () => {
        const [activeBackground, hoverBackground] = await Promise.all([
          inboxNav.evaluate((node) => getComputedStyle(node).backgroundColor),
          starredNav.evaluate((node) => getComputedStyle(node).backgroundColor),
        ]);
        return activeBackground === hoverBackground;
      })
      .toBe(true);
    await expect(page.locator(".thread-row").first()).toHaveCSS("user-select", "none");
    await expect(page.locator(".search-box")).toHaveCSS("height", "34px");
    const sidebarCompose = page.locator(".sidebar-titlebar").getByRole("button", {
      name: "Compose",
    });
    await expect(sidebarCompose).toHaveCSS("cursor", "default");
    await expect(sidebarCompose).toHaveCSS("box-shadow", "none");
    await expect(sidebarCompose.locator(".lucide-pencil")).toBeVisible();
    const sidebarSettingsButton = page.getByRole("button", {
      name: "Settings",
    });
    const [composeStyle, settingsStyle] = await Promise.all(
      [sidebarCompose, sidebarSettingsButton].map((button) =>
        button.evaluate((node) => ({
          background: getComputedStyle(node).backgroundColor,
          color: getComputedStyle(node).color,
          width: getComputedStyle(node).width,
          height: getComputedStyle(node).height,
        })),
      ),
    );
    expect(composeStyle).toEqual(settingsStyle);
    await expect(sidebarCompose).toHaveAttribute("aria-keyshortcuts", "C");
    await sidebarCompose.hover();
    const composeTooltip = page.getByRole("tooltip", { name: "Compose" });
    await expect(composeTooltip).toBeVisible();
    await expect(composeTooltip.locator("kbd")).toHaveText("C");
    await page.locator(".search-box").hover();
    const sidebarComposeLayout = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>(".sidebar")!.getBoundingClientRect();
      const compose = document
        .querySelector<HTMLElement>(".sidebar-titlebar [aria-label='Compose']")!
        .getBoundingClientRect();
      const account = document
        .querySelector<HTMLElement>(".account-picker-trigger")!
        .getBoundingClientRect();
      const search = document.querySelector<HTMLElement>(".search-box")!.getBoundingClientRect();
      return {
        width: compose.width,
        height: compose.height,
        rightInset: sidebar.right - compose.right,
        composeBottom: compose.bottom,
        composeCenterY: compose.top + compose.height / 2,
        accountTop: account.top,
        searchCenterY: search.top + search.height / 2,
      };
    });
    expect(sidebarComposeLayout).toMatchObject({
      width: 31,
      height: 31,
      rightInset: 8,
    });
    expect(sidebarComposeLayout.composeBottom).toBeLessThanOrEqual(sidebarComposeLayout.accountTop);
    expect(
      sidebarComposeLayout.accountTop - sidebarComposeLayout.composeBottom,
    ).toBeLessThanOrEqual(8);
    expect(sidebarComposeLayout.searchCenterY).toBe(sidebarComposeLayout.composeCenterY);
    const sidebarHeaderButtonOrder = await page
      .locator(".sidebar-titlebar button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    expect(sidebarHeaderButtonOrder).toEqual(["Collapse sidebar", "Compose"]);
    await expect(page.locator(".sidebar-footer").getByRole("button")).toHaveCount(1);
    await expect(
      page.locator(".sidebar-footer").getByRole("button", { name: "Settings" }),
    ).toBeVisible();
    await expect(page.getByRole("separator", { name: "Resize sidebar" })).toBeVisible();
    const sidebarNav = page.locator(".sidebar-nav");
    await expect(sidebarNav.locator(".nav-item").first()).toHaveCSS("flex-shrink", "0");
    await expect(sidebarNav.locator(".nav-item").first()).toHaveCSS("height", "36px");
    await expect(sidebarNav).toHaveCSS("scrollbar-width", "none");
    await sidebarNav.evaluate((element) => {
      let position = 0;
      Object.defineProperties(element, {
        clientHeight: { configurable: true, get: () => 100 },
        scrollHeight: { configurable: true, get: () => 500 },
        scrollTop: {
          configurable: true,
          get: () => position,
          set: (value: number) => {
            position = value;
          },
        },
      });
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator(".sidebar-fade.bottom")).toBeVisible();
    await expect(page.locator(".sidebar-fade.top")).toHaveCount(0);
    await page.locator(".sidebar-nav-wrap").hover();
    await expect(page.locator(".sidebar-nav-wrap .overlay-scrollbar")).toHaveCSS("opacity", "1");
    await sidebarNav.evaluate((element) => {
      (element as HTMLElement).scrollTop = 100;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator(".sidebar-fade.top")).toBeVisible();
    await sidebarNav.evaluate((element) => {
      Reflect.deleteProperty(element, "clientHeight");
      Reflect.deleteProperty(element, "scrollHeight");
      Reflect.deleteProperty(element, "scrollTop");
      element.dispatchEvent(new Event("scroll"));
    });
    const initialCollapseSidebar = page.getByRole("button", {
      name: "Collapse sidebar",
    });
    await expect(initialCollapseSidebar.locator(".lucide-panel-left")).toBeVisible();
    await expect(initialCollapseSidebar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.getByRole("button", { name: "Settings" })).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await initialCollapseSidebar.click();
    await expect(page.locator(".sidebar")).toHaveClass(/collapsed/);
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveCount(0);
    const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
    const headerCompose = page.locator(".header-quick-actions").getByRole("button", {
      name: "Compose",
    });
    await expect(expandSidebar).toBeVisible();
    await expect(expandSidebar.locator(".lucide-panel-left")).toBeVisible();
    await expect(headerCompose).toBeVisible();
    await expect(headerCompose.locator(".lucide-pencil")).toBeVisible();
    expect(
      await headerCompose.evaluate((node) => ({
        background: getComputedStyle(node).backgroundColor,
        color: getComputedStyle(node).color,
        width: getComputedStyle(node).width,
        height: getComputedStyle(node).height,
      })),
    ).toEqual(composeStyle);
    const collapsedHeaderBounds = await page.evaluate(() => {
      const expand = document
        .querySelector<HTMLElement>('.header-quick-actions [aria-label="Expand sidebar"]')!
        .getBoundingClientRect();
      const compose = document
        .querySelector<HTMLElement>('.header-quick-actions [aria-label="Compose"]')!
        .getBoundingClientRect();
      const search = document.querySelector<HTMLElement>(".search-box")!.getBoundingClientRect();
      return {
        expandLeft: expand.left,
        expandRight: expand.right,
        expandCenterY: expand.top + expand.height / 2,
        composeLeft: compose.left,
        composeRight: compose.right,
        composeCenterY: compose.top + compose.height / 2,
        searchLeft: search.left,
        searchCenterY: search.top + search.height / 2,
      };
    });
    expect(collapsedHeaderBounds.expandLeft).toBeGreaterThanOrEqual(88);
    expect(
      collapsedHeaderBounds.composeLeft - collapsedHeaderBounds.expandRight,
    ).toBeGreaterThanOrEqual(6);
    expect(
      collapsedHeaderBounds.searchLeft - collapsedHeaderBounds.composeRight,
    ).toBeGreaterThanOrEqual(8);
    expect(collapsedHeaderBounds.expandCenterY).toBe(collapsedHeaderBounds.composeCenterY);
    expect(collapsedHeaderBounds.composeCenterY).toBe(collapsedHeaderBounds.searchCenterY);
    expect(Math.abs(collapsedHeaderBounds.searchCenterY - 24)).toBeLessThanOrEqual(0.5);
    await expect(page.locator(".header-quick-actions")).toHaveCSS("-webkit-app-region", "no-drag");
    await headerCompose.click();
    await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();
    await page.getByRole("button", { name: "Close compose" }).click();
    const collapsedCheckboxAlignment = await page.evaluate(() => ({
      header: document.querySelector(".header-check .selection-indicator")!.getBoundingClientRect()
        .left,
      row: document.querySelector(".row-check .selection-indicator")!.getBoundingClientRect().left,
    }));
    expect(
      Math.abs(collapsedCheckboxAlignment.header - collapsedCheckboxAlignment.row),
    ).toBeLessThanOrEqual(1);
    await expandSidebar.hover();
    const expandTooltip = page.getByRole("tooltip", { name: "Expand sidebar" });
    await expect(expandTooltip).toBeVisible();
    await expect(expandSidebar).toHaveAttribute("aria-keyshortcuts", "[");
    await expect(expandTooltip.locator("kbd")).toHaveText("[");
    expect(await expandTooltip.evaluate((node) => node.parentElement === document.body)).toBe(true);
    expect(
      await expandTooltip.evaluate((node) => node.getBoundingClientRect().left),
    ).toBeGreaterThanOrEqual(0);
    await expandSidebar.click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".header-quick-actions")).toHaveCount(0);
    await expect(page.getByRole("separator", { name: "Resize sidebar" })).toBeVisible();
    await page.locator(".search-box").hover();
    await page.keyboard.press("[");
    await expect(page.locator(".sidebar")).toBeHidden();
    await page.keyboard.press("[");
    await expect(page.locator(".sidebar")).toBeVisible();
    const expandedSpacing = await page.locator(".sidebar-nav .nav-item").evaluateAll((items) => {
      const first = items[0]!.getBoundingClientRect();
      const second = items[1]!.getBoundingClientRect();
      return second.top - first.bottom;
    });
    expect(expandedSpacing).toBeGreaterThanOrEqual(2);
    const collapseSidebar = page.getByRole("button", {
      name: "Collapse sidebar",
    });
    await collapseSidebar.hover();
    await expect(collapseSidebar).toHaveCSS("border-top-width", "0px");
    const collapseTooltip = page.getByRole("tooltip", {
      name: "Collapse sidebar",
    });
    await expect(collapseTooltip).toBeVisible();
    await expect(collapseSidebar).toHaveAttribute("aria-keyshortcuts", "[");
    await expect(collapseTooltip.locator("kbd")).toHaveText("[");
    expect(
      await collapseTooltip.evaluate((node) => node.getBoundingClientRect().left),
    ).toBeGreaterThanOrEqual(0);
    await expect(page.locator(".conversation-count")).toHaveCount(0);
    await expect(page.getByText(/conversations$/)).toHaveCount(0);
    const refreshButton = page.locator(".title-row").getByRole("button", { name: "Refresh" });
    await refreshButton.hover();
    await expect(refreshButton).toHaveCSS("border-top-width", "0px");
    const checkboxAlignment = await page.evaluate(() => ({
      header: document.querySelector(".header-check .selection-indicator")!.getBoundingClientRect()
        .left,
      row: document.querySelector(".row-check .selection-indicator")!.getBoundingClientRect().left,
    }));
    expect(Math.abs(checkboxAlignment.header - checkboxAlignment.row)).toBeLessThanOrEqual(1);
    const headerOrder = await page.evaluate(() => ({
      searchTop: document.querySelector(".search-box")!.getBoundingClientRect().top,
      titleTop: document.querySelector(".title-row")!.getBoundingClientRect().top,
    }));
    expect(headerOrder.searchTop).toBeLessThan(headerOrder.titleTop);
    await expect(page.locator(".thread-header")).toHaveCSS("-webkit-app-region", "drag");
    await expect(page.locator(".search-box")).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(page.locator(".thread-header")).toHaveCSS("border-bottom-width", "0px");
    await expect(page.getByText("Today", { exact: true })).toBeVisible();
    await expect(page.locator(".thread-row").first().locator(".unread-dot")).toBeVisible();
    await expect(
      page.locator(".thread-row").filter({ hasText: "Receipt for Tuesday" }).locator(".unread-dot"),
    ).toHaveCount(0);
    const listDividerColor = await page
      .locator(".thread-row")
      .first()
      .evaluate((row) => getComputedStyle(row).borderBottomColor);
    const paneResizers = page.locator(".pane-resizer");
    await expect(paneResizers).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      await expect(paneResizers.nth(index)).toHaveCSS("background-color", listDividerColor);
    }
    const rowBackground = await page
      .locator(".thread-row")
      .first()
      .evaluate((row) => getComputedStyle(row).backgroundColor);
    await page.locator(".thread-row").first().hover();
    expect(
      await page
        .locator(".thread-row")
        .first()
        .evaluate((row) => getComputedStyle(row).backgroundColor),
    ).not.toBe(rowBackground);
    const rowArchive = page
      .locator(".thread-row")
      .first()
      .getByRole("button", { name: "Archive conversation" });
    await expect(rowArchive).toBeVisible();
    await expect(page.locator(".thread-row").nth(1).locator(".row-actions")).toHaveCSS(
      "opacity",
      "0",
    );
    await rowArchive.hover();
    const archiveTooltip = page.getByRole("tooltip", {
      name: "Archive conversation",
    });
    await expect(archiveTooltip).toBeVisible();
    await expect(rowArchive).toHaveAttribute("aria-keyshortcuts", "E");
    await expect(archiveTooltip.locator("kbd")).toHaveText("E");
    expect(await archiveTooltip.evaluate((node) => node.parentElement === document.body)).toBe(
      true,
    );
    await expect(
      page.locator(".thread-row").first().getByRole("button", {
        name: "Mark conversation read",
      }),
    ).toBeVisible();
    const listWidths = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".thread-row")!;
      const list = document.querySelector<HTMLElement>(".thread-list")!;
      return {
        row: row.getBoundingClientRect().width,
        list: list.getBoundingClientRect().width,
      };
    });
    expect(Math.abs(listWidths.row - listWidths.list)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-virtuoso-scroller="true"]')).toHaveCSS("overflow-x", "hidden");
    await expect(page.locator('[data-virtuoso-scroller="true"]')).toHaveCSS(
      "scrollbar-width",
      "none",
    );
    const threadScroller = page.locator('[data-virtuoso-scroller="true"]');
    await threadScroller.evaluate((element) => {
      let position = 0;
      Object.defineProperties(element, {
        clientHeight: { configurable: true, get: () => 500 },
        scrollHeight: { configurable: true, get: () => 2_000 },
        scrollTop: {
          configurable: true,
          get: () => position,
          set: (value: number) => {
            position = value;
          },
        },
      });
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator(".thread-fade.bottom")).toBeVisible();
    await expect(page.locator(".thread-fade.top")).toHaveCount(0);
    await threadScroller.evaluate((element) => {
      (element as HTMLElement).scrollTop = 750;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator(".thread-fade.top")).toBeVisible();
    await expect(page.locator(".thread-fade.bottom")).toBeVisible();
    await threadScroller.evaluate((element) => {
      Reflect.deleteProperty(element, "clientHeight");
      Reflect.deleteProperty(element, "scrollHeight");
      Reflect.deleteProperty(element, "scrollTop");
      element.dispatchEvent(new Event("scroll"));
    });
    expect(
      await page
        .locator(".thread-pane")
        .evaluate((pane) =>
          getComputedStyle(pane, "::before").getPropertyValue("-webkit-app-region"),
        ),
    ).toBe("drag");
    const draftsNav = page.locator(".sidebar .nav-item").filter({ hasText: "Drafts" });
    const inboxNavCount = page
      .locator(".sidebar .nav-item")
      .filter({ hasText: "Inbox" })
      .locator(".nav-count");
    await expect(inboxNavCount).toHaveText(/^\d+$/);
    expect(Number(await inboxNavCount.textContent())).toBeGreaterThan(1);
    await expect(draftsNav.locator(".nav-count")).toHaveText("1");
    const inboxCountFits = await page
      .locator(".sidebar .nav-item")
      .filter({ hasText: "Inbox" })
      .evaluate((item) => {
        const count = item.querySelector<HTMLElement>(".nav-count")!;
        count.textContent = "169";
        const itemBounds = item.getBoundingClientRect();
        const countBounds = count.getBoundingClientRect();
        const itemPaddingRight = Number.parseFloat(getComputedStyle(item).paddingRight);
        return {
          textFits: count.scrollWidth <= count.clientWidth,
          staysInside: countBounds.right <= itemBounds.right - itemPaddingRight,
        };
      });
    expect(inboxCountFits).toEqual({ textFits: true, staysInside: true });
    expect(
      await page
        .locator(".reading-pane")
        .evaluate((pane) =>
          getComputedStyle(pane, "::before").getPropertyValue("-webkit-app-region"),
        ),
    ).toBe("drag");

    await page.getByRole("button", { name: "Spam" }).click();
    await expect(page.getByRole("heading", { name: "Nothing here" })).toBeVisible();
    const showedBackgroundSkeleton = await page.evaluate(async () => {
      let showedSkeleton = false;
      const observer = new MutationObserver(() => {
        showedSkeleton ||= Boolean(document.querySelector(".skeleton-list"));
      });
      observer.observe(document.querySelector(".thread-list")!, {
        childList: true,
        subtree: true,
      });
      await window.fluxmail.sync.refresh();
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      observer.disconnect();
      return showedSkeleton;
    });
    expect(showedBackgroundSkeleton).toBe(false);
    await page.getByRole("button", { name: "Inbox" }).click();
    await expect(page.getByText("Welcome to Fluxmail", { exact: true }).first()).toBeVisible();

    const threadListTopBeforeSelection = await page
      .locator(".thread-list")
      .evaluate((node) => node.getBoundingClientRect().top);
    const selectAll = page.getByRole("checkbox", {
      name: "Select all conversations",
    });
    await expect(selectAll).toBeVisible();
    await expect(selectAll).toHaveAttribute("aria-checked", "false");
    const firstSelect = page
      .locator(".thread-row")
      .first()
      .getByRole("checkbox", { name: "Select conversation" });
    await selectAll.hover();
    const selectAllHoverBackground = await selectAll.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    await firstSelect.hover();
    await expect(firstSelect).toHaveCSS("background-color", selectAllHoverBackground);
    const uncheckedIndicatorSize = await firstSelect
      .locator(".selection-indicator")
      .evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      });
    await firstSelect.click();
    await expect(page.locator(".row-check.checked .selection-indicator")).toHaveCSS(
      "background-color",
      "rgb(49, 94, 206)",
    );
    expect(
      await page.locator(".row-check.checked .selection-indicator").evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    ).toEqual(uncheckedIndicatorSize);
    expect(
      await page.locator(".thread-list").evaluate((node) => node.getBoundingClientRect().top),
    ).toBe(threadListTopBeforeSelection);
    await expect(selectAll).toHaveAttribute("aria-checked", "mixed");
    await expect(page.getByRole("combobox", { name: "Search mail" })).toBeVisible();
    await expect(
      page.locator(".thread-header").getByRole("heading", { name: "Inbox" }),
    ).toHaveCount(0);
    await expect(page.locator(".title-row").getByRole("button", { name: "Refresh" })).toHaveCount(
      0,
    );
    await expect(page.locator(".selection-count")).toHaveText("1 selected");
    await expect(
      page.locator(".selection-actions").getByRole("button", { name: "Mark read" }),
    ).toBeVisible();
    await expect(
      page.locator(".selection-actions").getByRole("button", { name: "Mark unread" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".selection-actions").getByRole("button", { name: "Apply label" }),
    ).toBeVisible();
    const listMoreActions = page
      .locator(".selection-actions")
      .getByRole("button", { name: "More actions" });
    await expect(listMoreActions).toBeVisible();
    await listMoreActions.hover();
    const moreActionsTooltip = page.getByRole("tooltip", {
      name: "More actions",
    });
    await expect(moreActionsTooltip).toBeVisible();
    await expect(moreActionsTooltip.locator("kbd")).toHaveCount(0);
    expect(await moreActionsTooltip.evaluate((node) => node.parentElement === document.body)).toBe(
      true,
    );
    const tooltipBounds = await moreActionsTooltip.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(tooltipBounds.left).toBeGreaterThanOrEqual(0);
    expect(tooltipBounds.right).toBeLessThanOrEqual(tooltipBounds.viewportWidth);
    expect(tooltipBounds.top).toBeGreaterThanOrEqual(0);
    expect(tooltipBounds.bottom).toBeLessThanOrEqual(tooltipBounds.viewportHeight);
    await selectAll.click();
    const clearSelection = page.getByRole("checkbox", {
      name: "Clear selection",
    });
    await expect(clearSelection).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".selection-count")).toHaveText("60 selected");
    await clearSelection.click();
    await expect(page.locator(".row-check.checked")).toHaveCount(0);
    await expect(
      page.locator(".thread-header").getByRole("heading", { name: "Inbox" }),
    ).toBeVisible();
    await expect(page.locator(".title-row").getByRole("button", { name: "Refresh" })).toBeVisible();

    const secondSelect = page
      .locator(".thread-row")
      .nth(1)
      .getByRole("checkbox", { name: "Select conversation" });
    await secondSelect.click();
    await expect(
      page.locator(".selection-actions").getByRole("button", { name: "Mark unread" }),
    ).toBeVisible();
    await expect(
      page.locator(".selection-actions").getByRole("button", { name: "Mark read" }),
    ).toHaveCount(0);
    await secondSelect.click();

    await page.keyboard.press("j");
    await expect(page.locator(".thread-row.active")).not.toHaveClass(/unread/);
    await expect(page.locator(".thread-row.active .unread-dot")).toHaveCount(0);
    const markUnreadButton = page
      .locator(".reading-toolbar")
      .getByRole("button", { name: "Mark unread" });
    await expect(markUnreadButton).toHaveAttribute("aria-keyshortcuts", "U");
    await page.keyboard.press("u");
    await expect(page.locator(".thread-row.active")).toHaveClass(/unread/);
    await page.keyboard.press("u");
    await expect(page.locator(".thread-row.active")).not.toHaveClass(/unread/);
    await expect(page.locator(".reading-toolbar")).toHaveCSS("-webkit-app-region", "drag");
    await expect(
      page.locator(".reading-toolbar").getByRole("button", { name: "Archive" }),
    ).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(page.locator(".conversation-title h1")).toHaveText("Welcome to Fluxmail");
    await page
      .locator(".thread-row")
      .nth(1)
      .click({ position: { x: 4, y: 4 } });
    await expect(page.locator(".conversation-title h1")).toHaveText("Receipt for Tuesday");
    await page
      .locator(".thread-row")
      .first()
      .click({ position: { x: 4, y: 4 } });
    await expect(page.locator(".conversation-title h1")).toHaveText("Welcome to Fluxmail");
    await expect(page.locator(".conversation-scroll")).toHaveCSS("padding-top", "14px");
    await expect(page.locator(".conversation-title")).toHaveCSS("margin-bottom", "12px");
    await page.locator(".conversation-title").hover();
    await expect(page.locator(".thread-row.active .row-actions")).toHaveCSS("opacity", "0");
    await expect(page.locator(".thread-row.active .row-actions")).toHaveCSS(
      "pointer-events",
      "none",
    );
    await expect(page.locator(".message-from strong")).toHaveText("Fluxmail Team");
    await expect(page.locator(".message-from-email")).toHaveText("<team@fluxmail.test>");
    await expect(page.locator(".sender-avatar")).toHaveCSS("border-radius", "50%");
    await expect(page.locator(".message-header")).toHaveCSS("cursor", "default");
    const senderFontSize = await page
      .locator(".message-from strong")
      .evaluate((node) => getComputedStyle(node).fontSize);
    await expect(page.locator(".message-from-email")).toHaveCSS("font-size", senderFontSize);
    await expect(page.locator(".message-sender small")).toHaveCSS("font-size", senderFontSize);
    await expect(page.locator(".message-sender small")).toHaveCSS("pointer-events", "auto");
    await expect(page.locator(".message-header time")).toHaveCSS("font-size", senderFontSize);
    const readingInsets = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".reading-pane")!.getBoundingClientRect();
      const toolbarFirst = document
        .querySelector<HTMLElement>(".reading-toolbar .icon-button")!
        .getBoundingClientRect();
      const toolbarLast = document
        .querySelector<HTMLElement>(".reading-toolbar > .tooltip-control:last-child .icon-button")!
        .getBoundingClientRect();
      const title = document
        .querySelector<HTMLElement>(".conversation-title")!
        .getBoundingClientRect();
      const message = document.querySelector<HTMLElement>(".message-card")!.getBoundingClientRect();
      return {
        toolbarLeft: toolbarFirst.left - pane.left,
        toolbarRight: pane.right - toolbarLast.right,
        titleLeft: title.left - pane.left,
        messageLeft: message.left - pane.left,
        messageRight: pane.right - message.right,
      };
    });
    expect(readingInsets).toEqual({
      toolbarLeft: 11,
      toolbarRight: 11,
      titleLeft: 11,
      messageLeft: 0,
      messageRight: 0,
    });
    await expect(page.locator(".conversation-title > span")).toHaveCount(0);
    const messageFrame = page.frameLocator('iframe[title="Email message"]');
    await expect(messageFrame.locator("script")).toHaveCount(0);
    await expect(messageFrame.locator("img")).toHaveCount(1);
    await expect(messageFrame.locator(".newsletter-copy")).toHaveCSS("font-size", "22px");
    await expect(messageFrame.locator(".newsletter-copy")).toHaveCSS("text-align", "center");
    const trackingIndicator = page.locator(".message-from").getByLabel("Blocked 2 tracking pixels");
    await expect(trackingIndicator).toBeVisible();
    await expect(trackingIndicator).toHaveCSS("user-select", "none");
    await expect(trackingIndicator).toHaveCSS("margin-left", "2px");
    await trackingIndicator.hover();
    const trackingTooltip = page.getByRole("tooltip", {
      name: /Blocked 2 tracking pixels/,
    });
    await expect(trackingTooltip).toBeVisible();
    await expect(trackingTooltip).toContainText("tracker.invalid");
    await expect(trackingTooltip).toContainText("t.yesware.com");
    const loadImagesButton = page.getByRole("button", {
      name: "Load remote images",
    });
    const imageBannerLayout = await page.evaluate(() => {
      const header = document
        .querySelector<HTMLElement>(".message-header")!
        .getBoundingClientRect();
      const message = document.querySelector<HTMLElement>(".message-card")!.getBoundingClientRect();
      const banner = document.querySelector<HTMLElement>(".load-images")!.getBoundingClientRect();
      return {
        startsBelowHeader: banner.top - header.bottom,
        leftInset: banner.left - message.left,
        rightInset: message.right - banner.right,
      };
    });
    expect(imageBannerLayout).toEqual({
      startsBelowHeader: 0,
      leftInset: 0,
      rightInset: 0,
    });
    await expect(loadImagesButton).toHaveCSS("border-top-width", "0px");
    await expect(loadImagesButton).toHaveCSS("border-bottom-width", "0px");
    // Leave the image request pending so the frame's load event never fires. Sizing and find must
    // still attach to the new document.
    await electronApp.context().route("https://images.invalid/**", () => {});
    await loadImagesButton.click();
    await expect(page.getByRole("button", { name: "Load remote images" })).toHaveCount(0);
    await expect(messageFrame.locator('img[src="https://images.invalid/welcome.png"]')).toHaveCount(
      1,
    );
    await messageFrame.locator("#email-root").click();
    const findMenuItem = await electronApp.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("find-in-conversation");
      return item ? { label: item.label, accelerator: item.accelerator } : undefined;
    });
    expect(findMenuItem).toEqual({
      label: "Find in Conversation",
      accelerator: "CmdOrCtrl+F",
    });
    await electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("find-in-conversation")?.click();
    });
    const conversationFind = page.getByRole("textbox", { name: "Find in conversation" });
    await expect(conversationFind).toBeFocused();
    await conversationFind.fill("inbox");
    await expect(page.locator(".message-find-status")).toHaveText("1 of 1");
    await expect(
      messageFrame.locator("mark[data-fluxmail-find-match].active", { hasText: "inbox" }),
    ).toHaveCount(1);
    await messageFrame.locator("#email-root").evaluate((root) => {
      root.insertAdjacentHTML(
        "beforeend",
        '<style>.hidden-find-probe{display:none}</style><p>Order <strong>#123</strong> is ready.</p><p class="hidden-find-probe">Hidden preheader</p><p>Scroll target</p><div style="height:2400px"></div><p>Scroll target</p>',
      );
    });
    await conversationFind.fill("Order #123");
    await expect(page.locator(".message-find-status")).toHaveText("1 of 1");
    await expect(messageFrame.locator('mark[data-fluxmail-find-match="0"].active')).toHaveCount(2);
    await conversationFind.fill("Hidden preheader");
    await expect(page.locator(".message-find-status")).toHaveText("No matches");
    await conversationFind.fill("Scroll target");
    await expect(page.locator(".message-find-status")).toHaveText("1 of 2");
    const conversationScroll = page.locator(".conversation-scroll");
    await conversationScroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await conversationFind.press("Enter");
    await expect(page.locator(".message-find-status")).toHaveText("2 of 2");
    await expect
      .poll(() => conversationScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(1_000);
    await conversationFind.press("Escape");
    await expect(conversationFind).toHaveCount(0);
    await expect(messageFrame.locator("mark[data-fluxmail-find-match]")).toHaveCount(0);
    await messageFrame.locator("#email-root").evaluate((root) => {
      root.innerHTML = '<div style="height: 4200px">Long message</div>';
    });
    await expect(page.locator('iframe[title="Email message"]')).toHaveCSS("height", "4200px");
    await messageFrame.locator("#email-root").evaluate((root) => {
      root.innerHTML =
        '<div style="height: 100px; overflow: visible"><img id="late-image" style="display: block; width: 600px"></div>';
    });
    await expect(page.locator('iframe[title="Email message"]')).toHaveCSS("height", "100px");
    await messageFrame.locator("#late-image").evaluate((image) => {
      image.setAttribute(
        "src",
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='1200'%3E%3C/svg%3E",
      );
    });
    await expect(page.locator('iframe[title="Email message"]')).toHaveCSS("height", "1200px");
    const conversationScrollBox = await page
      .locator(".conversation-scroll")
      .evaluate((element) => ({
        clientWidth: element.clientWidth,
        offsetWidth: (element as HTMLElement).offsetWidth,
      }));
    expect(conversationScrollBox.clientWidth).toBe(conversationScrollBox.offsetWidth);
    await page.locator(".conversation-scroll-shell").hover();
    await expect(page.locator(".conversation-scroll-shell .overlay-scrollbar")).toHaveCSS(
      "opacity",
      "1",
    );
    expect(
      await page.locator(".conversation-scroll").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      }),
    ).toBeGreaterThan(0);
    await messageFrame.locator("#email-root").evaluate((root) => {
      root.innerHTML = '<div style="height:1800px">Welcome to Fluxmail</div>';
    });

    const messageActions = page.locator(".reply-actions");
    await expect(
      messageActions.getByRole("button", { name: "Reply", exact: true }),
    ).toHaveAttribute("aria-keyshortcuts", "R");
    await expect(messageActions.getByRole("button", { name: "Reply all" })).toHaveCount(0);
    await expect(messageActions.getByRole("button", { name: "Forward" })).toHaveAttribute(
      "aria-keyshortcuts",
      "F",
    );
    await conversationScroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await expect
      .poll(() =>
        conversationScroll.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect(
      page.locator(".quick-reply").getByRole("button", { name: "Underline" }),
    ).toBeVisible();
    const quickReplySend = page
      .locator(".quick-reply")
      .getByRole("button", { name: "Send", exact: true });
    const quickReplySendOptions = page
      .locator(".quick-reply")
      .getByRole("button", { name: "More send options" });
    await expect(quickReplySend).toBeDisabled();
    await expect(quickReplySendOptions).toBeDisabled();
    await expect(
      page.locator(".quick-reply").getByRole("button", { name: "Underline" }),
    ).toHaveAttribute("aria-keyshortcuts", "Meta+U");
    const replyPlaceholder = page.locator(".quick-reply .mail-editor-placeholder");
    await expect(replyPlaceholder).toBeVisible();
    await expect
      .poll(() =>
        replyPlaceholder.evaluate((element) =>
          ((element as HTMLElement).offsetParent as HTMLElement | null)?.classList.contains(
            "mail-editor",
          ),
        ),
      )
      .toBe(true);
    const placeholderOffset = () =>
      page.locator(".quick-reply .mail-editor").evaluate((editor) => {
        const placeholder = editor.querySelector<HTMLElement>(".mail-editor-placeholder");
        if (!placeholder) throw new Error("Reply placeholder is missing");
        return placeholder.getBoundingClientRect().top - editor.getBoundingClientRect().top;
      });
    const placeholderOffsetBeforeScroll = await placeholderOffset();
    await page.locator(".conversation-scroll").evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollTop - 80);
    });
    expect(Math.abs((await placeholderOffset()) - placeholderOffsetBeforeScroll)).toBeLessThan(1);
    const quickReply = page.locator(".quick-reply");
    const quickReplyEditor = quickReply.locator('[contenteditable="true"]');
    const quickReplyBulletedList = quickReply.getByRole("button", { name: "Bulleted list" });
    await quickReplyBulletedList.click();
    await expect(quickReplyEditor.locator("ul")).toHaveCSS("list-style-type", "disc");
    await expect(replyPlaceholder).toHaveCount(0);
    await quickReplyBulletedList.click();
    await expect(replyPlaceholder).toBeVisible();
    await quickReplyEditor.fill("Reply later.");
    await expect(quickReplySend).toBeEnabled();
    await expect(quickReplySendOptions).toBeEnabled();
    await quickReplySendOptions.click();
    await expect(
      page.locator(".quick-reply").getByRole("dialog", { name: "Schedule send" }),
    ).toBeVisible();
    await quickReplySendOptions.click();
    await expect(
      page.locator(".quick-reply").getByRole("button", { name: "Show quoted message" }),
    ).toBeVisible();
    await page.locator(".quick-reply").getByRole("button", { name: "Show quoted message" }).click();
    await expect(page.locator(".quick-reply .quoted-reply-content")).toBeVisible();
    await expect(page.locator(".quick-reply .quoted-reply-meta")).toHaveText(/^On .+ wrote:$/);
    await expect(page.locator(".quick-reply .quoted-reply-body")).toBeVisible();
    await page.locator(".quick-reply").getByRole("button", { name: "Cancel" }).click();

    await page.keyboard.press("a");
    await expect(page.locator(".quick-reply")).toHaveCount(0);
    await expect(page.locator(".compose-dialog")).toHaveCount(0);

    await page.keyboard.press("f");
    await expect(page.locator(".quick-reply").getByRole("textbox", { name: "To" })).toBeVisible();
    await expect(page.locator(".compose-dialog")).toHaveCount(0);
    await page.locator(".quick-reply").getByRole("button", { name: "Cancel" }).click();

    await page.locator(".reading-toolbar").getByRole("button", { name: "Archive" }).click();
    await expect(page.locator(".conversation-title h1")).toHaveText("Receipt for Tuesday", {
      timeout: 200,
    });
    await expect(page.locator(".thread-row.active")).toContainText("Receipt for Tuesday");
    await expect(page.getByText("Welcome to Fluxmail", { exact: true })).toHaveCount(0);

    const search = page.getByRole("combobox", { name: "Search mail" });
    await search.fill("sub");
    await expect(page.getByRole("option", { name: /subject:/ })).toBeVisible();
    await search.press("Enter");
    await expect(search).toHaveValue("subject:");
    await search.fill("is:");
    await page.getByRole("option", { name: /is:unread/ }).click();
    await expect(search).toHaveValue("is:unread ");
    await search.fill("receipt");
    await search.press("Enter");
    await expect(page.getByText("Receipt for Tuesday", { exact: true })).toBeVisible();
    await page.getByText("Receipt for Tuesday", { exact: true }).click();
    await page.locator(".reading-toolbar").getByRole("button", { name: "Trash" }).click();
    await expect(page.getByText("Receipt for Tuesday", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByText("Receipt for Tuesday", { exact: true }).click();
    const trashToolbar = page.locator(".reading-toolbar");
    await expect(trashToolbar.getByRole("button", { name: "Restore" })).toBeVisible();
    await expect(trashToolbar.getByRole("button", { name: "Delete permanently" })).toHaveCount(0);
    await trashToolbar.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Receipt for Tuesday", { exact: true })).toHaveCount(0);

    await draftsNav.click();
    const launchDraft = page.locator(".thread-row").filter({ hasText: "Launch notes" });
    await expect(launchDraft).toBeVisible();
    await expect(launchDraft.getByText("Draft", { exact: true })).toBeVisible();
    await launchDraft.locator(".thread-open").click();
    const resumedDraft = page.getByRole("region", { name: "Draft" });
    await expect(resumedDraft.locator("header strong")).toHaveText("Draft");
    await expect(resumedDraft.locator(".recipient-summary")).toContainText("sam@example.test");
    await expect(resumedDraft.getByLabel("Subject")).toHaveValue("Launch notes");
    await expect(resumedDraft.locator('[contenteditable="true"]')).toContainText(
      "The first draft is ready.",
    );
    await expect(resumedDraft.locator(".compose-attachments")).toContainText("launch-notes.pdf");
    await expect(resumedDraft.getByText("Saved", { exact: true })).toBeVisible();
    await resumedDraft.getByRole("button", { name: "Edit recipients" }).click();
    await resumedDraft
      .locator(".recipient-row")
      .filter({ hasText: /^To/ })
      .locator("input")
      .fill("r");
    await inboxNav.click();
    await expect(resumedDraft).toBeHidden();
    await draftsNav.click();
    await launchDraft.locator(".thread-open").click();
    await expect(resumedDraft.locator(".recipient-summary")).toContainText("r");
    await inboxNav.click();
    await expect(resumedDraft).toBeHidden();

    await page.keyboard.press("Meta+c");
    await expect(page.getByRole("dialog", { name: "New message" })).toHaveCount(0);
    await page.getByRole("button", { name: "Compose" }).click();
    const compose = page.getByRole("dialog", { name: "New message" });
    await expect(page.locator(".modal-backdrop")).toHaveCSS("backdrop-filter", "none");
    await expect(compose.locator("header")).toHaveCSS("border-bottom-width", "0px");
    expect(
      await compose.evaluate((dialog) => {
        const header = dialog.querySelector("header")!;
        return (
          getComputedStyle(header).backgroundColor === getComputedStyle(dialog).backgroundColor
        );
      }),
    ).toBe(true);
    await expect(compose.getByRole("button", { name: "Cc", exact: true })).toBeVisible();
    await expect(compose.getByRole("button", { name: "Bcc", exact: true })).toBeVisible();
    await expect(compose.locator(".recipient-row").filter({ hasText: /^Cc/ })).toHaveCount(0);
    await compose
      .locator(".recipient-row")
      .filter({ hasText: /^To/ })
      .locator("input")
      .fill("friend@example.com");
    await compose.getByRole("button", { name: "Cc", exact: true }).click();
    await compose
      .locator(".recipient-row")
      .filter({ hasText: /^Cc/ })
      .locator("input")
      .fill("copy@example.com");
    await compose
      .locator("label")
      .filter({ hasText: /^Subject/ })
      .locator("input")
      .fill("Desktop test");
    await expect(compose.locator("header strong")).toHaveText("Desktop test");
    await expect(compose.locator(".recipient-summary")).toContainText("friend@example.com");
    await expect(compose.locator(".recipient-summary")).toContainText("copy@example.com");
    const bulletedListButton = compose.getByRole("button", { name: "Bulleted list" });
    await expect(bulletedListButton).toBeVisible();
    await expect(compose.getByRole("button", { name: "Undo" })).toBeVisible();
    const composerEditor = compose.locator('[contenteditable="true"]');
    await composerEditor.fill("Sent from the desktop client.");
    await bulletedListButton.click();
    await expect(composerEditor.locator("ul > li")).toHaveText("Sent from the desktop client.");
    await expect(composerEditor.locator("ul")).toHaveCSS("list-style-type", "disc");
    await expect(bulletedListButton).toHaveClass(/active/);
    await bulletedListButton.click();
    await expect(composerEditor.locator("ul")).toHaveCount(0);
    await expect(
      composerEditor.getByText("Sent from the desktop client.", { exact: true }),
    ).toBeVisible();
    await expect(bulletedListButton).not.toHaveClass(/active/);
    const editorBounds = await compose.locator(".compose-editor").boundingBox();
    if (!editorBounds) throw new Error("Compose editor did not render.");
    await compose.locator(".compose-editor").click({
      position: { x: editorBounds.width / 2, y: editorBounds.height - 8 },
    });
    await expect(compose.locator('[contenteditable="true"]')).toBeFocused();
    await expect(compose.getByRole("button", { name: /^Send/ })).toHaveCSS(
      "border-top-width",
      "0px",
    );
    await compose.getByRole("button", { name: "More send options" }).click();
    const schedulePopover = compose.getByRole("dialog", { name: "Schedule send" });
    await expect(schedulePopover).toBeVisible();
    expect(
      await schedulePopover.evaluate((popover) => {
        const input = popover.querySelector("input")!.getBoundingClientRect();
        const button = popover.querySelector("button")!.getBoundingClientRect();
        return {
          separateRows: button.top >= input.bottom,
          contained: button.right <= popover.getBoundingClientRect().right,
        };
      }),
    ).toEqual({ separateRows: true, contained: true });
    await compose.getByRole("button", { name: "More send options" }).click();
    await page.keyboard.press("Meta+Enter");
    await expect(compose).toBeHidden();
    const undoToast = page.getByRole("status").filter({ hasText: "Message sent." });
    await expect(undoToast).toContainText("Message sent.");
    await page.locator(".sidebar").getByRole("button", { name: "Sent" }).click();
    const pendingSendRow = page.locator(".thread-row", { hasText: "Desktop test" });
    await expect(pendingSendRow).toBeVisible();
    await expect(pendingSendRow.locator(".thread-draft-label")).toHaveCount(0);
    await pendingSendRow.locator(".thread-open").click();
    await expect(page.locator(".conversation-title h1")).toHaveText("Desktop test");
    await expect(
      page.frameLocator('iframe[title="Email message"]').locator("#email-root"),
    ).toContainText("Sent from the desktop client.");
    await undoToast.getByRole("button", { name: "Undo" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Sending canceled. The message is in Drafts." }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Compose" }).click();
    const scheduledCompose = page.getByRole("dialog", { name: "New message" });
    await scheduledCompose
      .locator(".recipient-row")
      .filter({ hasText: /^To/ })
      .locator("input")
      .fill("jamie@example.com");
    await scheduledCompose
      .locator("label")
      .filter({ hasText: /^Subject/ })
      .locator("input")
      .fill("Scheduled desktop test");
    await scheduledCompose.locator('[contenteditable="true"]').fill("Send this tomorrow.");
    await scheduledCompose.getByRole("button", { name: "More send options" }).click();
    const scheduledPopover = scheduledCompose.getByRole("dialog", { name: "Schedule send" });
    const tomorrow = await page.evaluate(() => {
      const date = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      const offset = date.getTimezoneOffset() * 60_000;
      return new Date(date.getTime() - offset).toISOString().slice(0, 16);
    });
    await scheduledPopover.locator('input[type="datetime-local"]').fill(tomorrow);
    await scheduledPopover.getByRole("button", { name: "Schedule" }).click();
    await expect(scheduledCompose).toBeHidden();
    await expect(
      page.getByRole("status").filter({ hasText: "Message scheduled for" }),
    ).toBeVisible();

    await page.locator(".sidebar").getByRole("button", { name: "Scheduled" }).click();
    await expect(page.getByRole("heading", { name: "Scheduled", exact: true })).toBeVisible();
    const scheduledRow = page.locator(".thread-row", { hasText: "Scheduled desktop test" });
    await expect(scheduledRow).toBeVisible();
    await expect(scheduledRow.locator(".sender")).toHaveText("jamie@example.com");
    await expect(scheduledRow.locator(".thread-draft-label")).toHaveText("Scheduled");
    await expect
      .poll(() => page.evaluate(async () => (await window.fluxmail.bootstrap()).scheduledCount))
      .toBe(1);
    await expect(page.locator(".sidebar .nav-item", { hasText: "Scheduled" })).toContainText("1");

    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1040, 680),
    );
    const settingsButton = page.getByRole("button", { name: "Settings" });
    await settingsButton.hover();
    await expect(settingsButton).toHaveCSS("border-top-width", "0px");
    await settingsButton.click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    const systemTheme = settings.getByRole("radio", { name: "System" });
    const lightTheme = settings.getByRole("radio", { name: "Light" });
    const darkTheme = settings.getByRole("radio", { name: "Dark" });
    await expect(systemTheme).toHaveAttribute("aria-checked", "true");
    await darkTheme.click();
    await expect(darkTheme).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");
    await lightTheme.click();
    await expect(lightTheme).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");
    await systemTheme.click();
    expect(await settings.locator(".settings-content > section > h2").allTextContents()).toEqual([
      "Plan",
      "Accounts",
      "Appearance",
      "Behavior",
      "Sending",
      "Privacy",
      "About",
    ]);
    const undoSendMenu = settings.getByRole("button", { name: "Undo send" });
    await expect(undoSendMenu).toContainText("10 seconds");
    await undoSendMenu.click();
    await settings.getByRole("menuitem", { name: "Off" }).click();
    await expect(undoSendMenu).toContainText("Off");
    const settingsContent = settings.locator(".settings-content");
    const sharedDataFormat = settings.locator(".settings-about span", {
      hasText: "Shared data format",
    });
    await sharedDataFormat.scrollIntoViewIfNeeded();
    const desktopVersion = await electronApp.evaluate(({ app }) => app.getVersion());
    const bootstrap = await page.evaluate(() => window.fluxmail.bootstrap());
    expect(bootstrap.desktopVersion).toBe(desktopVersion);
    await expect(
      settings.locator(".settings-about span", { hasText: "Fluxmail Desktop version" }),
    ).toHaveText(`Fluxmail Desktop version${desktopVersion}`);
    await expect(
      settings.locator(".settings-about span", { hasText: "Fluxmail engine version" }),
    ).toHaveText(`Fluxmail engine version${bootstrap.engine.version}`);
    await expect(sharedDataFormat.getByText(/^\d+$/)).toBeVisible();
    await expect(settings.getByRole("button", { name: "Source code" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Software licenses" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Terms" })).toBeVisible();
    expect(
      await settings.evaluate((dialog) => {
        const dialogBounds = dialog.getBoundingClientRect();
        const contentBounds = dialog.querySelector(".settings-content")!.getBoundingClientRect();
        const aboutBounds = dialog.querySelector(".settings-about")!.getBoundingClientRect();
        return {
          dialogFitsViewport: dialogBounds.top >= 40 && dialogBounds.bottom <= innerHeight - 40,
          contentFitsDialog: contentBounds.bottom <= dialogBounds.bottom,
          aboutFitsContent: aboutBounds.bottom <= contentBounds.bottom,
        };
      }),
    ).toEqual({
      dialogFitsViewport: true,
      contentFitsDialog: true,
      aboutFitsContent: true,
    });
    await settingsContent.evaluate((content) => {
      content.scrollTop = 0;
    });
    const dockBadgeCheckbox = settings.getByRole("checkbox", {
      name: "Dock badge",
    });
    await expect(dockBadgeCheckbox).toHaveAttribute("aria-checked", "true");
    await electronApp.evaluate(({ app }) => app.dock?.setBadge("7"));
    await dockBadgeCheckbox.click();
    await expect(dockBadgeCheckbox).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => electronApp.evaluate(({ app }) => app.dock?.getBadge())).toBe("");
    await dockBadgeCheckbox.click();
    await expect(dockBadgeCheckbox).toHaveAttribute("aria-checked", "true");
    const openNextAfterArchiveCheckbox = settings.getByRole("checkbox", {
      name: "Open next conversation after archiving",
    });
    await expect(openNextAfterArchiveCheckbox).toHaveAttribute("aria-checked", "true");
    await openNextAfterArchiveCheckbox.click();
    await expect(openNextAfterArchiveCheckbox).toHaveAttribute("aria-checked", "false");
    await openNextAfterArchiveCheckbox.click();
    await expect(openNextAfterArchiveCheckbox).toHaveAttribute("aria-checked", "true");
    await expect(settings.getByRole("heading", { name: "Privacy" })).toBeVisible();
    await expect(
      settings.getByText(
        "If you're not using the private image relay, we recommend keeping this on. Turning it off may expose your IP address to email senders.",
      ),
    ).toBeVisible();
    const blockRemoteImagesCheckbox = settings.getByRole("checkbox", {
      name: "Block remote images by default",
    });
    await expect(blockRemoteImagesCheckbox).toHaveAttribute("aria-checked", "true");
    await blockRemoteImagesCheckbox.click();
    await expect(blockRemoteImagesCheckbox).toHaveAttribute("aria-checked", "false");
    await blockRemoteImagesCheckbox.click();
    await expect(blockRemoteImagesCheckbox).toHaveAttribute("aria-checked", "true");
    await expect(
      settings.getByText(
        "Send anonymized analytics to help us improve our features, performance, and reliability. Your email content is never included.",
      ),
    ).toBeVisible();
    const analyticsCheckbox = settings.getByRole("checkbox", {
      name: "Anonymous analytics",
    });
    const initialAnalyticsState = await analyticsCheckbox.getAttribute("aria-checked");
    await expect(analyticsCheckbox.locator(".selection-indicator")).toBeVisible();
    await analyticsCheckbox.click();
    await expect(analyticsCheckbox).toHaveAttribute(
      "aria-checked",
      initialAnalyticsState === "true" ? "false" : "true",
    );
    const imageRelayCheckbox = settings.getByRole("checkbox", {
      name: "Private image relay",
    });
    await expect(imageRelayCheckbox).toHaveAttribute("aria-checked", "false");
    await expect(
      settings.getByText(
        "Use Fluxmail's private hosted relay when you load remote images. This hides your IP address from the sender.",
      ),
    ).toBeVisible();
    await imageRelayCheckbox.click();
    await expect(imageRelayCheckbox).toHaveAttribute("aria-checked", "true");
    await expect(settings.getByText("Pro", { exact: true })).toBeVisible();
    await expect(
      settings.getByText("Includes up to 5 connected mailboxes for one member."),
    ).toBeVisible();
    await expect(settings.getByRole("button", { name: "View plans" })).toBeVisible();
    await expect(settings.getByLabel("License key")).toBeHidden();
    await settings.getByRole("button", { name: "Activate license key" }).click();
    const licenseKeyInput = settings.getByLabel("License key");
    await expect(licenseKeyInput).toHaveAttribute("type", "password");
    await licenseKeyInput.fill(`fluxmail_lic_${"ab".repeat(20)}`);
    await settings.getByRole("button", { name: "Activate", exact: true }).click();
    await expect(settings.getByText("License activated.")).toBeVisible();
    await expect(settings.getByText("Pro", { exact: true })).toBeVisible();
    await expect(
      settings.getByText("Includes up to 5 connected mailboxes for one member."),
    ).toBeVisible();
    await expect(licenseKeyInput).toBeHidden();
    await expect(settings.getByRole("button", { name: "Activate license key" })).toBeVisible();
    await expect(settings.locator("header")).toHaveCSS("border-bottom-width", "0px");
    expect(
      await settings.evaluate((dialog) => {
        const header = dialog.querySelector("header")!;
        return (
          getComputedStyle(header).backgroundColor === getComputedStyle(dialog).backgroundColor
        );
      }),
    ).toBe(true);
    const accountActionAlignment = await settings
      .locator(".settings-accounts > div")
      .evaluate((row) => {
        const identity = row.querySelector(".account-identity")!.getBoundingClientRect();
        const actions = row.querySelector(".account-actions")!.getBoundingClientRect();
        return {
          identityRight: identity.right,
          actionsLeft: actions.left,
          actionsRight: actions.right,
          rowRight: row.getBoundingClientRect().right,
        };
      });
    expect(accountActionAlignment.actionsLeft).toBeGreaterThanOrEqual(
      accountActionAlignment.identityRight,
    );
    expect(accountActionAlignment.rowRight - accountActionAlignment.actionsRight).toBeLessThan(14);
    await settings.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Compose" }).click();
    const immediateCompose = page.getByRole("dialog", { name: "New message" });
    await immediateCompose
      .locator(".recipient-row")
      .filter({ hasText: /^To/ })
      .locator("input")
      .fill("friend@example.com");
    await immediateCompose.locator('[contenteditable="true"]').fill("Send now.");
    await immediateCompose.getByRole("button", { name: "Send", exact: true }).click();
    const sentToast = page.getByRole("status").filter({ hasText: "Message sent." });
    await expect(sentToast).toContainText("Message sent.");
    await expect(sentToast.getByRole("button", { name: "Undo" })).toHaveCount(0);
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("reopens an undone reply without the quoted message in the editor", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-undo-reply-e2e-"));
  writeFileSync(
    path.join(dataDirectory, "desktop-preferences.json"),
    JSON.stringify({
      version: 5,
      appearance: "system",
      dockBadge: true,
      blockRemoteImages: true,
      imageRelay: false,
      undoSendDelaySeconds: 30,
    }),
  );
  const electronApp = await electron.launch({
    args: [mockKeychainArgument, process.cwd()],
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
    await page
      .locator(".thread-row")
      .filter({ hasText: "Welcome to Fluxmail" })
      .locator(".thread-open")
      .click();
    await expect(page.locator(".conversation-title h1")).toHaveText("Welcome to Fluxmail");

    await page
      .locator(".reply-actions")
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await page.locator('.quick-reply [contenteditable="true"]').fill("Reply later.");
    await page.locator(".quick-reply").getByRole("button", { name: "Send", exact: true }).click();

    const undoToast = page.getByRole("status").filter({ hasText: "Message sent." });
    await undoToast.getByRole("button", { name: "Undo" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Sending canceled. The message is in Drafts." }),
    ).toBeVisible();

    const draftEditor = page.locator('.inline-draft-composer [contenteditable="true"]');
    await expect(draftEditor).toHaveText("Reply later.");
    await expect(draftEditor).not.toContainText("Your desktop inbox is ready.");
    await expect(draftEditor).not.toContainText("wrote:");
    await expect(
      page.locator(".inline-draft-composer").getByRole("button", { name: "Show quoted message" }),
    ).toBeVisible();
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("advances after archive unless the setting is disabled", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-iframe-shortcut-e2e-"));
  const electronApp = await electron.launch({
    args: [mockKeychainArgument, process.cwd()],
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
    const welcomeThread = page.locator(".thread-row").filter({ hasText: "Welcome to Fluxmail" });
    await welcomeThread.locator(".thread-open").click();
    await page.keyboard.press("e");

    await expect(welcomeThread).toHaveCount(0);
    await expect(page.locator(".conversation-title h1")).toHaveText("Receipt for Tuesday");
    await expect(page.locator(".thread-row.active")).toContainText("Receipt for Tuesday");
    await expect(page.locator(".thread-open:focus")).toHaveCount(0);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("Action undone")).toBeVisible();
    await expect(
      page.locator(".thread-row").filter({ hasText: "Welcome to Fluxmail" }),
    ).toBeVisible();

    const nextThread = page.locator(".thread-row").filter({ hasText: "Receipt for Tuesday" });
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    const openNextAfterArchiveCheckbox = settings.getByRole("checkbox", {
      name: "Open next conversation after archiving",
    });
    await expect(openNextAfterArchiveCheckbox).toHaveAttribute("aria-checked", "true");
    await openNextAfterArchiveCheckbox.click();
    await expect(openNextAfterArchiveCheckbox).toHaveAttribute("aria-checked", "false");
    await settings.getByRole("button", { name: "Close settings" }).click();

    const messageFrame = page.frameLocator('iframe[title="Email message"]');
    await messageFrame.locator("#email-root").click();
    await page.keyboard.press("e");

    await expect(page.locator(".reading-placeholder")).toBeVisible();
    await expect(nextThread).toHaveCount(0);
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("opens DevTools at the bottom without changing window drag regions", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-devtools-e2e-"));
  const electronApp = await electron.launch({
    args: [mockKeychainArgument, process.cwd()],
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
    const threadHeader = page.locator(".thread-header");
    const sidebarTitlebar = page.locator(".sidebar-titlebar");
    await page.locator(".thread-row").first().locator(".thread-open").click();
    const readingToolbar = page.locator(".reading-toolbar");
    await expect(threadHeader).toHaveCSS("-webkit-app-region", "drag");
    await expect(sidebarTitlebar).toHaveCSS("-webkit-app-region", "drag");
    await expect(readingToolbar).toHaveCSS("-webkit-app-region", "drag");

    const initialViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await electronApp.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const toggleDevTools = Menu.getApplicationMenu()?.getMenuItemById("toggle-devtools-bottom");
      if (!window || !toggleDevTools) throw new Error("DevTools menu item is unavailable.");
      Reflect.apply(toggleDevTools.click, toggleDevTools, [toggleDevTools, window, {}]);
    });
    await expect
      .poll(async () => {
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        return viewport.width === initialViewport.width && viewport.height < initialViewport.height;
      })
      .toBe(true);
    await expect(threadHeader).toHaveCSS("-webkit-app-region", "drag");
    await expect(sidebarTitlebar).toHaveCSS("-webkit-app-region", "drag");
    await expect(readingToolbar).toHaveCSS("-webkit-app-region", "drag");
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("saves modal and inline drafts before closing the window", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-window-close-e2e-"));
  const electronApp = await electron.launch({
    args: [mockKeychainArgument, process.cwd()],
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
    await page.getByRole("button", { name: "Compose" }).click();
    const compose = page.getByRole("dialog", { name: "New message" });
    await compose
      .locator("label")
      .filter({ hasText: /^Subject/ })
      .locator("input")
      .fill("Saved during window close");

    const nextWindow = electronApp.waitForEvent("window");
    const windowClosed = page.waitForEvent("close");
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await windowClosed;
    await electronApp.evaluate(({ app }) => app.emit("activate"));
    const reopened = await nextWindow;
    await expect(reopened.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await reopened.getByRole("button", { name: "Drafts" }).click();
    await expect(reopened.getByText("Saved during window close", { exact: true })).toBeVisible();

    const savedDraft = reopened
      .locator(".thread-row")
      .filter({ hasText: "Saved during window close" });
    await savedDraft.locator(".thread-open").click();
    const inlineDraft = reopened.getByRole("region", { name: "Draft" });
    await inlineDraft.getByLabel("Subject").fill("Inline draft saved during window close");

    const finalWindow = electronApp.waitForEvent("window");
    const reopenedClosed = reopened.waitForEvent("close");
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await reopenedClosed;
    await electronApp.evaluate(({ app }) => app.emit("activate"));
    const finalPage = await finalWindow;
    await expect(finalPage.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await finalPage.getByRole("button", { name: "Drafts" }).click();
    await expect(
      finalPage.getByText("Inline draft saved during window close", { exact: true }),
    ).toBeVisible();
  } finally {
    await electronApp.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("starts the packaged app with the bundled Fluxmail service", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "fluxmail-packaged-smoke-"));
  const executable = path.join(
    process.cwd(),
    `out/Fluxmail-darwin-${process.arch}`,
    "Fluxmail.app/Contents/MacOS/Fluxmail",
  );
  const child = spawn(
    executable,
    [mockKeychainArgument, `--user-data-dir=${path.join(dataDirectory, "user-data")}`],
    {
      env: {
        ...process.env,
        FLUXMAIL_DESKTOP_E2E_HEADLESS: "1",
        FLUXMAIL_DATA_DIR: path.join(dataDirectory, ".fluxmail"),
        FLUXMAIL_TELEMETRY: "0",
      },
      stdio: "pipe",
    },
  );

  try {
    const status = await Promise.race([
      new Promise<string>((resolve) =>
        child.once("exit", (code, signal) => resolve(`exit:${code}:${signal}`)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("running"), 3_000)),
    ]);
    expect(status).toBe("running");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    rmSync(dataDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
