import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
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
  sendAsIdentitySchema,
  sendResultSchema,
  scheduledSendCancelInputSchema,
  scheduledSendCancelResultSchema,
  scheduledSendInputSchema,
  scheduledSendResultSchema,
  telemetryStatusSchema,
  threadListInputSchema,
  threadPageSchema,
  threadSchema,
  threadTargetSchema,
  undoSendDelaySecondsSchema,
  type FluxmailDesktopApi,
} from "../shared/contracts";

const api: FluxmailDesktopApi = {
  bootstrap: () => invoke(IPC.bootstrap, undefined, z.undefined(), bootstrapSchema),
  accounts: {
    list: () => invoke(IPC.accountsList, undefined, z.undefined(), z.array(accountSchema)),
    connectGmail: () => invoke(IPC.accountsConnect, undefined, z.undefined(), accountSchema),
    reconnect: (accountId) => invoke(IPC.accountsReconnect, accountId, z.string(), accountSchema),
    remove: (accountId) => invoke(IPC.accountsRemove, accountId, z.string(), z.void()),
    sendAs: (accountId) =>
      invoke(IPC.accountsSendAs, accountId, z.string(), z.array(sendAsIdentitySchema)),
  },
  mail: {
    listThreads: (input) => invoke(IPC.mailList, input, threadListInputSchema, threadPageSchema),
    search: (input) => invoke(IPC.mailSearch, input, threadListInputSchema, threadPageSchema),
    getThread: (target) => invoke(IPC.mailThread, target, threadTargetSchema, threadSchema),
    modify: (input) => invoke(IPC.mailModify, input, mailModifyInputSchema, mailModifyResultSchema),
    undo: (input) => invoke(IPC.mailUndo, input, mailUndoInputSchema, mailUndoResultSchema),
    forward: (input) =>
      invoke(IPC.mailForward, input, mailForwardInputSchema, scheduledSendResultSchema.optional()),
  },
  drafts: {
    save: (input) => invoke(IPC.draftSave, input, composeInputSchema, draftResultSchema),
    delete: (input) => invoke(IPC.draftDelete, input, draftDeleteInputSchema, z.void()),
    recipientFields: (input) =>
      invoke(
        IPC.draftRecipientFields,
        input,
        draftRecipientFieldsInputSchema,
        draftRecipientFieldsSchema.optional(),
      ),
    send: (input) => invoke(IPC.draftSend, input, sendInputSchema, sendResultSchema),
    schedule: (input) =>
      invoke(IPC.draftSchedule, input, scheduledSendInputSchema, scheduledSendResultSchema),
    cancelScheduled: (input) =>
      invoke(
        IPC.draftCancelScheduled,
        input,
        scheduledSendCancelInputSchema,
        scheduledSendCancelResultSchema,
      ),
  },
  attachments: {
    pick: () =>
      invoke(IPC.attachmentPick, undefined, z.undefined(), z.array(composeAttachmentSchema)),
    prepare: (input) =>
      invoke(
        IPC.attachmentPrepare,
        input,
        attachmentPrepareInputSchema,
        z.array(composeAttachmentSchema),
      ),
    release: (tokens) =>
      invoke(IPC.attachmentRelease, tokens, attachmentReleaseInputSchema, z.void()),
    save: (input) => invoke(IPC.attachmentSave, input, attachmentSaveInputSchema, z.boolean()),
    inlineData: (input) =>
      invoke(IPC.attachmentInline, input, attachmentInlineInputSchema, z.string()),
  },
  sync: {
    refresh: (input = { view: "inbox" }) =>
      invoke(IPC.syncRefresh, input, threadListInputSchema, z.void()),
  },
  telemetry: {
    getStatus: () => invoke(IPC.telemetryStatus, undefined, z.undefined(), telemetryStatusSchema),
    setEnabled: (enabled) => invoke(IPC.telemetrySet, enabled, z.boolean(), telemetryStatusSchema),
  },
  preferences: {
    setAppearance: (appearance) =>
      invoke(
        IPC.preferencesAppearanceSet,
        appearance,
        appearancePreferenceSchema,
        appearancePreferenceSchema,
      ),
    setDockBadge: (enabled) =>
      invoke(IPC.preferencesDockBadgeSet, enabled, z.boolean(), z.boolean()),
    setOpenNextAfterArchive: (enabled) =>
      invoke(IPC.preferencesOpenNextAfterArchiveSet, enabled, z.boolean(), z.boolean()),
    setBlockRemoteImages: (enabled) =>
      invoke(IPC.preferencesBlockRemoteImagesSet, enabled, z.boolean(), z.boolean()),
    setImageRelay: (enabled) =>
      invoke(IPC.preferencesImageRelaySet, enabled, z.boolean(), z.boolean()),
    setUndoSendDelaySeconds: (delay) =>
      invoke(
        IPC.preferencesUndoSendDelaySet,
        delay,
        undoSendDelaySecondsSchema,
        undoSendDelaySecondsSchema,
      ),
  },
  images: {
    proxy: (urls) => invoke(IPC.imagesProxy, urls, imageRelayInputSchema, imageRelayResultSchema),
  },
  license: {
    activate: (key) =>
      invoke(IPC.licenseActivate, key, licenseKeySchema, licenseActivationResultSchema),
  },
  analytics: {
    trackFeature: (event) => invoke(IPC.analyticsFeature, event, featureEventSchema, z.void()),
  },
  system: {
    openExternal: (url) => invoke(IPC.systemOpenExternal, url, z.string().url(), z.void()),
    openLegalNotices: () => invoke(IPC.systemOpenLegalNotices, undefined, z.undefined(), z.void()),
    cancelWindowClose: () =>
      invoke(IPC.systemWindowCloseCancel, undefined, z.undefined(), z.void()),
    confirmWindowClose: () =>
      invoke(IPC.systemWindowCloseConfirm, undefined, z.undefined(), z.void()),
    restart: () => invoke(IPC.systemRestart, undefined, z.undefined(), z.void()),
  },
  onEvent(callback) {
    const listener = (_event: Electron.IpcRendererEvent, raw: unknown) =>
      callback(appEventSchema.parse(raw));
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
};

async function invoke<TInputSchema extends z.ZodTypeAny, TOutputSchema extends z.ZodTypeAny>(
  channel: string,
  rawInput: z.input<TInputSchema>,
  inputSchema: TInputSchema,
  outputSchema: TOutputSchema,
): Promise<z.output<TOutputSchema>> {
  const input = inputSchema.parse(rawInput);
  try {
    return outputSchema.parse(await ipcRenderer.invoke(channel, input));
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error("Fluxmail received data that did not match the desktop contract.");
    throw normalizeIpcError(error);
  }
}

function normalizeIpcError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : "Fluxmail could not complete that request.";
  const marker = raw.indexOf("FLUXMAIL_APP_ERROR:");
  if (marker >= 0) {
    try {
      const details = appErrorSchema.parse(
        JSON.parse(raw.slice(marker + "FLUXMAIL_APP_ERROR:".length)),
      );
      return Object.assign(new Error(details.message), {
        name: "FluxmailError",
        code: details.code,
        retryable: details.retryable,
        details: details.details,
      });
    } catch {
      // Fall through to a generic bridge error if the serialized error was malformed.
    }
  }
  const message = raw.replace(/^Error invoking remote method '[^']+': Error:\s*/, "");
  const normalized = new Error(message);
  normalized.name = "FluxmailError";
  return normalized;
}

contextBridge.exposeInMainWorld("fluxmail", api);
