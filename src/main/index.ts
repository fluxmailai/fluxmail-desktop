import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  shell,
  type IpcMainInvokeEvent,
  type MenuItem,
  type MenuItemConstructorOptions,
} from "electron";
import { z } from "zod";
import { isEmailError, type AttachmentInput } from "@fluxmail/core";
import * as fluxmail from "fluxmail";
import {
  accountSchema,
  appearancePreferenceSchema,
  appErrorSchema,
  appEventSchema,
  attachmentInlineInputSchema,
  attachmentPrepareInputSchema,
  attachmentReleaseInputSchema,
  attachmentSaveInputSchema,
  bootstrapSchema,
  composeAttachmentSchema,
  composeInputSchema,
  draftDeleteInputSchema,
  draftRecipientFieldsInputSchema,
  draftRecipientFieldsSchema,
  draftResultSchema,
  featureEventSchema,
  imageRelayInputSchema,
  imageRelayResultSchema,
  IPC,
  licenseActivationResultSchema,
  licenseKeySchema,
  mailForwardInputSchema,
  mailModifyInputSchema,
  mailModifyResultSchema,
  mailUndoInputSchema,
  mailUndoResultSchema,
  sendInputSchema,
  sendResultSchema,
  scheduledSendCancelInputSchema,
  scheduledSendCancelResultSchema,
  scheduledSendInputSchema,
  scheduledSendResultSchema,
  telemetryStatusSchema,
  undoSendDelaySecondsSchema,
  threadListInputSchema,
  threadPageSchema,
  threadSchema,
  threadTargetSchema,
  type AccountInfo,
  type AppEvent,
  type ComposeAttachment,
  type SyncState,
  type ThreadListInput,
} from "../shared/contracts";
import { parseExternalUrl } from "../shared/external-url";
import { contextMenuTemplate } from "./context-menu";
import { openLegalNotices } from "./legal-notices";
import { DesktopAnalytics } from "./analytics";
import { MailCache } from "./cache";
import { createCacheCipher } from "./cache-cipher";
import { FluxmailRuntime, prepareFluxmailConfiguration } from "./fluxmail-runtime";
import { FakeFluxmailRuntime } from "./fake-runtime";
import { isAllowedFrameUrl } from "./ipc-security";
import { HostedImageRelay, HostedImageRelayAccess } from "./image-relay";
import { createLaunchTimer } from "./performance";
import { DesktopPreferences } from "./preferences";

app.setName("Fluxmail");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

process.umask(0o077);
process.env.FLUXMAIL_DATA_DIR ??= path.join(homedir(), ".fluxmail");

let mainWindow: BrowserWindow | null = null;
let runtime: FluxmailRuntime | FakeFluxmailRuntime | null = null;
let analytics: DesktopAnalytics | null = null;
let cache: MailCache | null = null;
let preferences: DesktopPreferences | null = null;
let imageRelay: HostedImageRelay | null = null;
let imageRelayAccess: HostedImageRelayAccess | null = null;
let pollTimer: NodeJS.Timeout | undefined;
let syncState: SyncState = { status: "idle" };
let activeMailboxInput: ThreadListInput = { view: "inbox", pageSize: 100 };
let rendererReady = false;
let windowCloseConfirmed = false;
let windowClosePending = false;
let quitAfterWindowClose = false;
let shutdownStarted = false;
let inboxPerformanceCaptured = false;
let attachmentGeneration = 0;
let startupError: unknown;
const pendingAttachments = new Map<
  string,
  {
    path?: string;
    content?: Buffer;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentId?: string;
    disposition?: "inline" | "attachment";
  }
>();

if (!app.isPackaged && process.env.FLUXMAIL_DESKTOP_TEST_DATA_DIR) {
  app.setPath("userData", process.env.FLUXMAIL_DESKTOP_TEST_DATA_DIR);
}

