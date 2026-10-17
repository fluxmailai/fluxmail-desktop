import { z } from "zod";

export const mailboxViewSchema = z.enum([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "scheduled",
  "all",
  "spam",
  "trash",
  "label",
  "search",
]);
export type MailboxView = z.infer<typeof mailboxViewSchema>;

export const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().optional(),
  provider: z.enum(["gmail", "outlook", "imap"]),
  status: z.enum(["active", "auth_error", "disabled"]),
  canPermanentlyDelete: z.boolean().optional(),
});
export type AccountInfo = z.infer<typeof accountSchema>;

export const sendAsIdentitySchema = z.object({
  email: z.string(),
  name: z.string().optional(),
  isPrimary: z.boolean(),
});
export type SendAsIdentity = z.infer<typeof sendAsIdentitySchema>;

export const folderSchema = z.object({
  accountId: z.string(),
  id: z.string(),
  name: z.string(),
  role: z
    .enum(["inbox", "sent", "drafts", "trash", "spam", "archive", "starred", "all"])
    .optional(),
  unreadCount: z.number().int().nonnegative().optional(),
});
export type FolderInfo = z.infer<typeof folderSchema>;

export const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentId: z.string().optional(),
  disposition: z.enum(["inline", "attachment"]).optional(),
});
export type AttachmentInfo = z.infer<typeof attachmentSchema>;

export const addressSchema = z.object({
  name: z.string().optional(),
  email: z.string().email(),
});
export type Address = z.infer<typeof addressSchema>;

// Received headers carry whatever the sender wrote, including addresses that are not valid email.
// Those messages still have to open, so inbound addresses are kept as-is and only outbound
// recipients (composeInputSchema, mailForwardInputSchema) are validated.
export const receivedAddressSchema = z.object({
  name: z.string().optional(),
  email: z.string(),
});
export type ReceivedAddress = z.infer<typeof receivedAddressSchema>;

export const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  accountId: z.string(),
  draftId: z.string().optional(),
  from: receivedAddressSchema.optional(),
  replyTo: z.array(receivedAddressSchema).optional(),
  to: z.array(receivedAddressSchema),
  cc: z.array(receivedAddressSchema).optional(),
  bcc: z.array(receivedAddressSchema).optional(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string().optional(),
  body: z.object({ text: z.string().optional(), html: z.string().optional() }).optional(),
  attachments: z.array(attachmentSchema).optional(),
  flags: z.object({
    read: z.boolean(),
    starred: z.boolean(),
    draft: z.boolean(),
  }),
  labels: z.array(z.string()).optional(),
  folderRole: z.string().optional(),
});
export type MailMessage = z.infer<typeof messageSchema>;

export const threadSummarySchema = z.object({
  id: z.string(),
  scheduleId: z.string().optional(),
  pendingSend: z.boolean().optional(),
  draftId: z.string().optional(),
  accountId: z.string(),
  accountEmail: z.string(),
  subject: z.string(),
  senderName: z.string(),
  senderEmail: z.string(),
  snippet: z.string(),
  date: z.string(),
  unread: z.boolean(),
  starred: z.boolean(),
  draft: z.boolean(),
  hasAttachments: z.boolean(),
  messageCount: z.number().int().positive(),
  labels: z.array(z.string()),
  folderRoles: z.array(z.string()),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountEmail: z.string(),
  subject: z.string(),
  messages: z.array(messageSchema),
});
export type MailThread = z.infer<typeof threadSchema>;

export const threadListInputSchema = z.object({
  view: mailboxViewSchema,
  accountIds: z.array(z.string()).optional(),
  label: z.string().optional(),
  query: z.string().max(500).optional(),
  refresh: z.boolean().optional(),
  backgroundRefresh: z.boolean().optional(),
  cursor: z.string().optional(),
  pageSize: z.number().int().min(1).max(200).default(100),
});
export type ThreadListInput = z.input<typeof threadListInputSchema>;

export const threadPageSchema = z.object({
  items: z.array(threadSummarySchema),
  nextCursor: z.string().optional(),
  totalCount: z.number().int().nonnegative(),
  syncing: z.boolean(),
});
export type ThreadPage = z.infer<typeof threadPageSchema>;

