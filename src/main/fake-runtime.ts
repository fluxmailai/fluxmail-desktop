import type { Message } from "@fluxmail/core";
import {
  CURRENT_STORE_FORMAT,
  LICENSE_KEY_PATTERN,
  MAX_SUPPORTED_STORE_FORMAT,
  MIN_SUPPORTED_STORE_FORMAT,
  VERSION,
} from "fluxmail";
import type {
  AccountInfo,
  BootstrapState,
  ComposeInput,
  DraftRecipientFields,
  LicenseActivationResult,
  MailModifyResult,
  MailThread,
  MailUndoResult,
  ModifyActionInput,
  ScheduledSendInput,
  SendAsIdentity,
  ThreadListInput,
  ThreadPage,
  ThreadSummary,
  UndoSendDelaySeconds,
} from "../shared/contracts";
import type { DesktopAnalytics } from "./analytics";
import { buildQuotedReplyBody } from "./quoted-reply";
import {
  buildDemoMessages,
  DEMO_ACCOUNT_EMAIL,
  DEMO_ACCOUNT_ID,
  DEMO_ACCOUNT_NAME,
} from "./demo-fixtures";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEMO_ALIAS_EMAIL = "hello@acme.example.com";

const account: AccountInfo = {
  id: DEMO_ACCOUNT_ID,
  email: DEMO_ACCOUNT_EMAIL,
  displayName: DEMO_ACCOUNT_NAME,
  provider: "gmail",
  status: "active",
  canPermanentlyDelete: false,
};

function todayAt(hour: number): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

const e2eMessages: Message[] = [
  {
    id: "welcome-message",
    threadId: "welcome-thread",
    accountId: account.id,
    folder: { id: "INBOX", name: "Inbox", role: "inbox" },
    from: { name: "Fluxmail Team", email: "team@fluxmail.test" },
    to: [{ email: account.email }],
    subject: "Welcome to Fluxmail",
    date: todayAt(23),
    snippet: "Your desktop inbox is ready.",
    body: {
      html: '<!doctype html><html><head><style>.newsletter-copy{font-size:22px;text-align:center}</style></head><body><p class="newsletter-copy">Your desktop inbox is ready.</p><script>window.evil = true</script><img src="https://tracker.invalid/pixel" width="1"><img src="https://t.yesware.com/tt/message-1"><img src = "https://images.invalid/welcome.png" width="320" height="180"></body></html>',
    },
    flags: { read: false, starred: false, draft: false },
  },
  {
    id: "receipt-message",
    threadId: "receipt-thread",
    accountId: account.id,
    folder: { id: "INBOX", name: "Inbox", role: "inbox" },
    labels: ["Receipts"],
    from: { name: "Corner Market", email: "receipts@market.test" },
    to: [{ email: account.email }],
    subject: "Receipt for Tuesday",
    date: todayAt(22),
    snippet: "Thanks for shopping with us.",
    body: {
      html: '<p>Thanks for shopping with us.</p><p><a href="mailto:help@market.test?subject=Receipt%20question">Contact us</a></p>',
    },
    flags: { read: true, starred: true, draft: false },
    attachments: [
      {
        id: "receipt-pdf",
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        sizeBytes: 128,
      },
    ],
  },
  {
    id: "draft-message",
    threadId: "draft-thread",
    accountId: account.id,
    draftId: "test-draft",
    folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
    from: { name: account.displayName, email: account.email },
    to: [{ name: "Sam", email: "sam@example.test" }],
    cc: [{ email: "editor@example.test" }],
    subject: "Launch notes",
    date: todayAt(21),
    snippet: "The first draft is ready.",
    body: {
      html: "<p>The first <strong>draft</strong> is ready.</p>",
      text: "The first draft is ready.",
    },
    attachments: [
      {
        id: "draft-attachment",
        filename: "launch-notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 128,
      },
    ],
    flags: { read: true, starred: false, draft: true },
  },
];

const seedMessages: Message[] = [
  ...(process.env.FLUXMAIL_DESKTOP_E2E_HEADLESS === "1" ? e2eMessages : []),
  ...buildDemoMessages(),
];