if (!app.requestSingleInstanceLock()) {
  if (!app.isPackaged) {
    console.error(
      "Fluxmail could not start because another instance is already running. Quit Fluxmail and stop any other Fluxmail development session, then try again.",
    );
  }
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      if (process.platform === "darwin" && app.dock) {
        if (!app.isPackaged) app.dock.setIcon(path.join(app.getAppPath(), "build/icon.png"));
        app.dock.setBadge("");
      }
      preferences = new DesktopPreferences(app.getPath("userData"));
      nativeTheme.themeSource = await preferences.load();
      nativeTheme.on("updated", updateWindowBackground);
      registerAppProtocol();
      try {
        await createServices();
        updateDockBadge();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "incompatible_store") throw error;
        startupError = error;
        await analytics?.shutdown().catch(() => undefined);
        cache?.close();
        runtime = null;
        analytics = null;
        cache = null;
      }
      registerIpc();
      createWindow();
      configureApplicationMenu();
      if (!startupError) {
        void refresh("startup");
        powerMonitor.on("resume", () => void refresh("resume"));
      }
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch(showFatalError);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted) {
    event.preventDefault();
    return;
  }
  if (!runtime || !analytics || !cache) return;
  event.preventDefault();
  quitAfterWindowClose = true;
  if (mainWindow) mainWindow.close();
  else void shutdownAndExit();
});

async function createServices(): Promise<void> {
  const fluxmailDataDir = process.env.FLUXMAIL_DATA_DIR!;
  analytics = new DesktopAnalytics({ dataDir: fluxmailDataDir });
  prepareFluxmailConfiguration(
    fluxmail,
    __FLUXMAIL_GOOGLE_CLIENT_ID__,
    __FLUXMAIL_GOOGLE_CLIENT_SECRET__,
  );
  cache = new MailCache(
    app.getPath("userData"),
    createCacheCipher(fluxmail.loadConfig().encryptionKey),
  );
  const onCacheChanged = () => {
    sendEvent({ type: "cache-changed" });
    updateDockBadge();
  };
  const onLicenseChanged = () => {
    void disableImageRelayIfUnavailable().finally(() => sendEvent({ type: "license-changed" }));
  };
  runtime =
    !app.isPackaged && process.env.FLUXMAIL_DESKTOP_FAKE_MAIL === "1"
      ? new FakeFluxmailRuntime({ analytics, onCacheChanged, onLicenseChanged })
      : new FluxmailRuntime({
          cache,
          analytics,
          openExternal: openTrustedExternal,
          resolveAttachment,
          onNewMessages: showNewMail,
          onCacheChanged,
          onLicenseChanged,
        });
  await runtime.initialize();
  analytics.captureStarted({
    cacheState: cache.hasCachedMail ? "hit" : "miss",
    onboardingComplete: runtime.accounts().length > 0,
  });
}

function createWindow(): void {
  const launchDuration = createLaunchTimer();
  rendererReady = false;
  windowCloseConfirmed = false;
  windowClosePending = false;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: "Fluxmail",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: windowBackgroundColor(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => {
    analytics?.capturePerformance({
      metric: "warm_launch",
      durationMs: launchDuration(),
      cacheHit: cache?.hasCachedMail ?? false,
    });
    if (process.env.FLUXMAIL_DESKTOP_E2E_HEADLESS !== "1") mainWindow?.show();
  });
  mainWindow.on("focus", schedulePolling);
  mainWindow.on("blur", schedulePolling);
  mainWindow.on("close", (event) => {
    if (windowCloseConfirmed || !rendererReady) return;
    event.preventDefault();
    windowClosePending = true;
    sendEvent({ type: "window-close-requested" });
  });
  mainWindow.on("closed", () => {
    resetPendingAttachments();
    mainWindow = null;
    rendererReady = false;
    windowClosePending = false;
    if (quitAfterWindowClose) void shutdownAndExit();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
  });
  mainWindow.webContents.on("render-process-gone", () => {
    resetPendingAttachments();
    rendererReady = false;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openTrustedExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const webContents = mainWindow?.webContents;
    if (!webContents) return;
    const template = contextMenuTemplate(params, {
      openExternal: (url) => void openTrustedExternal(url).catch(() => undefined),
      copyText: (text) => clipboard.writeText(text),
      copyImageAt: (x, y) => webContents.copyImageAt(x, y),
      replaceMisspelling: (word) => webContents.replaceMisspelling(word),
      addToDictionary: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
    });
    if (template.length)
      Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined });
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      void openTrustedExternal(url).catch(() => undefined);
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch(showFatalError);
  } else {
    void mainWindow.loadURL("app://fluxmail/index.html").catch(showFatalError);
  }
}