export const threadTargetSchema = z.object({
  accountId: z.string(),
  threadId: z.string(),
});
export const modifyActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum([
      "markRead",
      "markUnread",
      "star",
      "unstar",
      "archive",
      "trash",
      "untrash",
      "delete",
      "discardDraft",
    ]),
  }),
  z.object({ type: z.literal("move"), folder: z.string() }),
  z.object({
    type: z.literal("addLabels"),
    labels: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("removeLabels"),
    labels: z.array(z.string()).min(1),
  }),
]);
export type ModifyActionInput = z.infer<typeof modifyActionSchema>;

export const mailModifyInputSchema = z.object({
  targets: z.array(threadTargetSchema).min(1),
  action: modifyActionSchema,
  undoable: z.boolean().optional(),
});

export const mailModifyResultSchema = z.object({
  undoToken: z.string().optional(),
});
export type MailModifyResult = z.infer<typeof mailModifyResultSchema>;

export const mailUndoInputSchema = z.object({ token: z.string() });
export const mailUndoResultSchema = z.object({ undone: z.boolean() });
export type MailUndoResult = z.infer<typeof mailUndoResultSchema>;

export const composeAttachmentSchema = z.object({
  token: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentId: z.string().optional(),
  disposition: z.enum(["inline", "attachment"]).optional(),
});
export type ComposeAttachment = z.infer<typeof composeAttachmentSchema>;

export const draftRecipientFieldsSchema = z.object({
  to: z.string().max(10_000),
  cc: z.string().max(10_000),
  bcc: z.string().max(10_000),
});
export type DraftRecipientFields = z.infer<typeof draftRecipientFieldsSchema>;

export const composeInputSchema = z.object({
  accountId: z.string(),
  draftId: z.string().optional(),
  from: z.string().email().optional(),
  to: z.array(addressSchema),
  cc: z.array(addressSchema).optional(),
  bcc: z.array(addressSchema).optional(),
  subject: z.string().max(998),
  text: z.string().optional(),
  html: z.string().optional(),
  replyToMessageId: z.string().optional(),
  replyAll: z.boolean().optional(),
  attachments: z.array(composeAttachmentSchema).max(20).optional(),
  recipientFields: draftRecipientFieldsSchema.optional(),
});
export const sendInputSchema = composeInputSchema.refine((value) => Boolean(value.text?.trim()), {
  message: "Write a message before sending.",
});
export type ComposeInput = z.infer<typeof composeInputSchema>;
const scheduledSendDelaySecondsSchema = z.union([
  z.literal(5),
  z.literal(10),
  z.literal(20),
  z.literal(30),
]);

export const mailForwardInputSchema = z
  .object({
    target: threadTargetSchema,
    messageId: z.string(),
    from: z.string().email().optional(),
    to: z.array(addressSchema),
    cc: z.array(addressSchema).optional(),
    bcc: z.array(addressSchema).optional(),
    subject: z.string().max(998),
    comment: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    attachments: z.array(composeAttachmentSchema).max(20).optional(),
    includeAttachments: z.boolean().optional(),
    sendAt: z.string().datetime().optional(),
    delaySeconds: scheduledSendDelaySecondsSchema.optional(),
  })
  .refine((value) => Boolean(value.to.length || value.cc?.length || value.bcc?.length), {
    message: "Add at least one recipient before forwarding.",
    path: ["to"],
  })
  .refine((value) => !(value.sendAt && value.delaySeconds), {
    message: "Choose a send time or an undo delay.",
  });