export class FakeFluxmailRuntime {
  async imageRelayLicenseLease(_forceRefresh = false): Promise<string> {
    return "fake-image-relay-license";
  }

  imageRelayAccessDenied(): void {
    if (!this.licenseValue.canUsePrivateImageRelay) return;
    this.licenseValue = { ...this.licenseValue, canUsePrivateImageRelay: false };
    this.options.onLicenseChanged();
  }

  private connected = true;
  private messages = structuredClone(seedMessages);
  private readonly draftRecipientValues = new Map<string, DraftRecipientFields>();
  private readonly scheduled = new Map<
    string,
    { draftId: string; sendAt: string; visible: boolean; timer: ReturnType<typeof setTimeout> }
  >();
  private latestUndo?: { token: string; threadIds: string[]; messages: Message[] };
  private mutationSequence = 0;
  private undoableMutationSequence = 0;
  private readonly threadMutationOwners = new Map<string, number>();
  private licenseValue: BootstrapState["license"] = {
    plan: "pro",
    maxMembers: 1,
    maxAccounts: 5,
    canUsePrivateImageRelay: true,
  };

  constructor(
    private readonly options: {
      analytics: DesktopAnalytics;
      onCacheChanged(): void;
      onLicenseChanged(): void;
    },
  ) {}

  async initialize(): Promise<void> {}
  license(): BootstrapState["license"] {
    return this.licenseValue;
  }
  async shutdown(): Promise<void> {
    for (const item of this.scheduled.values()) clearTimeout(item.timer);
    this.scheduled.clear();
  }

  accounts(): AccountInfo[] {
    return this.connected ? [account] : [];
  }

  maxAttachmentBytes(): number {
    return 25 * 1024 * 1024;
  }

  unreadCount(accountIds?: string[]): number {
    if (accountIds?.length && !accountIds.includes(account.id)) return 0;
    return this.inboxUnreadCount();
  }

  async bootstrap(
    sync: BootstrapState["sync"],
  ): Promise<Omit<BootstrapState, "desktopVersion" | "preferences">> {
    return {
      engine: {
        version: VERSION,
        storeFormat: CURRENT_STORE_FORMAT,
        minimumSupportedFormat: MIN_SUPPORTED_STORE_FORMAT,
        maximumSupportedFormat: MAX_SUPPORTED_STORE_FORMAT,
      },
      accounts: this.accounts(),
      folders: await this.folders(),
      unreadCount: this.inboxUnreadCount(),
      draftCount: this.draftCount(),
      scheduledCount: this.scheduledCount(),
      countsByAccount: this.connected
        ? {
            [account.id]: {
              unreadCount: this.inboxUnreadCount(),
              draftCount: this.draftCount(),
              scheduledCount: this.scheduledCount(),
            },
          }
        : {},
      sync,
      telemetry: this.options.analytics.status(),
      license: this.licenseValue,
    };
  }

  async activateLicense(rawKey: string): Promise<LicenseActivationResult> {
    if (!LICENSE_KEY_PATTERN.test(rawKey.trim())) {
      throw new Error("That license key does not look right. Check it and try again.");
    }
    this.licenseValue = {
      plan: "pro",
      maxMembers: 1,
      maxAccounts: 5,
      canUsePrivateImageRelay: true,
    };
    return { outcome: "activated", license: this.licenseValue };
  }

  async folders(_force = false): Promise<BootstrapState["folders"]> {
    if (!this.connected) return [];
    const customLabels = [...new Set(this.messages.flatMap((message) => message.labels ?? []))]
      .filter(
        (label) =>
          label !== "IMPORTANT" && !label.startsWith("CATEGORY_") && !label.startsWith("Fluxmail/"),
      )
      .sort((left, right) => left.localeCompare(right));
    return [
      {
        accountId: account.id,
        id: "INBOX",
        name: "Inbox",
        role: "inbox",
        unreadCount: this.inboxUnreadCount(),
      },
      { accountId: account.id, id: "SENT", name: "Sent", role: "sent" },
      { accountId: account.id, id: "DRAFT", name: "Drafts", role: "drafts" },
      ...customLabels.map((label) => ({ accountId: account.id, id: label, name: label })),
    ];
  }