function configureApplicationMenu(): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu.items.map(applicationMenuItemTemplate)));
}

function applicationMenuItemTemplate(item: MenuItem): MenuItemConstructorOptions {
  if (item.role?.toLowerCase() === "editmenu") {
    return {
      label: item.label,
      submenu: [
        ...(item.submenu?.items.map(applicationMenuItemTemplate) ?? []),
        { type: "separator" },
        {
          id: "find-in-conversation",
          label: "Find in Conversation",
          accelerator: "CmdOrCtrl+F",
          click: () => sendEvent({ type: "find-in-conversation-requested" }),
        },
      ],
    };
  }
  if (item.role?.toLowerCase() === "toggledevtools") {
    return {
      id: "toggle-devtools-bottom",
      label: item.label,
      accelerator: item.accelerator ?? undefined,
      click: (_menuItem, targetWindow) => {
        const window =
          targetWindow instanceof BrowserWindow ? targetWindow : BrowserWindow.getFocusedWindow();
        if (!window) return;
        if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
        else window.webContents.openDevTools({ mode: "bottom" });
      },
    };
  }
  if (item.type === "separator") return { type: "separator" };
  if (item.role?.toLowerCase() !== "viewmenu" && item.role) return { role: item.role };
  return {
    id: item.id || undefined,
    label: item.label,
    submenu: item.submenu?.items.map(applicationMenuItemTemplate),
    accelerator: item.accelerator ?? undefined,
    click: item.submenu ? undefined : (item.click as MenuItemConstructorOptions["click"]),
    enabled: item.enabled,
    visible: item.visible,
  };
}

function registerAppProtocol(): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) return;
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).replace(
        /^\/+/,
        "",
      );
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const rendererRoot = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
    const target = path.resolve(rendererRoot, relative);
    const relativeTarget = path.relative(rendererRoot, target);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget))
      return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
}