export const draftResultSchema = z.object({
  draftId: z.string(),
  messageId: z.string(),
});
export const sendResultSchema = z.object({
  id: z.string(),
  threadId: z.string(),
});
export const scheduledSendResultSchema = z.object({
  scheduleId: z.string(),
  draftId: z.string(),
  sendAt: z.string().datetime(),
});
export type ScheduledSendResult = z.infer<typeof scheduledSendResultSchema>;
export const scheduledSendInputSchema = z.union([
  composeInputSchema.extend({
    sendAt: z.string().datetime(),
    delaySeconds: z.never().optional(),
  }),
  composeInputSchema.extend({
    sendAt: z.never().optional(),
    delaySeconds: scheduledSendDelaySecondsSchema,
  }),
]);
export type ScheduledSendInput = z.infer<typeof scheduledSendInputSchema>;
export const scheduledSendCancelInputSchema = z.object({ scheduleId: z.string() });
export const scheduledSendCancelResultSchema = z.object({
  draftId: z.string(),
});
export const draftDeleteInputSchema = z.object({
  accountId: z.string(),
  draftId: z.string(),
});
export const draftRecipientFieldsInputSchema = draftDeleteInputSchema;
export const attachmentSaveInputSchema = z.object({
  accountId: z.string(),
  messageId: z.string(),
  attachment: attachmentSchema,
});
export const attachmentInlineInputSchema = z.object({
  accountId: z.string(),
  messageId: z.string(),
  attachmentId: z.string(),
  mimeType: z.string(),
});
export const attachmentPrepareInputSchema = z.object({
  accountId: z.string(),
  messageId: z.string(),
  attachments: z.array(attachmentSchema).max(20),
});
export const attachmentReleaseInputSchema = z.array(z.string()).max(20);

export const syncStateSchema = z.object({
  status: z.enum(["idle", "syncing", "offline", "error"]),
  lastSyncedAt: z.string().optional(),
  error: z.string().optional(),
});
export type SyncState = z.infer<typeof syncStateSchema>;

export const telemetryStatusSchema = z.object({
  enabled: z.boolean(),
  lockedByEnvironment: z.boolean(),
});
export type TelemetryStatus = z.infer<typeof telemetryStatusSchema>;

export const appearancePreferenceSchema = z.enum(["system", "light", "dark"]);
export type AppearancePreference = z.infer<typeof appearancePreferenceSchema>;
export const undoSendDelaySecondsSchema = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(10),
  z.literal(20),
  z.literal(30),
]);
export type UndoSendDelaySeconds = z.infer<typeof undoSendDelaySecondsSchema>;
export function hasUndoSendDelay(
  delay: UndoSendDelaySeconds,
): delay is Exclude<UndoSendDelaySeconds, 0> {
  return delay !== 0;
}

export const licenseKeySchema = z.string().trim().min(1).max(200);

export const licenseStatusSchema = z.object({
  plan: z.string(),
  maxMembers: z.number().int().positive(),
  maxAccounts: z.number().int().positive(),
  canUsePrivateImageRelay: z.boolean(),
  warning: z.string().optional(),
});

export const licenseActivationResultSchema = z.object({
  outcome: z.enum(["activated", "saved_for_retry"]),
  license: licenseStatusSchema,
});
export type LicenseActivationResult = z.infer<typeof licenseActivationResultSchema>;

export const MAX_IMAGE_RELAY_URLS_PER_REQUEST = 200;
export const imageRelayInputSchema = z
  .array(
    z
      .string()
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      }),
  )
  .min(1)
  .max(MAX_IMAGE_RELAY_URLS_PER_REQUEST);
export const imageRelayResultSchema = z.record(z.string().url());

export const bootstrapSchema = z.object({
  desktopVersion: z.string(),
  engine: z.object({
    version: z.string(),
    storeFormat: z.number().int().nonnegative(),
    minimumSupportedFormat: z.number().int().nonnegative(),
    maximumSupportedFormat: z.number().int().nonnegative(),
  }),
  accounts: z.array(accountSchema),
  folders: z.array(folderSchema),
  unreadCount: z.number().int().nonnegative(),
  draftCount: z.number().int().nonnegative(),
  scheduledCount: z.number().int().nonnegative(),
  countsByAccount: z.record(
    z.object({
      unreadCount: z.number().int().nonnegative(),
      draftCount: z.number().int().nonnegative(),
      scheduledCount: z.number().int().nonnegative(),
    }),
  ),
  sync: syncStateSchema,
  telemetry: telemetryStatusSchema,
  preferences: z.object({
    appearance: appearancePreferenceSchema,
    dockBadge: z.boolean(),
    openNextAfterArchive: z.boolean(),
    blockRemoteImages: z.boolean(),
    imageRelay: z.boolean(),
    undoSendDelaySeconds: undoSendDelaySecondsSchema,
  }),
  license: licenseStatusSchema,
});
export type BootstrapState = z.infer<typeof bootstrapSchema>;