  async connectGmail(_accountId?: string): Promise<AccountInfo> {
    this.connected = true;
    return account;
  }

  async sendAs(_accountId: string): Promise<SendAsIdentity[]> {
    return [
      { email: account.email, name: account.displayName, isPrimary: true },
      { email: DEMO_ALIAS_EMAIL, name: account.displayName, isPrimary: false },
    ];
  }

  removeAccount(_accountId: string): void {
    this.connected = false;
    this.options.onCacheChanged();
  }

  async listThreads(raw: ThreadListInput, _forceProviderSearch = false): Promise<ThreadPage> {
    const input = { pageSize: 100, ...raw };
    const offset = Number(input.cursor ?? 0);
    const scheduledDraftIds = new Set([...this.scheduled.values()].map((item) => item.draftId));
    const scheduledByDraft = new Map(
      [...this.scheduled.entries()]
        .filter(([, item]) => item.visible)
        .map(([scheduleId, item]) => [item.draftId, { scheduleId, sendAt: item.sendAt }]),
    );
    const activeScheduleByDraft = new Map(
      [...this.scheduled.entries()].map(([scheduleId, item]) => [
        item.draftId,
        { scheduleId, sendAt: item.sendAt, pendingSend: !item.visible },
      ]),
    );
    const summaries = this.summaries().map((thread) => {
      const scheduledDraft = [...this.messages]
        .reverse()
        .find(
          (message) =>
            message.threadId === thread.id &&
            message.draftId &&
            activeScheduleByDraft.has(message.draftId),
        );
      const schedule = scheduledDraft?.draftId
        ? activeScheduleByDraft.get(scheduledDraft.draftId)
        : undefined;
      return schedule && scheduledDraft?.draftId
        ? {
            ...thread,
            scheduleId: schedule.scheduleId,
            draftId: scheduledDraft.draftId,
            ...(schedule.pendingSend ? { pendingSend: true } : {}),
          }
        : thread;
    });
    const summariesByThread = new Map(summaries.map((thread) => [thread.id, thread]));
    const visibleThreads =
      input.view === "scheduled"
        ? [...scheduledByDraft.entries()].flatMap(([draftId, schedule]) => {
            const draft = this.messages.find((message) => message.draftId === draftId);
            const thread = draft ? summariesByThread.get(draft.threadId) : undefined;
            if (!draft || !thread) return [];

            const recipients = [...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])];
            return [
              {
                ...thread,
                scheduleId: schedule.scheduleId,
                draftId,
                subject: draft.subject,
                senderName:
                  recipients.map((recipient) => recipient.name || recipient.email).join(", ") ||
                  "No recipients",
                senderEmail: recipients[0]?.email ?? "",
                snippet: draft.snippet ?? "",
                date: schedule.sendAt,
                hasAttachments: Boolean(draft.attachments?.length),
              },
            ];
          })
        : summaries;
    const all = visibleThreads
      .filter((thread) => {
        if (input.accountIds?.length && !input.accountIds.includes(thread.accountId)) return false;
        if (input.view === "scheduled") return true;
        if (input.view === "starred" && !thread.starred) return false;
        if (input.view === "label" && input.label && !thread.labels.includes(input.label))
          return false;
        if (
          input.view === "search" &&
          thread.folderRoles.some((role) => role === "spam" || role === "trash")
        )
          return false;
        if (
          !["all", "starred", "label", "search"].includes(input.view) &&
          !(input.view === "sent" && thread.pendingSend) &&
          !thread.folderRoles.includes(input.view)
        )
          return false;
        if (
          input.view === "drafts" &&
          !this.messages.some(
            (message) =>
              message.threadId === thread.id &&
              message.flags.draft &&
              !scheduledDraftIds.has(message.draftId ?? ""),
          )
        )
          return false;
        const query = input.query?.trim().toLowerCase();
        return (
          !query ||
          `${thread.senderName} ${thread.subject} ${thread.snippet}`.toLowerCase().includes(query)
        );
      })
      .sort((left, right) =>
        input.view === "scheduled"
          ? Date.parse(left.date) - Date.parse(right.date)
          : Date.parse(right.date) - Date.parse(left.date),
      );
    const items = all.slice(offset, offset + input.pageSize);
    return {
      items,
      totalCount: all.length,
      ...(offset + items.length < all.length ? { nextCursor: String(offset + items.length) } : {}),
      syncing: false,
    };
  }

  async getThread(_accountId: string, threadId: string): Promise<MailThread> {
    const messages = this.messages.filter((message) => message.threadId === threadId);
    if (!messages.length) throw new Error("This test conversation no longer exists.");
    return {
      id: threadId,
      accountId: account.id,
      accountEmail: account.email,
      subject: messages[0]!.subject,
      messages,
    };
  }

  async modify(
    targets: Array<{ threadId: string }>,
    action: ModifyActionInput,
    undoable = true,
  ): Promise<MailModifyResult> {
    const ids = new Set(targets.map((target) => target.threadId));
    const mutation = ++this.mutationSequence;
    for (const id of ids) this.threadMutationOwners.set(id, mutation);
    const canUndo = undoable && action.type !== "delete" && action.type !== "discardDraft";
    const undoableMutation = canUndo ? ++this.undoableMutationSequence : undefined;
    const supersedesCurrentUndo = this.latestUndo?.threadIds.some((threadId) => ids.has(threadId));
    if (canUndo || supersedesCurrentUndo) this.latestUndo = undefined;
    const previousMessages = canUndo
      ? structuredClone(this.messages.filter((message) => ids.has(message.threadId)))
      : undefined;
    try {
      if (action.type === "archive") {
        const delay = Number(process.env.FLUXMAIL_DESKTOP_FAKE_ARCHIVE_DELAY_MS ?? 0);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (action.type === "discardDraft")
        for (const [scheduleId, item] of this.scheduled)
          if (
            this.messages.some(
              (message) =>
                ids.has(message.threadId) &&
                message.flags.draft &&
                message.draftId === item.draftId,
            )
          ) {
            clearTimeout(item.timer);
            this.scheduled.delete(scheduleId);
          }
      if (action.type === "discardDraft")
        this.messages = this.messages.filter(
          (message) => !ids.has(message.threadId) || !message.flags.draft,
        );
      else if (action.type === "delete")
        this.messages = this.messages.filter((message) => !ids.has(message.threadId));
      else {
        for (const message of this.messages.filter((item) => ids.has(item.threadId))) {
          if (action.type === "markRead") message.flags.read = true;
          if (action.type === "markUnread") message.flags.read = false;
          if (action.type === "star") message.flags.starred = true;
          if (action.type === "unstar") message.flags.starred = false;
          if (action.type === "archive" && message.folder?.role === "inbox")
            message.folder = { id: "ALL", name: "All mail", role: "all" };
          if (action.type === "trash")
            message.folder = { id: "TRASH", name: "Trash", role: "trash" };
          if (action.type === "untrash")
            message.folder = { id: "INBOX", name: "Inbox", role: "inbox" };
          if (action.type === "move")
            message.folder =
              action.folder === "spam"
                ? { id: "SPAM", name: "Spam", role: "spam" }
                : { id: action.folder, name: action.folder };
          if (action.type === "addLabels")
            message.labels = [...new Set([...(message.labels ?? []), ...action.labels])];
          if (action.type === "removeLabels")
            message.labels = (message.labels ?? []).filter(
              (label) => !action.labels.includes(label),
            );
        }
      }
      this.options.onCacheChanged();
      if (
        !previousMessages ||
        undoableMutation !== this.undoableMutationSequence ||
        [...ids].some((id) => this.threadMutationOwners.get(id) !== mutation)
      )
        return {};
      const token = `fake-undo-${mutation}`;
      this.latestUndo = { token, threadIds: [...ids], messages: previousMessages };
      return { undoToken: token };
    } finally {
      for (const id of ids)
        if (this.threadMutationOwners.get(id) === mutation) this.threadMutationOwners.delete(id);
    }
  }

  async undo(token: string): Promise<MailUndoResult> {
    if (!this.latestUndo || this.latestUndo.token !== token) return { undone: false };
    const entry = this.latestUndo;
    this.latestUndo = undefined;
    const threadIds = new Set(entry.threadIds);
    this.messages = [
      ...this.messages.filter((message) => !threadIds.has(message.threadId)),
      ...entry.messages,
    ];
    this.options.onCacheChanged();
    return { undone: true };
  }

  async saveDraft(input: ComposeInput): Promise<{ draftId: string; messageId: string }> {
    const existing = input.draftId
      ? this.messages.find((message) => message.draftId === input.draftId)
      : undefined;
    const draftId = input.draftId ?? `test-draft-${this.messages.length + 1}`;
    const messageId = existing?.id ?? `test-draft-message-${this.messages.length + 1}`;
    // Providers file a reply draft in the thread it answers.
    const replyTarget = input.replyToMessageId
      ? this.messages.find((message) => message.id === input.replyToMessageId)
      : undefined;
    const draft: Message = {
      id: messageId,
      threadId: existing?.threadId ?? replyTarget?.threadId ?? messageId,
      accountId: account.id,
      draftId,
      folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
      from: {
        name: account.displayName,
        email: input.from ?? existing?.from?.email ?? account.email,
      },
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.bcc?.length ? { bcc: input.bcc } : {}),
      subject: input.subject,
      date: new Date().toISOString(),
      snippet: input.text,
      body: { text: input.text, html: input.html },
      attachments: (input.attachments ?? []).map(({ token, ...attachment }) => ({
        id: token,
        ...attachment,
      })),
      flags: { read: true, starred: false, draft: true },
    };
    if (existing) this.messages[this.messages.indexOf(existing)] = draft;
    else this.messages.push(draft);
    if (input.recipientFields) this.draftRecipientValues.set(draftId, input.recipientFields);
    this.options.onCacheChanged();
    return { draftId, messageId };
  }

  async deleteDraft(_accountId: string, draftId: string): Promise<void> {
    this.cancelFakeSchedulesForDraft(draftId);
    this.messages = this.messages.filter((message) => message.draftId !== draftId);
    this.draftRecipientValues.delete(draftId);
    this.options.onCacheChanged();
  }

  draftRecipientFields(_accountId: string, draftId: string): DraftRecipientFields | undefined {
    return this.draftRecipientValues.get(draftId);
  }

  /** Mirrors the real runtime, which appends the quoted original when a reply leaves the composer. */
  private withQuotedReply<T extends ComposeInput>(input: T): T {
    const original = input.replyToMessageId
      ? this.messages.find((message) => message.id === input.replyToMessageId)
      : undefined;
    if (!original) return input;
    const body = buildQuotedReplyBody(
      {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.html === undefined ? {} : { html: input.html }),
      },
      original,
    );
    return {
      ...input,
      ...(body.text === undefined ? {} : { text: body.text }),
      ...(body.html === undefined ? {} : { html: body.html }),
    };
  }

  async send(rawInput: ComposeInput): Promise<{ id: string; threadId: string }> {
    const input = this.withQuotedReply(rawInput);
    if (input.draftId) {
      this.cancelFakeSchedulesForDraft(input.draftId);
      this.messages = this.messages.filter((message) => message.draftId !== input.draftId);
      this.draftRecipientValues.delete(input.draftId);
    }
    const id = `sent-${this.messages.length + 1}`;
    this.messages.push({
      id,
      threadId: id,
      accountId: account.id,
      folder: { id: "SENT", name: "Sent", role: "sent" },
      from: { email: input.from ?? account.email },
      to: input.to,
      subject: input.subject,
      date: new Date().toISOString(),
      snippet: input.text,
      body: { text: input.text, html: input.html },
      flags: { read: true, starred: false, draft: false },
    });
    this.options.onCacheChanged();
    return { id, threadId: id };
  }

  async schedule(
    rawInput: ScheduledSendInput,
  ): Promise<{ scheduleId: string; draftId: string; sendAt: string }> {
    const input = this.withQuotedReply(rawInput);
    const draft = await this.saveDraft(input);
    this.cancelFakeSchedulesForDraft(draft.draftId);
    const sendAt = fakeScheduledSendAt(input);
    const scheduleId = `test-schedule-${draft.draftId}`;
    this.scheduleFakeDraft(scheduleId, draft.draftId, sendAt, !input.delaySeconds, () => {
      this.messages = this.messages.filter((message) => message.draftId !== draft.draftId);
      void this.send({ ...input, draftId: undefined });
    });
    return {
      scheduleId,
      draftId: draft.draftId,
      sendAt,
    };
  }

  async cancelScheduled(scheduleId: string): Promise<{ draftId: string }> {
    const item = this.scheduled.get(scheduleId);
    if (!item) throw new Error("This message has already been sent or canceled.");
    clearTimeout(item.timer);
    this.scheduled.delete(scheduleId);
    this.options.onCacheChanged();
    return { draftId: item.draftId };
  }

  async forward(input: {
    accountId: string;
    messageId: string;
    from?: string;
    to: Array<{ name?: string; email: string }>;
    cc?: Array<{ name?: string; email: string }>;
    bcc?: Array<{ name?: string; email: string }>;
    subject: string;
    comment?: string;
    text?: string;
    html?: string;
    attachments?: ComposeInput["attachments"];
    includeAttachments?: boolean;
    sendAt?: string;
    delaySeconds?: Exclude<UndoSendDelaySeconds, 0>;
  }): Promise<{ scheduleId: string; draftId: string; sendAt: string } | undefined> {
    const original = this.messages.find((message) => message.id === input.messageId);
    const id = `forwarded-${this.messages.length + 1}`;
    const subject = input.subject || original?.subject || "";
    const scheduled = Boolean(input.sendAt || input.delaySeconds);
    const draftId = scheduled ? `test-draft-${id}` : undefined;
    this.messages.push({
      id,
      threadId: id,
      accountId: account.id,
      ...(draftId ? { draftId } : {}),
      folder: draftId
        ? { id: "DRAFT", name: "Drafts", role: "drafts" }
        : { id: "SENT", name: "Sent", role: "sent" },
      from: { email: input.from ?? account.email },
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.bcc?.length ? { bcc: input.bcc } : {}),
      subject,
      date: new Date().toISOString(),
      snippet: input.text ?? input.comment ?? "",
      body: { text: input.text ?? input.comment ?? "", html: input.html },
      attachments: [
        ...(input.includeAttachments ? (original?.attachments ?? []) : []),
        ...(input.attachments ?? []).map(({ token, ...attachment }) => ({
          id: token,
          ...attachment,
        })),
      ],
      flags: { read: true, starred: false, draft: Boolean(draftId) },
    });
    this.options.onCacheChanged();
    if (!scheduled || !draftId) return undefined;
    const sendAt = fakeScheduledSendAt(
      input.delaySeconds ? { delaySeconds: input.delaySeconds } : { sendAt: input.sendAt! },
    );
    const scheduleId = `test-schedule-${id}`;
    this.scheduleFakeDraft(scheduleId, draftId, sendAt, !input.delaySeconds, () => {
      const draft = this.messages.find((message) => message.draftId === draftId);
      if (!draft) return;
      delete draft.draftId;
      draft.folder = { id: "SENT", name: "Sent", role: "sent" };
      draft.flags.draft = false;
      this.options.onCacheChanged();
    });
    return { scheduleId, draftId, sendAt };
  }

  private scheduleFakeDraft(
    scheduleId: string,
    draftId: string,
    sendAt: string,
    visible: boolean,
    send: () => void,
  ): void {
    const armTimer = (): ReturnType<typeof setTimeout> => {
      const remainingMs = Math.max(0, Date.parse(sendAt) - Date.now());
      return setTimeout(
        () => {
          if (remainingMs > MAX_TIMER_DELAY_MS) {
            const current = this.scheduled.get(scheduleId);
            if (current) current.timer = armTimer();
            return;
          }
          this.scheduled.delete(scheduleId);
          send();
        },
        Math.min(remainingMs, MAX_TIMER_DELAY_MS),
      );
    };
    this.scheduled.set(scheduleId, { draftId, sendAt, visible, timer: armTimer() });
    this.options.onCacheChanged();
  }

  private cancelFakeSchedulesForDraft(draftId: string): void {
    for (const [scheduleId, item] of this.scheduled) {
      if (item.draftId !== draftId) continue;
      clearTimeout(item.timer);
      this.scheduled.delete(scheduleId);
    }
  }

  async attachment(
    _accountId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{
    meta: { filename: string; mimeType: string };
    content: Buffer;
  }> {
    const attachment = this.messages
      .find((message) => message.id === messageId)
      ?.attachments?.find((candidate) => candidate.id === attachmentId);
    return {
      meta: {
        filename: attachment?.filename ?? "attachment.bin",
        mimeType: attachment?.mimeType ?? "application/octet-stream",
      },
      content: Buffer.from("test"),
    };
  }

  async refresh(
    _trigger: "startup" | "poll" | "manual" | "resume" | "mutation" = "manual",
    _activeInput: ThreadListInput = { view: "inbox" },
  ): Promise<number> {
    this.options.onCacheChanged();
    return this.messages.length;
  }

  private summaries(): ThreadSummary[] {
    const messagesByThread = new Map<string, Message[]>();
    for (const message of this.messages) {
      const messages = messagesByThread.get(message.threadId) ?? [];
      messages.push(message);
      messagesByThread.set(message.threadId, messages);
    }

    return [...messagesByThread.entries()]
      .map(([threadId, threadMessages]): ThreadSummary => {
        const sortedMessages = [...threadMessages].sort(
          (left, right) => Date.parse(left.date) - Date.parse(right.date),
        );
        const latest = sortedMessages.at(-1)!;
        return {
          id: threadId,
          accountId: account.id,
          accountEmail: account.email,
          subject: latest.subject,
          senderName: latest.from?.name || latest.from?.email || "Unknown sender",
          senderEmail: latest.from?.email || "",
          snippet: latest.snippet || "",
          date: latest.date,
          unread: sortedMessages.some((message) => !message.flags.read),
          starred: sortedMessages.some((message) => message.flags.starred),
          draft: sortedMessages.some((message) => message.flags.draft),
          hasAttachments: sortedMessages.some((message) => Boolean(message.attachments?.length)),
          messageCount: sortedMessages.length,
          labels: [...new Set<string>(sortedMessages.flatMap((message) => message.labels ?? []))],
          folderRoles: [
            ...new Set<string>(
              sortedMessages.flatMap((message) =>
                message.folder?.role ? [message.folder.role] : [],
              ),
            ),
          ],
        };
      })
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
  }

  private inboxUnreadCount(): number {
    return this.summaries().filter(
      (thread) => thread.folderRoles.includes("inbox") && thread.unread,
    ).length;
  }

  private scheduledCount(): number {
    return [...this.scheduled.values()].filter((item) => item.visible).length;
  }

  private draftCount(): number {
    const scheduledDraftIds = new Set([...this.scheduled.values()].map((item) => item.draftId));
    return new Set(
      this.messages.flatMap((message) =>
        message.flags.draft && message.draftId && !scheduledDraftIds.has(message.draftId)
          ? [message.threadId]
          : [],
      ),
    ).size;
  }
}

function fakeScheduledSendAt(
  timing: { sendAt: string } | { delaySeconds: Exclude<UndoSendDelaySeconds, 0> },
): string {
  return "delaySeconds" in timing
    ? new Date(Date.now() + timing.delaySeconds * 1_000).toISOString()
    : timing.sendAt;
}