function registerIpc(): void {
  handle(IPC.bootstrap, z.undefined(), bootstrapSchema, async () => {
    if (startupError) throw startupError;
    await disableImageRelayIfUnavailable();
    const bootstrap = await requireRuntime().bootstrap(syncState);
    return {
      ...bootstrap,
      desktopVersion: app.getVersion(),
      preferences: {
        appearance: requirePreferences().appearance(),
        dockBadge: requirePreferences().dockBadge(),
        openNextAfterArchive: requirePreferences().openNextAfterArchive(),
        blockRemoteImages: requirePreferences().blockRemoteImages(),
        imageRelay: requirePreferences().imageRelay(),
        undoSendDelaySeconds: requirePreferences().undoSendDelaySeconds(),
      },
    };
  });
  handle(IPC.accountsList, z.undefined(), z.array(accountSchema), async () =>
    requireRuntime().accounts(),
  );
  handle(IPC.accountsConnect, z.undefined(), accountSchema, async () => {
    const account = await requireRuntime().connectGmail();
    sendEvent({ type: "accounts-changed" });
    await refresh("mutation");
    return account;
  });
  handle(IPC.accountsReconnect, z.string(), accountSchema, async (accountId) => {
    const account = await requireRuntime().connectGmail(accountId);
    sendEvent({ type: "accounts-changed" });
    await refresh("mutation");
    return account;
  });
  handle(IPC.accountsRemove, z.string(), z.void(), async (accountId) => {
    requireRuntime().removeAccount(accountId);
    sendEvent({ type: "accounts-changed" });
  });
  handle(IPC.mailList, threadListInputSchema, threadPageSchema, async (input) => {
    activeMailboxInput = mailboxRefreshInput(input);
    const started = performance.now();
    const cacheHit = cache?.hasAnyThreads() ?? false;
    const page = await requireRuntime().listThreads(input);
    if (!input.cursor) {
      const firstInbox = input.view === "inbox" && !inboxPerformanceCaptured;
      requireAnalytics().capturePerformance({
        metric: firstInbox ? "cached_inbox_paint" : "folder_switch",
        durationMs: performance.now() - started,
        cacheHit,
      });
      if (firstInbox) inboxPerformanceCaptured = true;
    }
    return page;
  });
  handle(IPC.mailSearch, threadListInputSchema, threadPageSchema, async (input) => {
    activeMailboxInput = mailboxRefreshInput(input);
    return requireRuntime().listThreads(input, true);
  });
  handle(IPC.mailThread, threadTargetSchema, threadSchema, async (target) => {
    const started = performance.now();
    const cacheHit = cache?.hasThreadBody(target.accountId, target.threadId) ?? false;
    const thread = await requireRuntime().getThread(target.accountId, target.threadId);
    requireAnalytics().capturePerformance({
      metric: "thread_open",
      durationMs: performance.now() - started,
      cacheHit,
    });
    return thread;
  });
  handle(
    IPC.mailModify,
    mailModifyInputSchema,
    mailModifyResultSchema,
    async ({ targets, action, undoable }) => requireRuntime().modify(targets, action, undoable),
  );
  handle(IPC.mailUndo, mailUndoInputSchema, mailUndoResultSchema, async ({ token }) =>
    requireRuntime().undo(token),
  );
  handle(
    IPC.mailForward,
    mailForwardInputSchema,
    scheduledSendResultSchema.optional(),
    async ({ target, ...input }) =>
      requireRuntime().forward({ accountId: target.accountId, ...input }),
  );
  handle(IPC.draftSave, composeInputSchema, draftResultSchema, async (input) =>
    requireRuntime().saveDraft(input),
  );
  handle(IPC.draftDelete, draftDeleteInputSchema, z.void(), async (input) =>
    requireRuntime().deleteDraft(input.accountId, input.draftId),
  );
  handle(
    IPC.draftRecipientFields,
    draftRecipientFieldsInputSchema,
    draftRecipientFieldsSchema.optional(),
    (input) => requireRuntime().draftRecipientFields(input.accountId, input.draftId),
  );
  handle(IPC.draftSend, sendInputSchema, sendResultSchema, async (input) =>
    requireRuntime().send(input),
  );
  handle(IPC.draftSchedule, scheduledSendInputSchema, scheduledSendResultSchema, (input) =>
    requireRuntime().schedule(input),
  );
  handle(
    IPC.draftCancelScheduled,
    scheduledSendCancelInputSchema,
    scheduledSendCancelResultSchema,
    (input) => requireRuntime().cancelScheduled(input.scheduleId),
  );
  handle(IPC.attachmentPick, z.undefined(), z.array(composeAttachmentSchema), pickAttachments);
  handle(
    IPC.attachmentPrepare,
    attachmentPrepareInputSchema,
    z.array(composeAttachmentSchema),
    prepareAttachments,
  );
  handle(IPC.attachmentRelease, attachmentReleaseInputSchema, z.void(), (tokens) => {
    for (const token of tokens) pendingAttachments.delete(token);
  });
  handle(IPC.attachmentSave, attachmentSaveInputSchema, z.boolean(), saveAttachment);
  handle(IPC.attachmentInline, attachmentInlineInputSchema, z.string(), async (input) => {
    const result = await requireRuntime().attachment(
      input.accountId,
      input.messageId,
      input.attachmentId,
    );
    return `data:${safeMimeType(result.meta.mimeType)};base64,${result.content.toString("base64")}`;
  });
  handle(IPC.syncRefresh, threadListInputSchema, z.void(), async (input) => {
    activeMailboxInput = mailboxRefreshInput(input);
    await refresh("manual", activeMailboxInput);
  });
  handle(IPC.telemetryStatus, z.undefined(), telemetryStatusSchema, async () =>
    requireAnalytics().status(),
  );
  handle(IPC.telemetrySet, z.boolean(), telemetryStatusSchema, async (enabled) =>
    requireAnalytics().setEnabled(enabled),
  );
  handle(
    IPC.preferencesAppearanceSet,
    appearancePreferenceSchema,
    appearancePreferenceSchema,
    async (appearance) => {
      const value = await requirePreferences().setAppearance(appearance);
      nativeTheme.themeSource = value;
      updateWindowBackground();
      return value;
    },
  );
  handle(IPC.preferencesDockBadgeSet, z.boolean(), z.boolean(), async (enabled) => {
    const value = await requirePreferences().setDockBadge(enabled);
    updateDockBadge();
    return value;
  });
  handle(IPC.preferencesOpenNextAfterArchiveSet, z.boolean(), z.boolean(), (enabled) =>
    requirePreferences().setOpenNextAfterArchive(enabled),
  );
  handle(IPC.preferencesBlockRemoteImagesSet, z.boolean(), z.boolean(), (enabled) =>
    requirePreferences().setBlockRemoteImages(enabled),
  );
  handle(IPC.licenseActivate, licenseKeySchema, licenseActivationResultSchema, (key) =>
    requireRuntime().activateLicense(key),
  );
  handle(IPC.preferencesImageRelaySet, z.boolean(), z.boolean(), async (enabled) => {
    if (enabled && !requireRuntime().license().canUsePrivateImageRelay) {
      throw new Error("Private image relay is available on Pro, Team, and Enterprise.");
    }
    return requirePreferences().setImageRelay(enabled);
  });
  handle(
    IPC.preferencesUndoSendDelaySet,
    undoSendDelaySecondsSchema,
    undoSendDelaySecondsSchema,
    (delay) => requirePreferences().setUndoSendDelaySeconds(delay),
  );
  handle(IPC.imagesProxy, imageRelayInputSchema, imageRelayResultSchema, (urls) =>
    requireImageRelay().proxy(urls),
  );
  handle(IPC.analyticsFeature, featureEventSchema, z.void(), async (event) =>
    requireAnalytics().captureFeature(event),
  );
  handle(IPC.systemOpenExternal, z.string().url(), z.void(), openTrustedExternal);
  handle(IPC.systemOpenLegalNotices, z.undefined(), z.void(), () =>
    openLegalNotices({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repositoryRoot: process.cwd(),
      openPath: (filePath) => shell.openPath(filePath),
    }),
  );
  handle(IPC.systemWindowCloseCancel, z.undefined(), z.void(), () => {
    windowClosePending = false;
    quitAfterWindowClose = false;
  });
  handle(IPC.systemWindowCloseConfirm, z.undefined(), z.void(), () => {
    if (!windowClosePending || !mainWindow) return;
    windowClosePending = false;
    windowCloseConfirmed = true;
    mainWindow.close();
  });
  handle(IPC.systemRestart, z.undefined(), z.void(), () => {
    app.relaunch();
    setImmediate(() => app.quit());
  });
}