export const appErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type AppError = z.infer<typeof appErrorSchema>;

export const featureSchema = z.enum([
  "navigation",
  "search",
  "thread",
  "compose",
  "drafts",
  "attachments",
  "bulk_actions",
  "accounts",
  "notifications",
  "settings",
]);
export const featureActionSchema = z.enum([
  "viewed",
  "opened",
  "submitted",
  "completed",
  "failed",
  "created",
  "updated",
  "deleted",
  "enabled",
  "disabled",
  "loaded_more",
]);
export const featureSourceSchema = z.enum([
  "sidebar",
  "toolbar",
  "thread_list",
  "thread_detail",
  "compose",
  "onboarding",
  "settings",
  "shortcut",
]);
export const featureEventSchema = z.object({
  feature: featureSchema,
  action: featureActionSchema,
  source: featureSourceSchema,
});
export type FeatureEvent = z.infer<typeof featureEventSchema>;

export const appEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync-status"), state: syncStateSchema }),
  z.object({ type: z.literal("cache-changed") }),
  z.object({ type: z.literal("accounts-changed") }),
  z.object({ type: z.literal("license-changed") }),
  z.object({ type: z.literal("new-mail"), count: z.number().int().positive() }),
  z.object({ type: z.literal("window-close-requested") }),
  z.object({ type: z.literal("find-in-conversation-requested") }),
]);
export type AppEvent = z.infer<typeof appEventSchema>;

export interface FluxmailDesktopApi {
  bootstrap(): Promise<BootstrapState>;
  accounts: {
    list(): Promise<AccountInfo[]>;
    connectGmail(): Promise<AccountInfo>;
    reconnect(accountId: string): Promise<AccountInfo>;
    remove(accountId: string): Promise<void>;
    sendAs(accountId: string): Promise<SendAsIdentity[]>;
  };
  mail: {
    listThreads(input: ThreadListInput): Promise<ThreadPage>;
    search(input: ThreadListInput): Promise<ThreadPage>;
    getThread(target: z.infer<typeof threadTargetSchema>): Promise<MailThread>;
    modify(input: {
      targets: Array<z.infer<typeof threadTargetSchema>>;
      action: ModifyActionInput;
      undoable?: boolean;
    }): Promise<MailModifyResult>;
    undo(input: z.infer<typeof mailUndoInputSchema>): Promise<MailUndoResult>;
    forward(input: {
      target: z.infer<typeof threadTargetSchema>;
      messageId: string;
      from?: string;
      to: Address[];
      cc?: Address[];
      bcc?: Address[];
      subject: string;
      comment?: string;
      text?: string;
      html?: string;
      attachments?: ComposeAttachment[];
      includeAttachments?: boolean;
      sendAt?: string;
      delaySeconds?: Exclude<UndoSendDelaySeconds, 0>;
    }): Promise<ScheduledSendResult | undefined>;
  };
  drafts: {
    save(input: ComposeInput): Promise<{ draftId: string; messageId: string }>;
    delete(input: { accountId: string; draftId: string }): Promise<void>;
    send(input: ComposeInput): Promise<{ id: string; threadId: string }>;
    schedule(input: ScheduledSendInput): Promise<ScheduledSendResult>;
    cancelScheduled(input: { scheduleId: string }): Promise<{ draftId: string }>;
    recipientFields(input: {
      accountId: string;
      draftId: string;
    }): Promise<DraftRecipientFields | undefined>;
  };
  attachments: {
    pick(): Promise<ComposeAttachment[]>;
    prepare(input: z.infer<typeof attachmentPrepareInputSchema>): Promise<ComposeAttachment[]>;
    release(tokens: string[]): Promise<void>;
    save(input: {
      accountId: string;
      messageId: string;
      attachment: AttachmentInfo;
    }): Promise<boolean>;
    inlineData(input: {
      accountId: string;
      messageId: string;
      attachmentId: string;
      mimeType: string;
    }): Promise<string>;
  };
  sync: { refresh(input?: ThreadListInput): Promise<void> };
  telemetry: {
    getStatus(): Promise<TelemetryStatus>;
    setEnabled(enabled: boolean): Promise<TelemetryStatus>;
  };
  preferences: {
    setAppearance(appearance: AppearancePreference): Promise<AppearancePreference>;
    setDockBadge(enabled: boolean): Promise<boolean>;
    setOpenNextAfterArchive(enabled: boolean): Promise<boolean>;
    setBlockRemoteImages(enabled: boolean): Promise<boolean>;
    setImageRelay(enabled: boolean): Promise<boolean>;
    setUndoSendDelaySeconds(delay: UndoSendDelaySeconds): Promise<UndoSendDelaySeconds>;
  };
  images: {
    proxy(urls: z.infer<typeof imageRelayInputSchema>): Promise<Record<string, string>>;
  };
  license: {
    activate(key: string): Promise<LicenseActivationResult>;
  };
  analytics: { trackFeature(event: FeatureEvent): Promise<void> };
  system: {
    openExternal(url: string): Promise<void>;
    openLegalNotices(): Promise<void>;
    cancelWindowClose(): Promise<void>;
    confirmWindowClose(): Promise<void>;
    restart(): Promise<void>;
  };
  onEvent(callback: (event: AppEvent) => void): () => void;
}