async function shutdownAndExit(): Promise<void> {
  if (shutdownStarted || !runtime || !analytics || !cache) return;
  shutdownStarted = true;
  clearTimeout(pollTimer);
  const currentRuntime = runtime;
  const currentAnalytics = analytics;
  const currentCache = cache;
  runtime = null;
  analytics = null;
  cache = null;
  await Promise.allSettled([currentRuntime.shutdown(), currentAnalytics.shutdown()]);
  currentCache.close();
  app.exit(0);
}

function handle<TSchema extends z.ZodTypeAny, TResultSchema extends z.ZodTypeAny>(
  channel: string,
  schema: TSchema,
  resultSchema: TResultSchema,
  callback: (
    input: z.infer<TSchema>,
    event: IpcMainInvokeEvent,
  ) => Promise<z.input<TResultSchema>> | z.input<TResultSchema>,
): void {
  ipcMain.handle(channel, async (event, rawInput) => {
    try {
      validateSender(event);
      return resultSchema.parse(await callback(schema.parse(rawInput), event));
    } catch (error) {
      throw publicError(error);
    }
  });
}

function validateSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!isAppUrl(url)) throw new Error("Fluxmail blocked a request from an unknown window.");
}

function isAppUrl(url: string): boolean {
  return isAllowedFrameUrl(url, MAIN_WINDOW_VITE_DEV_SERVER_URL);
}

async function refresh(
  trigger: "startup" | "poll" | "manual" | "resume" | "mutation",
  input: ThreadListInput = activeMailboxInput,
): Promise<void> {
  if (!runtime || syncState.status === "syncing") return;
  setSyncState({ status: "syncing", lastSyncedAt: syncState.lastSyncedAt });
  try {
    await runtime.refresh(trigger, input);
    setSyncState({ status: "idle", lastSyncedAt: new Date().toISOString() });
  } catch (error) {
    setSyncState({
      status: net.isOnline() ? "error" : "offline",
      error: publicErrorPayload(error).message,
      lastSyncedAt: syncState.lastSyncedAt,
    });
  } finally {
    schedulePolling();
  }
}

function schedulePolling(): void {
  clearTimeout(pollTimer);
  if (!runtime) return;
  const delay = mainWindow?.isFocused() ? 30_000 : 120_000;
  pollTimer = setTimeout(() => void refresh("poll"), delay);
  pollTimer.unref();
}

function setSyncState(state: SyncState): void {
  syncState = state;
  sendEvent({ type: "sync-status", state });
}

function sendEvent(event: AppEvent): void {
  const safeEvent = appEventSchema.parse(event);
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.event, safeEvent);
}

function showNewMail(
  messages: Array<{ from?: { name?: string; email: string }; subject: string }>,
  account: AccountInfo,
): void {
  if (!Notification.isSupported() || !messages.length) return;
  const count = messages.length;
  const latest = messages[0]!;
  const notification = new Notification({
    title:
      count === 1
        ? latest.from?.name || latest.from?.email || account.email
        : `${count} new messages`,
    body: count === 1 ? latest.subject || "(no subject)" : `New mail in ${account.email}`,
    silent: false,
  });
  notification.on("click", () => {
    if (!mainWindow) createWindow();
    mainWindow?.show();
    mainWindow?.focus();
  });
  notification.show();
  sendEvent({ type: "new-mail", count });
}

function updateDockBadge(): void {
  if (process.platform !== "darwin" || !app.dock || !cache) return;
  if (!preferences?.dockBadge()) {
    app.dock.setBadge("");
    return;
  }
  const count = runtime?.unreadCount() ?? cache.unreadCount();
  app.dock.setBadge(count > 0 ? String(count) : "");
}

function mailboxRefreshInput(input: ThreadListInput): ThreadListInput {
  return {
    view: input.view,
    ...(input.accountIds?.length ? { accountIds: input.accountIds } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.query?.trim() ? { query: input.query.trim() } : {}),
    pageSize: input.pageSize ?? 100,
  };
}

function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#28292c" : "#f8f7f3";
}

function updateWindowBackground(): void {
  for (const window of BrowserWindow.getAllWindows())
    window.setBackgroundColor(windowBackgroundColor());
}