export const IPC = {
  bootstrap: "fluxmail:bootstrap",
  accountsList: "fluxmail:accounts:list",
  accountsConnect: "fluxmail:accounts:connect",
  accountsReconnect: "fluxmail:accounts:reconnect",
  accountsRemove: "fluxmail:accounts:remove",
  accountsSendAs: "fluxmail:accounts:send-as",
  mailList: "fluxmail:mail:list",
  mailSearch: "fluxmail:mail:search",
  mailThread: "fluxmail:mail:thread",
  mailModify: "fluxmail:mail:modify",
  mailUndo: "fluxmail:mail:undo",
  mailForward: "fluxmail:mail:forward",
  draftSave: "fluxmail:draft:save",
  draftDelete: "fluxmail:draft:delete",
  draftSend: "fluxmail:draft:send",
  draftSchedule: "fluxmail:draft:schedule",
  draftCancelScheduled: "fluxmail:draft:cancel-scheduled",
  draftRecipientFields: "fluxmail:draft:recipient-fields",
  attachmentPick: "fluxmail:attachment:pick",
  attachmentPrepare: "fluxmail:attachment:prepare",
  attachmentRelease: "fluxmail:attachment:release",
  attachmentSave: "fluxmail:attachment:save",
  attachmentInline: "fluxmail:attachment:inline",
  syncRefresh: "fluxmail:sync:refresh",
  telemetryStatus: "fluxmail:telemetry:status",
  telemetrySet: "fluxmail:telemetry:set",
  preferencesAppearanceSet: "fluxmail:preferences:appearance:set",
  preferencesDockBadgeSet: "fluxmail:preferences:dock-badge:set",
  preferencesOpenNextAfterArchiveSet: "fluxmail:preferences:open-next-after-archive:set",
  preferencesBlockRemoteImagesSet: "fluxmail:preferences:block-remote-images:set",
  licenseActivate: "fluxmail:license:activate",
  preferencesImageRelaySet: "fluxmail:preferences:image-relay:set",
  preferencesUndoSendDelaySet: "fluxmail:preferences:undo-send-delay:set",
  imagesProxy: "fluxmail:images:proxy",
  analyticsFeature: "fluxmail:analytics:feature",
  systemOpenExternal: "fluxmail:system:open-external",
  systemOpenLegalNotices: "fluxmail:system:open-legal-notices",
  systemWindowCloseCancel: "fluxmail:system:window-close-cancel",
  systemWindowCloseConfirm: "fluxmail:system:window-close-confirm",
  systemRestart: "fluxmail:system:restart",
  event: "fluxmail:event",
} as const;