async function pickAttachments(): Promise<ComposeAttachment[]> {
  const generation = attachmentGeneration;
  const options: Electron.OpenDialogOptions = {
    properties: ["openFile", "multiSelections"],
    title: "Attach files",
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  if (result.filePaths.length > 20) throw new Error("You can attach up to 20 files at a time.");
  const attachments = await Promise.all(
    result.filePaths.map(async (filePath) => {
      const file = await stat(filePath);
      const maximum = requireRuntime().maxAttachmentBytes();
      if (file.size > maximum)
        throw new Error(`This attachment is larger than Fluxmail's ${formatBytes(maximum)} limit.`);
      return {
        path: filePath,
        filename: path.basename(filePath),
        mimeType: mimeTypeFor(filePath),
        sizeBytes: file.size,
      };
    }),
  );
  if (generation !== attachmentGeneration) return [];
  return attachments.map((attachment) => {
    const token = randomUUID();
    pendingAttachments.set(token, attachment);
    return {
      token,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  });
}

async function resolveAttachment(attachment: ComposeAttachment): Promise<AttachmentInput> {
  const pending = pendingAttachments.get(attachment.token);
  if (!pending || pending.filename !== attachment.filename)
    throw new Error("One of the attachments is no longer available.");
  const content = pending.content ?? (pending.path ? await readFile(pending.path) : undefined);
  if (!content) throw new Error("One of the attachments is no longer available.");
  if (content.byteLength > requireRuntime().maxAttachmentBytes())
    throw new Error("One of the attachments is now too large to send.");
  return {
    filename: pending.filename,
    mimeType: pending.mimeType,
    content: content.toString("base64"),
    ...(pending.contentId ? { contentId: pending.contentId } : {}),
    ...(pending.disposition ? { disposition: pending.disposition } : {}),
  };
}

async function prepareAttachments(input: {
  accountId: string;
  messageId: string;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentId?: string;
    disposition?: "inline" | "attachment";
  }>;
}): Promise<ComposeAttachment[]> {
  const generation = attachmentGeneration;
  const downloaded = await Promise.all(
    input.attachments.map(async (attachment) => {
      const result = await requireRuntime().attachment(
        input.accountId,
        input.messageId,
        attachment.id,
      );
      return {
        content: result.content,
        filename: result.meta.filename,
        mimeType: result.meta.mimeType,
        sizeBytes: result.content.byteLength,
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
        ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
      };
    }),
  );
  if (generation !== attachmentGeneration) return [];
  return downloaded.map((pending) => {
    const token = randomUUID();
    pendingAttachments.set(token, pending);
    return {
      token,
      filename: pending.filename,
      mimeType: pending.mimeType,
      sizeBytes: pending.sizeBytes,
      ...(pending.contentId ? { contentId: pending.contentId } : {}),
      ...(pending.disposition ? { disposition: pending.disposition } : {}),
    };
  });
}

function resetPendingAttachments(): void {
  attachmentGeneration += 1;
  pendingAttachments.clear();
}

async function saveAttachment(input: {
  accountId: string;
  messageId: string;
  attachment: { id: string; filename: string; mimeType: string };
}): Promise<boolean> {
  const result = await requireRuntime().attachment(
    input.accountId,
    input.messageId,
    input.attachment.id,
  );
  const options: Electron.SaveDialogOptions = {
    title: "Save attachment",
    defaultPath: path.basename(input.attachment.filename),
  };
  const destination = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return false;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(destination.filePath, result.content, { mode: 0o600 });
  return true;
}

async function openTrustedExternal(rawUrl: string): Promise<void> {
  const url = parseExternalUrl(rawUrl);
  if (!url) throw new Error("Fluxmail only opens web and email links.");
  await shell.openExternal(url.toString());
}

function mimeTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".html": "text/html",
    ".zip": "application/zip",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return types[extension] ?? "application/octet-stream";
}

function safeMimeType(value: string): string {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value) ? value : "application/octet-stream";
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.floor(bytes / 1024 / 1024)} MB`
    : `${Math.floor(bytes / 1024)} KB`;
}

function publicError(error: unknown): Error {
  const payload = publicErrorPayload(error);
  return new Error(`FLUXMAIL_APP_ERROR:${JSON.stringify(payload)}`);
}

function publicErrorPayload(error: unknown): z.infer<typeof appErrorSchema> {
  const providerMessage = isEmailError(error) ? emailErrorMessage(error.code) : undefined;
  const compatibility = (error as { compatibility?: Record<string, unknown> } | null)
    ?.compatibility;
  const incompatibleMessage = compatibilityMessage(compatibility);
  const rawMessage =
    incompatibleMessage ??
    providerMessage ??
    (error instanceof Error ? error.message : "Fluxmail could not complete that request.");
  const message = rawMessage
    .replace(/(?:token|secret|password|key|code)\s*[=:]\s*\S+/gi, "credential=[hidden]")
    .replace(/https?:\/\/\S+/gi, "the mail provider");
  const rawCode = isEmailError(error) ? error.code : (error as { code?: unknown } | null)?.code;
  const code =
    typeof rawCode === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(rawCode)
      ? rawCode.toLowerCase()
      : "desktop_error";
  const retryable = ![
    "auth_expired",
    "invalid_request",
    "not_found",
    "entitlement_exceeded",
    "permission_denied",
    "unsupported_capability",
    "incompatible_store",
  ].includes(code);
  const details = compatibility
    ? Object.fromEntries(
        Object.entries(compatibility).filter(
          (entry): entry is [string, string | number | boolean] =>
            ["string", "number", "boolean"].includes(typeof entry[1]),
        ),
      )
    : undefined;
  const payload = appErrorSchema.parse({
    code,
    message,
    retryable,
    ...(details ? { details } : {}),
  });
  return payload;
}

function compatibilityMessage(compatibility?: Record<string, unknown>): string | undefined {
  if (!compatibility) return undefined;
  const storeFormat = compatibility.storeFormat;
  const maximum = compatibility.maximumSupportedFormat;
  const minimum = compatibility.minimumSupportedFormat;
  if (typeof storeFormat !== "number" || typeof maximum !== "number" || typeof minimum !== "number")
    return undefined;
  if (storeFormat > maximum) {
    return `Your Fluxmail data uses format ${storeFormat}, but this version of Fluxmail Desktop supports up to format ${maximum}. Update Fluxmail Desktop to continue. Your data was not changed.`;
  }
  return `Your Fluxmail data uses format ${storeFormat}, but this version of Fluxmail Desktop supports formats ${minimum} through ${maximum}. Use a compatible Fluxmail version to update the shared data, then reopen Desktop. Your data was not changed.`;
}

function showFatalError(error: unknown): void {
  dialog.showErrorBox("Fluxmail could not start", publicErrorPayload(error).message);
  app.quit();
}

function emailErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    auth_expired: "Gmail access has expired. Reconnect the account in Settings.",
    rate_limited: "Gmail is busy. Try again in a moment.",
    not_found: "That item is no longer available. Refresh your mailbox.",
    invalid_request: "Gmail could not use that request. Check the details and try again.",
    provider_unavailable: "Gmail is unavailable right now. Try again in a moment.",
    entitlement_exceeded: "Your Fluxmail plan has reached its current limit.",
    permission_denied: "This account does not allow that action.",
    unsupported_capability: "This account does not support that action.",
  };
  return messages[code] ?? "Fluxmail could not complete that request.";
}

function requireRuntime(): FluxmailRuntime | FakeFluxmailRuntime {
  if (!runtime) throw new Error("Fluxmail is still starting.");
  return runtime;
}

function requireAnalytics(): DesktopAnalytics {
  if (!analytics) throw new Error("Fluxmail analytics is not ready.");
  return analytics;
}

function requirePreferences(): DesktopPreferences {
  if (!preferences) throw new Error("Fluxmail preferences are not ready.");
  return preferences;
}

async function disableImageRelayIfUnavailable(): Promise<void> {
  try {
    if (!runtime || !preferences) return;
    if (!runtime.license().canUsePrivateImageRelay && preferences.imageRelay()) {
      await preferences.setImageRelay(false);
    }
  } catch {
    // Leave the saved preference untouched when the license state is unknown.
  }
}

function requireImageRelay(): HostedImageRelay {
  imageRelayAccess ??= new HostedImageRelayAccess(
    (forceRefresh) => requireRuntime().imageRelayLicenseLease(forceRefresh),
    (input, init) => net.fetch(input, init),
    () => requireRuntime().imageRelayAccessDenied(),
  );
  imageRelay ??= new HostedImageRelay(
    (forceRefresh) => imageRelayAccess!.token(forceRefresh),
    (input, init) => net.fetch(input, init),
  );
  return imageRelay;
}
