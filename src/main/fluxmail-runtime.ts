import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { AttachmentInput, Message, ModifyAction, Thread } from "@fluxmail/core";
import { isEmailError } from "@fluxmail/core";
import {
  buildForwardBody,
  decryptString,
  type AppContext,
  type SendInput,
  type StoreCompatibility,
} from "fluxmail";
import type {
  AccountInfo,
  Address,
  BootstrapState,
  ComposeAttachment,
  ComposeInput,
  DraftRecipientFields,
  FolderInfo,
  LicenseActivationResult,
  MailModifyResult,
  MailThread,
  MailUndoResult,
  MailboxView,
  ModifyActionInput,
  ScheduledSendInput,
  ScheduledSendResult,
  SendAsIdentity,
  ThreadListInput,
  ThreadPage,
  UndoSendDelaySeconds,
} from "../shared/contracts";
import { MailCache, type ScheduledDraftRef } from "./cache";
import { DesktopAnalytics, type MailOperation, type SyncTrigger } from "./analytics";
import { toEmailQuery } from "./mail-mapping";
import {
  buildQuotedReplyBody,
  normalizeContentId,
  referencedInlineContentIds,
} from "./quoted-reply";
import {
  googleCredentialsAllowPermanentDelete,
  googleOAuthSourceAllowsPermanentDelete,
  runGoogleOAuth,
} from "./oauth";

interface RuntimeOptions {
  cache: MailCache;
  analytics: DesktopAnalytics;
  openExternal(url: string): Promise<void>;
  resolveAttachment(attachment: ComposeAttachment): Promise<AttachmentInput>;
  onNewMessages(messages: Message[], account: AccountInfo): void;
  onCacheChanged(): void;
  onLicenseChanged(): void;
}

const PRIVATE_IMAGE_RELAY_PLANS = new Set(["pro", "team", "enterprise"]);

interface ScheduledCacheTarget {
  scheduleId: string;
  accountId: string;
  draftId: string;
  sendAt: string;
}

interface ScheduledCacheTimer {
  timer: NodeJS.Timeout;
  target: ScheduledCacheTarget;
}

interface CanceledSchedule extends ScheduledCacheTarget {
  undo: boolean;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_THREAD_PREFETCH = 10;
const THREAD_PREFETCH_CONCURRENCY = 2;
const MAX_THREAD_LOAD_ATTEMPTS = 3;
const SEND_AS_CACHE_MS = 10 * 60_000;

export class FluxmailRuntime {
  private context!: AppContext;
  private fluxmail!: typeof import("fluxmail");
  private initialized = false;
  private readonly sendAsCache = new Map<
    string,
    { expiresAt: number; identities: Promise<SendAsIdentity[]> }
  >();
  private cacheGeneration = 0;
  private viewRefreshGeneration = 0;
  private googleOAuthAttempt?: Promise<Awaited<ReturnType<typeof runGoogleOAuth>>>;
  private imageRelayLicenseRefresh?: Promise<void>;
  private imageRelayAccessDeniedByServer = false;
  private readonly backgroundViewRefreshes = new Map<string, Promise<void>>();
  private readonly committedViewRefreshes = new Map<string, number>();
  private readonly scheduledCacheTimers = new Map<string, ScheduledCacheTimer>();
  private readonly undoScheduleIds = new Set<string>();
  private readonly providerMutationQueues = new Map<string, Promise<void>>();
  private readonly threadFetches = new Map<
    string,
    { version: string; request: Promise<MailThread | undefined> }
  >();
  private latestUndo?: {
    token: string;
    action: ModifyActionInput;
    snapshots: Array<{ accountId: string; thread: Thread }>;
  };
  private undoableMutationSequence = 0;

  constructor(private readonly options: RuntimeOptions) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    process.env.FLUXMAIL_DATA_DIR ??= path.join(homedir(), ".fluxmail");
    this.fluxmail = await import("fluxmail");
    const shouldStoreBundledGoogleConfig = prepareFluxmailConfiguration(
      this.fluxmail,
      __FLUXMAIL_GOOGLE_CLIENT_ID__,
      __FLUXMAIL_GOOGLE_CLIENT_SECRET__,
    );
    this.context = this.fluxmail.createContext();
    if (
      shouldStoreBundledGoogleConfig &&
      this.context.configuration.oauthStatus().google.source === "built-in"
    ) {
      this.context.configuration.setGoogle({
        clientId: __FLUXMAIL_GOOGLE_CLIENT_ID__,
        clientSecret: __FLUXMAIL_GOOGLE_CLIENT_SECRET__,
      });
    }
    this.context.scheduler.start();
    this.restoreScheduledCacheTracking();
    this.context.licenseController.start();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    for (const tracking of this.scheduledCacheTimers.values()) clearTimeout(tracking.timer);
    this.scheduledCacheTimers.clear();
    this.undoScheduleIds.clear();
    this.context.scheduler.stop();
    this.context.licenseController.stop();
    await this.context.telemetry.shutdown();
  }

  accounts(): AccountInfo[] {
    return this.context.registry
      .listAccounts()
      .map((account) =>
        toAccountInfo(account, this.accountCanPermanentlyDelete(account.id, account.provider)),
      );
  }

  async imageRelayLicenseLease(forceRefresh = false): Promise<string> {
    let lease = this.fluxmail.readLeaseRow(this.context.db);
    let entitlements = this.fluxmail.getEntitlements(this.context.db);
    if (forceRefresh || !lease || entitlements.inGrace) {
      await this.context.licenseController.refreshNow();
      lease = this.fluxmail.readLeaseRow(this.context.db);
      entitlements = this.fluxmail.getEntitlements(this.context.db);
    }
    if (
      !lease ||
      !entitlements.licensed ||
      entitlements.inGrace ||
      !PRIVATE_IMAGE_RELAY_PLANS.has(entitlements.plan)
    ) {
      this.options.onLicenseChanged();
      throw new Error("Private image relay is available on Pro, Team, and Enterprise.");
    }
    this.fluxmail.verifyLease(lease.token, this.fluxmail.licensePublicKeys());
    return lease.token;
  }

  imageRelayAccessDenied(): void {
    if (this.imageRelayAccessDeniedByServer) return;
    this.imageRelayAccessDeniedByServer = true;
    this.options.onLicenseChanged();
  }

  private accountCanPermanentlyDelete(
    accountId: string,
    provider: AccountInfo["provider"],
  ): boolean {
    if (provider !== "gmail") return true;
    try {
      // CLI and MCP reconnections update this shared credential row, so the
      // desktop capability must be derived here instead of kept in its mail cache.
      const sqlite = (
        this.context.db as unknown as {
          $client: {
            prepare(source: string): {
              get(accountId: string): { encrypted_credentials: string } | undefined;
            };
          };
        }
      ).$client;
      const row = sqlite
        .prepare("SELECT encrypted_credentials FROM account_credentials WHERE account_id = ?")
        .get(accountId);
      if (!row) return false;
      const credentials = JSON.parse(
        decryptString(this.context.config.encryptionKey, row.encrypted_credentials),
      ) as {
        scope?: string;
      };
      return googleCredentialsAllowPermanentDelete(credentials, []);
    } catch {
      return false;
    }
  }

  maxAttachmentBytes(): number {
    return this.context.config.maxAttachmentBytes;
  }

  unreadCount(accountIds?: string[]): number {
    const folders = this.options.cache.listFolders();
    return this.accounts()
      .filter((account) => !accountIds?.length || accountIds.includes(account.id))
      .reduce((total, account) => {
        const inbox = folders.find(
          (folder) => folder.accountId === account.id && folder.role === "inbox",
        );
        return total + (inbox?.unreadCount ?? this.options.cache.unreadCount([account.id]));
      }, 0);
  }

  async bootstrap(
    sync: BootstrapState["sync"],
  ): Promise<Omit<BootstrapState, "desktopVersion" | "preferences">> {
    const store = this.assertStoreCompatible();
    const accounts = this.accounts();
    this.reconcileCachedAccounts(accounts);
    const [folders, license] = await Promise.all([
      this.folders().catch(() => this.options.cache.listFolders()),
      Promise.resolve(this.license()),
    ]);
    const accountIds = accounts.map((account) => account.id);
    const scheduled = this.activeScheduled(accountIds);
    const allScheduled = this.activeScheduled(accountIds, true);
    return {
      engine: {
        version: this.fluxmail.VERSION,
        storeFormat: store.storeFormat,
        minimumSupportedFormat: store.minimumSupportedFormat,
        maximumSupportedFormat: store.maximumSupportedFormat,
      },
      accounts,
      folders,
      unreadCount: this.unreadCount(),
      draftCount: this.options.cache.draftCount(undefined, allScheduled),
      scheduledCount: scheduled.length,
      countsByAccount: Object.fromEntries(
        accounts.map((account) => [
          account.id,
          {
            unreadCount: this.unreadCount([account.id]),
            draftCount: this.options.cache.draftCount([account.id], allScheduled),
            scheduledCount: scheduled.filter((item) => item.accountId === account.id).length,
          },
        ]),
      ),
      sync,
      telemetry: this.options.analytics.status(),
      license,
    };
  }

  async folders(force = false): Promise<FolderInfo[]> {
    const cached = this.options.cache.listFolders();
    if (cached.length && !force) return cached;
    this.assertStoreCompatible();
    const accounts = this.accounts();
    const cacheGeneration = this.cacheGeneration;
    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        const folders = await this.context.service.listFolders(account.id);
        if (cacheGeneration !== this.cacheGeneration) return [];
        this.options.cache.putFolders(account.id, folders);
        return folders.map((folder) => ({ ...folder, accountId: account.id }));
      }),
    );
    const fresh = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const freshAccountIds = new Set(fresh.map((folder) => folder.accountId));
    const fallback = cached.filter((folder) => !freshAccountIds.has(folder.accountId));
    if (fresh.length || fallback.length || !accounts.length) return [...fresh, ...fallback];
    const failure = results.find((result) => result.status === "rejected");
    throw failure?.reason ?? new Error("Fluxmail could not load folders.");
  }

  license(): BootstrapState["license"] {
    this.refreshImageRelayLicenseInBackground();
    const entitlements = this.fluxmail.getEntitlements(this.context.db);
    const state = this.fluxmail.checkLicenseState(this.context.db);
    return {
      plan: entitlements.plan,
      maxMembers: entitlements.maxMembers,
      maxAccounts: entitlements.maxAccounts,
      canUsePrivateImageRelay:
        !this.imageRelayAccessDeniedByServer &&
        entitlements.licensed &&
        !entitlements.inGrace &&
        PRIVATE_IMAGE_RELAY_PLANS.has(entitlements.plan),
      ...(state.warning ? { warning: state.warning } : {}),
    };
  }

  async activateLicense(rawKey: string): Promise<LicenseActivationResult> {
    this.assertStoreCompatible();
    const licenseKey = rawKey.trim();
    if (!this.fluxmail.LICENSE_KEY_PATTERN.test(licenseKey)) {
      throw new Error("That license key does not look right. Check it and try again.");
    }
    if (this.context.config.licenseKeyFromEnvironment) {
      throw new Error(
        "This license is managed by FLUXMAIL_LICENSE_KEY. Remove that setting before activating a different key.",
      );
    }

    const result = await this.fluxmail.refreshLicense(this.context.db, {
      licenseKey,
      serverUrl: this.context.config.licenseServerUrl,
      dataDir: this.context.config.dataDir,
    });
    if (result.outcome !== "refreshed" && result.outcome !== "outage") {
      throw new Error(licenseActivationError(result.outcome));
    }
    if (result.outcome === "refreshed") this.imageRelayAccessDeniedByServer = false;

    this.context.configuration.setLicenseKey(licenseKey);
    this.context.licenseController.wake();
    return {
      outcome: result.outcome === "refreshed" ? "activated" : "saved_for_retry",
      license: this.license(),
    };
  }

  private refreshImageRelayLicenseInBackground(): void {
    if (this.imageRelayLicenseRefresh) return;
    const entitlements = this.fluxmail.getEntitlements(this.context.db);
    if (entitlements.licensed && !entitlements.inGrace && !this.imageRelayAccessDeniedByServer)
      return;
    if (!this.context.licenseController.configuredKey()) return;

    this.imageRelayLicenseRefresh = this.context.licenseController
      .refreshNow()
      .then((result) => {
        if (result?.outcome === "refreshed") {
          this.imageRelayAccessDeniedByServer = false;
          this.options.onLicenseChanged();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.imageRelayLicenseRefresh = undefined;
      });
  }

  async connectGmail(accountId?: string): Promise<AccountInfo> {
    this.assertStoreCompatible();
    const config = this.context.config.google;
    if (!config) {
      throw new Error(
        "This build is missing Google OAuth settings. Set up the desktop OAuth client and rebuild Fluxmail.",
      );
    }
    if (this.googleOAuthAttempt) throw new Error("Google sign-in is already open in your browser.");
    this.googleOAuthAttempt = runGoogleOAuth({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      port: this.context.config.oauthPort,
      allowPermanentDelete: googleOAuthSourceAllowsPermanentDelete(
        this.context.configuration.oauthStatus().google.source,
      ),
      openExternal: this.options.openExternal,
    });
    let identity: Awaited<ReturnType<typeof runGoogleOAuth>>;
    try {
      identity = await this.googleOAuthAttempt;
    } finally {
      this.googleOAuthAttempt = undefined;
    }
    const existing = accountId ? this.context.registry.getAccount(accountId) : undefined;
    if (existing && existing.email.toLowerCase() !== identity.email.toLowerCase()) {
      throw new Error(`Choose ${existing.email} in Google to reconnect this account.`);
    }
    this.assertStoreCompatible();
    const members = this.fluxmail.listMembers(this.context.db);
    const owner =
      members[0] ??
      this.fluxmail.addMember(this.context.db, {
        name: identity.displayName || identity.email.split("@")[0] || "Fluxmail user",
        email: identity.email,
      });
    const account = this.context.registry.addGmailAccount(
      identity.email,
      identity.tokens,
      identity.displayName,
      owner.id,
      { sharedWithAll: false },
    );
    this.sendAsCache.delete(account.id);
    return toAccountInfo(account, identity.canPermanentlyDelete);
  }

  removeAccount(accountId: string): void {
    this.assertStoreCompatible();
    this.sendAsCache.delete(accountId);
    if (this.latestUndo?.snapshots.some((snapshot) => snapshot.accountId === accountId))
      this.latestUndo = undefined;
    for (const [scheduleId, tracking] of this.scheduledCacheTimers)
      if (tracking.target.accountId === accountId) this.clearScheduledCacheTracking(scheduleId);
    this.context.registry.removeAccount(accountId);
    this.options.cache.deleteAccount(accountId);
    this.options.onCacheChanged();
  }

  /** Addresses the account can send as, primary first. Gmail aliases come from the provider. */
  async sendAs(accountId: string): Promise<SendAsIdentity[]> {
    this.requireAccount(accountId);
    const cached = this.sendAsCache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) return cached.identities;
    const identities = this.context.service
      .listSendAs(accountId)
      .then((list) =>
        list
          .map(({ email, name, isPrimary }) => ({ email, ...(name ? { name } : {}), isPrimary }))
          .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
      );
    const entry = { expiresAt: Date.now() + SEND_AS_CACHE_MS, identities };
    this.sendAsCache.set(accountId, entry);
    identities.catch(() => {
      if (this.sendAsCache.get(accountId) === entry) this.sendAsCache.delete(accountId);
    });
    return identities;
  }

  async listThreads(rawInput: ThreadListInput, forceProviderSearch = false): Promise<ThreadPage> {
    const input = { pageSize: 100, ...rawInput };
    this.reconcileCachedAccounts(this.accounts());
    const currentViewKey = viewKey(input);
    return this.measure(forceProviderSearch ? "search" : "list_threads", async () => {
      if (input.view === "scheduled") {
        const offset = parseCursor(input.cursor);
        const schedules = this.activeScheduled();
        let all = this.options.cache.listScheduledThreads(schedules, input.accountIds);
        const draftInput: ThreadListInput = {
          view: "drafts",
          accountIds: input.accountIds,
          pageSize: input.pageSize,
        };
        const accounts = this.accountsFor(draftInput);
        const draftViewKey = viewKey(draftInput);
        const needsInitialPage = accounts.some(
          (account) => !this.options.cache.getPageState(account.id, draftViewKey).initialized,
        );
        const includedAccounts = input.accountIds?.length ? new Set(input.accountIds) : undefined;
        const visibleScheduleCount = schedules.filter(
          (schedule) => !includedAccounts || includedAccounts.has(schedule.accountId),
        ).length;
        const missingScheduledDraft = all.length < visibleScheduleCount;
        if (forceProviderSearch || input.refresh || (needsInitialPage && missingScheduledDraft)) {
          try {
            await this.syncCompleteView(draftInput, forceProviderSearch ? "manual" : "startup");
            all = this.options.cache.listScheduledThreads(this.activeScheduled(), input.accountIds);
          } catch (error) {
            if (!all.length) throw error;
          }
        } else if (input.backgroundRefresh) {
          this.refreshCompleteViewInBackground(
            draftInput,
            `complete:${backgroundRefreshKey(draftInput)}`,
          );
        }
        const items = all.slice(offset, offset + input.pageSize);
        const loadedThrough = offset + items.length;
        return {
          value: {
            items,
            totalCount: all.length,
            ...(loadedThrough < all.length ? { nextCursor: String(loadedThrough) } : {}),
            syncing: false,
          },
          cacheStatus: items.length ? ("hit" as const) : ("miss" as const),
        };
      }
      const refreshKey = backgroundRefreshKey(input);
      if (input.cursor) await this.backgroundViewRefreshes.get(refreshKey);
      const offset = parseCursor(input.cursor);
      const accounts = this.accountsFor(input);
      const scheduledDrafts = this.activeScheduled(
        input.accountIds?.length ? input.accountIds : accounts.map((account) => account.id),
        true,
      );
      const listInput = {
        view: input.view,
        accountIds: input.accountIds,
        label: input.label,
        query: input.query,
        resultSetKey: currentViewKey,
        scheduledDrafts,
      };
      const cachedBeforeSync = this.options.cache.listThreads({
        ...listInput,
        offset,
        limit: input.pageSize,
      });
      const cacheHit = cachedBeforeSync.length > 0;
      const needsInitialPage = accounts.some(
        (account) => !this.options.cache.getPageState(account.id, currentViewKey).initialized,
      );
      if (forceProviderSearch || input.refresh || needsInitialPage) {
        try {
          await this.syncView(input, forceProviderSearch ? "manual" : "startup", "refresh");
        } catch (error) {
          if (!cacheHit) throw error;
        }
      } else if (input.backgroundRefresh) {
        this.refreshViewInBackground(input, refreshKey);
      }

      let totalCount = this.options.cache.countThreads(listInput);
      while (totalCount <= offset && this.hasNextPage(accounts, currentViewKey)) {
        await this.syncView(input, forceProviderSearch ? "manual" : "startup", "loadMore");
        totalCount = this.options.cache.countThreads(listInput);
      }

      const items = this.options.cache.listThreads({
        ...listInput,
        offset,
        limit: input.pageSize,
      });
      totalCount = this.options.cache.countThreads(listInput);
      const loadedThrough = offset + items.length;
      const hasMore = totalCount > loadedThrough || this.hasNextPage(accounts, currentViewKey);
      return {
        value: {
          items,
          totalCount,
          ...(hasMore && items.length ? { nextCursor: String(loadedThrough) } : {}),
          syncing: false,
        },
        cacheStatus: cacheHit ? (forceProviderSearch ? "mixed" : "hit") : "miss",
      };
    });
  }

  async getThread(accountId: string, threadId: string): Promise<MailThread> {
    return this.measure("get_thread", async () => {
      // A response that a mutation or mailbox refresh made stale is fetched again. After a few
      // tries, keep the latest response so a busy mailbox can't stall the reader.
      for (let attempt = 1; ; attempt += 1) {
        const cached = this.options.cache.getThread(accountId, threadId);
        if (cached) return { value: cached, cacheStatus: "hit" as const };
        const thread = await this.loadThread(accountId, threadId, {
          cacheStale: attempt >= MAX_THREAD_LOAD_ATTEMPTS,
        });
        if (thread) return { value: thread, cacheStatus: "miss" as const };
      }
    });
  }

  /** Hydrates conversations the reader is likely to open next so they open from the cache. */
  prefetchThreads(targets: Array<{ accountId: string; threadId: string }>): void {
    const accountIds = new Set(this.accounts().map((account) => account.id));
    const pending = uniqueThreadTargets(targets)
      .filter(
        (target) =>
          accountIds.has(target.accountId) &&
          !this.threadFetches.has(threadTargetKey(target)) &&
          !this.options.cache.hasThreadBody(target.accountId, target.threadId),
      )
      .slice(0, MAX_THREAD_PREFETCH);
    if (!pending.length) return;
    void (async () => {
      for (let index = 0; index < pending.length; index += THREAD_PREFETCH_CONCURRENCY)
        await Promise.allSettled(
          pending
            .slice(index, index + THREAD_PREFETCH_CONCURRENCY)
            .map((target) =>
              this.options.cache.hasThreadBody(target.accountId, target.threadId)
                ? undefined
                : this.loadThread(target.accountId, target.threadId),
            ),
        );
    })();
  }

  /**
   * Fetches a conversation and caches it unless a mutation or mailbox write touched the thread
   * while the request was in flight, in which case it resolves to undefined. A prefetch and the
   * reader opening the same thread share one request, but only while the cache is unchanged.
   */
  private loadThread(
    accountId: string,
    threadId: string,
    options: { cacheStale?: boolean } = {},
  ): Promise<MailThread | undefined> {
    const key = threadTargetKey({ accountId, threadId });
    const version = this.threadVersion(accountId, threadId);
    const inFlight = this.threadFetches.get(key);
    if (inFlight?.version === version && !options.cacheStale) return inFlight.request;
    const request = this.context.service
      .getThread(accountId, threadId)
      .then((thread) =>
        options.cacheStale || this.threadVersion(accountId, threadId) === version
          ? this.options.cache.putThread(this.requireAccount(accountId), thread)
          : undefined,
      )
      .finally(() => {
        if (this.threadFetches.get(key)?.request === request) this.threadFetches.delete(key);
      });
    this.threadFetches.set(key, { version, request });
    return request;
  }

  private threadVersion(accountId: string, threadId: string): string {
    return `${this.cacheGeneration}:${this.options.cache.threadRevision(accountId, threadId)}`;
  }

  async modify(
    rawTargets: Array<{ accountId: string; threadId: string }>,
    action: ModifyActionInput,
    undoable = true,
  ): Promise<MailModifyResult> {
    const targets = uniqueThreadTargets(rawTargets);
    let mutationId: string | undefined;
    this.cacheGeneration += 1;
    try {
      const canUndo = undoable && action.type !== "delete" && action.type !== "discardDraft";
      const undoableMutation = canUndo ? ++this.undoableMutationSequence : undefined;
      const targetKeys = new Set(targets.map((target) => threadTargetKey(target)));
      const supersedesCurrentUndo = this.latestUndo?.snapshots.some((snapshot) =>
        targetKeys.has(
          threadTargetKey({ accountId: snapshot.accountId, threadId: snapshot.thread.id }),
        ),
      );
      if (canUndo || supersedesCurrentUndo) this.latestUndo = undefined;
      if (action.type === "discardDraft") {
        await this.discardDrafts(targets);
        return {};
      }
      const currentMutationId = `modify-${randomUUID()}`;
      mutationId = currentMutationId;
      const snapshots = targets.map((target) => ({
        target,
        row: this.options.cache.snapshotThread(target.accountId, target.threadId),
      }));
      this.options.cache.claimMutation(currentMutationId, targets);
      for (const target of targets)
        this.options.cache.applyActionIfOwned(
          target.accountId,
          target.threadId,
          action,
          currentMutationId,
        );
      this.options.onCacheChanged();
      const flags = messageFlagsForAction(action);
      return await this.measure("modify", async () => {
        const groupEntries = groupThreadTargetsByAccount(targets);
        // Message ids each thread's change was sent to, and which of them the provider confirmed.
        const sentMessageIds = new Map<string, string[]>();
        const confirmedMessageIds = new Set<string>();
        const mutationResults = await Promise.allSettled(
          groupEntries.map(([accountId, accountTargets]) =>
            this.enqueueProviderMutation(accountId, async () => {
              const resolved = await Promise.all(
                accountTargets.map(async (target) => {
                  // A flag change without undo can use a fully hydrated conversation's message
                  // ids. A mailbox listing may hold only some of a thread's messages, and
                  // anything else needs the provider's current thread, which is also the
                  // snapshot an undo restores.
                  const cachedIds =
                    flags &&
                    !canUndo &&
                    this.options.cache.hasThreadBody(target.accountId, target.threadId)
                      ? this.options.cache.messageIds(target.accountId, target.threadId)
                      : [];
                  if (cachedIds.length) return { target, messageIds: cachedIds };
                  const thread = await this.context.service.getThread(
                    target.accountId,
                    target.threadId,
                  );
                  return {
                    target,
                    thread,
                    messageIds: thread.messages.map((message) => message.id),
                  };
                }),
              );
              for (const { target, messageIds } of resolved)
                sentMessageIds.set(threadTargetKey(target), messageIds);
              const result = await this.context.service.modify(
                accountId,
                [...new Set(resolved.flatMap(({ messageIds }) => messageIds))],
                toModifyAction(action),
              );
              for (const messageId of result?.succeededIds ?? [])
                confirmedMessageIds.add(`${accountId}\u0000${messageId}`);
              return {
                accountId,
                threads: resolved.flatMap(({ thread }) => (thread ? [thread] : [])),
              };
            }),
          ),
        );
        const failedAccountIds = new Set(
          mutationResults.flatMap((result, index) =>
            result.status === "rejected" ? [groupEntries[index]![0]] : [],
          ),
        );
        await Promise.all(
          snapshots
            .filter((snapshot) => failedAccountIds.has(snapshot.target.accountId))
            .map(async (snapshot) => {
              if (
                !this.options.cache.ownsMutation(
                  snapshot.target.accountId,
                  snapshot.target.threadId,
                  currentMutationId,
                )
              )
                return;
              try {
                const thread = await this.context.service.getThread(
                  snapshot.target.accountId,
                  snapshot.target.threadId,
                );
                this.options.cache.putThreadIfOwned(
                  this.requireAccount(snapshot.target.accountId),
                  thread,
                  currentMutationId,
                );
              } catch (error) {
                if (isEmailError(error) && error.code === "not_found") {
                  this.options.cache.finalizeDeleteIfOwned(
                    snapshot.target.accountId,
                    snapshot.target.threadId,
                    currentMutationId,
                  );
                } else if (snapshot.row) {
                  this.options.cache.restoreThreadIfOwned(snapshot.row, currentMutationId);
                }
              }
            }),
        );
        const successfulTargets = targets.filter(
          (target) => !failedAccountIds.has(target.accountId),
        );
        const rehydratedTargetKeys = new Set<string>();
        if (action.type === "delete") {
          for (const target of successfulTargets)
            this.options.cache.finalizeDeleteIfOwned(
              target.accountId,
              target.threadId,
              currentMutationId,
            );
        } else {
          const rehydrationResults = await Promise.allSettled(
            successfulTargets.map(async (target) => {
              const messageIds = sentMessageIds.get(threadTargetKey(target)) ?? [];
              // When the provider confirmed a flag change on every message, record it locally
              // instead of fetching the conversation again.
              if (
                flags &&
                messageIds.length &&
                messageIds.every((messageId) =>
                  confirmedMessageIds.has(`${target.accountId}\u0000${messageId}`),
                )
              )
                return this.options.cache.applyMessageFlagsIfOwned(
                  this.requireAccount(target.accountId),
                  target.threadId,
                  messageIds,
                  flags,
                  currentMutationId,
                )
                  ? target
                  : undefined;
              const thread = await this.context.service.getThread(
                target.accountId,
                target.threadId,
              );
              const cached = this.options.cache.putThreadIfOwned(
                this.requireAccount(target.accountId),
                thread,
                currentMutationId,
              );
              return cached ? target : undefined;
            }),
          );
          for (const result of rehydrationResults)
            if (result.status === "fulfilled" && result.value)
              rehydratedTargetKeys.add(threadTargetKey(result.value));
        }
        // Flag changes leave folders alone. Only read state can move a provider-reported unread
        // count, and the next sync refreshes folders anyway, so skip the request when no inbox
        // reports one.
        const targetAccountIds = new Set(targets.map((target) => target.accountId));
        const refreshFolders =
          !flags ||
          (flags.read !== undefined &&
            this.options.cache
              .listFolders()
              .some(
                (folder) =>
                  folder.role === "inbox" &&
                  folder.unreadCount !== undefined &&
                  targetAccountIds.has(folder.accountId),
              ));
        if (refreshFolders) await this.folders(true).catch(() => []);
        this.options.onCacheChanged();
        const failure = mutationResults.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const canOfferUndo =
          successfulTargets.length > 0 &&
          successfulTargets.every(
            (target) =>
              rehydratedTargetKeys.has(threadTargetKey(target)) &&
              this.options.cache.ownsMutation(target.accountId, target.threadId, currentMutationId),
          );
        const undoSnapshots = canOfferUndo
          ? mutationResults.flatMap((result) =>
              result.status === "fulfilled"
                ? result.value.threads.map((thread) => ({
                    accountId: result.value.accountId,
                    thread,
                  }))
                : [],
            )
          : [];
        const value: MailModifyResult = {};
        if (undoableMutation === this.undoableMutationSequence && undoSnapshots.length) {
          const token = `undo-${randomUUID()}`;
          this.latestUndo = { token, action, snapshots: undoSnapshots };
          value.undoToken = token;
        }
        return { value };
      });
    } finally {
      if (mutationId) this.options.cache.releaseMutation(mutationId, targets);
      this.cacheGeneration += 1;
    }
  }

  async undo(token: string): Promise<MailUndoResult> {
    const entry = this.latestUndo;
    if (!entry || entry.token !== token) return { undone: false };
    this.latestUndo = undefined;

    const targets = entry.snapshots.map(({ accountId, thread }) => ({
      accountId,
      threadId: thread.id,
    }));
    const mutationId = `undo-${randomUUID()}`;
    const rollbackStates = targets.map((target) => ({
      target,
      state: this.options.cache.snapshotThreadState(target.accountId, target.threadId),
    }));
    let mutationClaimed = false;
    this.cacheGeneration += 1;

    try {
      const accounts = new Map(
        [...new Set(entry.snapshots.map((snapshot) => snapshot.accountId))].map((accountId) => [
          accountId,
          this.requireAccount(accountId),
        ]),
      );
      this.options.cache.claimMutation(mutationId, targets);
      mutationClaimed = true;
      for (const snapshot of entry.snapshots) {
        this.options.cache.putThreadIfOwned(
          accounts.get(snapshot.accountId)!,
          snapshot.thread,
          mutationId,
        );
      }
      this.options.onCacheChanged();

      return await this.measure("modify", async () => {
        const snapshotGroups = groupSnapshotsByAccount(entry.snapshots);
        const results = await Promise.allSettled(
          snapshotGroups.map(([accountId, snapshots]) =>
            this.enqueueProviderMutation(accountId, async () => {
              const currentThreads = await Promise.all(
                snapshots.map(({ thread }) => this.context.service.getThread(accountId, thread.id)),
              );
              const operations = buildSnapshotRestoreOperations(
                currentThreads,
                snapshots,
                this.requireAccount(accountId).provider,
                entry.action,
              );
              for (const operation of operations) {
                await this.context.service.modify(
                  accountId,
                  operation.messageIds,
                  operation.action,
                );
              }
              return accountId;
            }),
          ),
        );
        const failedAccountIds = new Set(
          results.flatMap((result, index) =>
            result.status === "rejected" ? [snapshotGroups[index]![0]] : [],
          ),
        );

        await Promise.all(
          targets.map(async (target) => {
            if (!this.options.cache.ownsMutation(target.accountId, target.threadId, mutationId))
              return;
            try {
              const thread = await this.context.service.getThread(
                target.accountId,
                target.threadId,
              );
              this.options.cache.putThreadIfOwned(
                this.requireAccount(target.accountId),
                thread,
                mutationId,
              );
            } catch (error) {
              const rollback = rollbackStates.find(
                (candidate) =>
                  candidate.target.accountId === target.accountId &&
                  candidate.target.threadId === target.threadId,
              );
              if (failedAccountIds.has(target.accountId) && rollback) {
                this.options.cache.restoreThreadStateIfOwned(rollback.state, mutationId);
              } else if (isEmailError(error) && error.code === "not_found") {
                this.options.cache.finalizeDeleteIfOwned(
                  target.accountId,
                  target.threadId,
                  mutationId,
                );
              }
            }
          }),
        );
        await this.folders(true).catch(() => []);
        this.options.onCacheChanged();
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return { value: { undone: true } };
      });
    } finally {
      if (mutationClaimed) this.options.cache.releaseMutation(mutationId, targets);
      this.cacheGeneration += 1;
    }
  }

  private async discardDrafts(
    targets: Array<{ accountId: string; threadId: string }>,
  ): Promise<void> {
    await this.measure("modify", async () => {
      const draftEntries = (
        await Promise.all(
          targets.map(async (target) => {
            const account = this.requireAccount(target.accountId);
            const thread = await this.context.service.getThread(target.accountId, target.threadId);
            const draftIds = thread.messages.flatMap((message) =>
              message.flags.draft && message.draftId ? [message.draftId] : [],
            );
            if (!draftIds.length) throw new Error("This draft is no longer available.");
            return [...new Set(draftIds)].map((draftId) => ({ account, draftId }));
          }),
        )
      ).flat();
      const drafts = [
        ...new Map(
          draftEntries.map((draft) => [`${draft.account.id}:${draft.draftId}`, draft]),
        ).values(),
      ];
      const results = await Promise.allSettled(
        drafts.map(async ({ account, draftId }) => {
          this.cancelSchedulesForDraft(account.id, draftId);
          await this.context.service.deleteDraft(account.id, draftId);
          this.options.cache.deleteDraft(account, draftId);
        }),
      );
      if (results.some((result) => result.status === "fulfilled")) this.options.onCacheChanged();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return { value: undefined };
    });
  }

  async saveDraft(input: ComposeInput): Promise<{ draftId: string; messageId: string }> {
    return this.measure("save_draft", async () => {
      const payload = await this.toSendInput(input);
      const draft = input.draftId
        ? await this.context.service.updateDraft(input.accountId, input.draftId, payload)
        : await this.context.service.createDraft(input.accountId, payload);
      if (!draft.draftId) throw new Error("Gmail did not return a draft ID.");
      this.options.cache.putMessages(this.requireAccount(input.accountId), [draft], {
        invalidateBodies: true,
      });
      if (input.recipientFields)
        this.options.cache.putDraftRecipientFields(
          input.accountId,
          draft.draftId,
          input.recipientFields,
          draft,
        );
      this.includeThreadInViews(input.accountId, draft.threadId, ["drafts", "all"]);
      this.options.onCacheChanged();
      return { value: { draftId: draft.draftId, messageId: draft.id } };
    });
  }

  draftRecipientFields(accountId: string, draftId: string): DraftRecipientFields | undefined {
    return this.options.cache.getDraftRecipientFields(accountId, draftId);
  }

  async deleteDraft(accountId: string, draftId: string): Promise<void> {
    await this.measure("delete_draft", async () => {
      this.cancelSchedulesForDraft(accountId, draftId);
      await this.context.service.deleteDraft(accountId, draftId);
      this.options.cache.deleteDraft(this.requireAccount(accountId), draftId);
      this.options.onCacheChanged();
      return { value: undefined };
    });
  }

  async send(input: ComposeInput): Promise<{ id: string; threadId: string }> {
    return this.measure("send", async () => {
      let result: { id: string; threadId: string };
      if (input.draftId) {
        const account = this.requireAccount(input.accountId);
        const draft = await this.context.service.updateDraft(
          input.accountId,
          input.draftId,
          await this.toSendInput(input, true),
        );
        this.options.cache.putMessages(account, [draft], {
          invalidateBodies: true,
        });
        this.cancelSchedulesForDraft(input.accountId, input.draftId);
        result = await this.context.service.send(input.accountId, {
          draftId: input.draftId,
        });
        this.options.cache.deleteDraft(account, input.draftId);
      } else {
        result = await this.context.service.send(
          input.accountId,
          await this.toSendInput(input, true),
        );
      }
      try {
        const thread = await this.context.service.getThread(input.accountId, result.threadId);
        this.options.cache.putThread(this.requireAccount(input.accountId), thread);
        this.includeThreadInViews(input.accountId, result.threadId, ["sent", "all"]);
      } catch {
        this.options.cache.invalidateThread(input.accountId, result.threadId);
      }
      this.options.onCacheChanged();
      return { value: { id: result.id, threadId: result.threadId } };
    });
  }

  async schedule(input: ScheduledSendInput): Promise<ScheduledSendResult> {
    return this.measure("send", async () => {
      const account = this.requireAccount(input.accountId);
      const draft = input.draftId
        ? await this.context.service.updateDraft(
            input.accountId,
            input.draftId,
            await this.toSendInput(input, true),
          )
        : await this.context.service.createDraft(
            input.accountId,
            await this.toSendInput(input, true),
          );
      if (!draft.draftId) throw new Error("The provider did not return a draft ID.");
      if (input.delaySeconds) this.options.cache.putOptimisticDraft(account, draft);
      else this.options.cache.putMessages(account, [draft], { invalidateBodies: true });
      if (input.recipientFields)
        this.options.cache.putDraftRecipientFields(
          input.accountId,
          draft.draftId,
          input.recipientFields,
          draft,
        );
      this.includeThreadInViews(input.accountId, draft.threadId, [
        "drafts",
        "all",
        ...(input.delaySeconds ? (["sent"] as const) : []),
      ]);
      const canceledSchedules = input.draftId
        ? this.cancelSchedulesForDraft(input.accountId, draft.draftId)
        : [];
      const sendAt = scheduledSendAt(input);
      let scheduled: Awaited<ReturnType<AppContext["service"]["scheduleSend"]>>;
      try {
        scheduled = await this.context.service.scheduleSend(
          input.accountId,
          { draftId: draft.draftId },
          sendAt,
        );
      } catch (error) {
        try {
          await this.restoreCanceledSchedules(canceledSchedules);
        } catch (restoreError) {
          this.options.onCacheChanged();
          throw restoreError;
        }
        if (input.draftId) this.options.onCacheChanged();
        else await this.cleanupDraftAfterScheduleFailure(account, draft.draftId);
        throw error;
      }
      if (input.delaySeconds) this.undoScheduleIds.add(scheduled.scheduleId);
      this.trackScheduledCache({
        scheduleId: scheduled.scheduleId,
        accountId: input.accountId,
        draftId: scheduled.draftId,
        sendAt: scheduled.sendAt,
      });
      this.options.onCacheChanged();
      return {
        value: {
          scheduleId: scheduled.scheduleId,
          draftId: scheduled.draftId,
          sendAt: scheduled.sendAt,
        },
      };
    });
  }

  async cancelScheduled(scheduleId: string): Promise<{ draftId: string }> {
    return this.measure("send", async () => {
      const result = this.context.service.cancelScheduled(scheduleId);
      this.clearScheduledCacheTracking(scheduleId);
      this.options.onCacheChanged();
      return { value: { draftId: result.draftId } };
    });
  }

  private cancelSchedulesForDraft(accountId: string, draftId: string): CanceledSchedule[] {
    const canceled: CanceledSchedule[] = [];
    for (const scheduled of this.activeScheduled([accountId], true).filter(
      (item) => item.draftId === draftId,
    )) {
      const undo = this.undoScheduleIds.has(scheduled.scheduleId);
      this.context.service.cancelScheduled(scheduled.scheduleId);
      canceled.push({ ...scheduled, undo });
      this.clearScheduledCacheTracking(scheduled.scheduleId);
    }
    return canceled;
  }

  private async restoreCanceledSchedules(schedules: CanceledSchedule[]): Promise<void> {
    for (const previous of schedules) {
      const restored = await this.context.service.scheduleSend(
        previous.accountId,
        { draftId: previous.draftId },
        previous.sendAt,
      );
      if (previous.undo) this.undoScheduleIds.add(restored.scheduleId);
      this.trackScheduledCache({
        scheduleId: restored.scheduleId,
        accountId: previous.accountId,
        draftId: restored.draftId,
        sendAt: restored.sendAt,
      });
    }
  }

  private clearScheduledCacheTracking(scheduleId: string): void {
    const tracking = this.scheduledCacheTimers.get(scheduleId);
    if (tracking) clearTimeout(tracking.timer);
    this.scheduledCacheTimers.delete(scheduleId);
    this.undoScheduleIds.delete(scheduleId);
  }

  async forward(input: {
    accountId: string;
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
  }): Promise<ScheduledSendResult | undefined> {
    return this.measure("forward", async () => {
      const original = await this.context.service.getMessage(input.accountId, input.messageId);
      const originalAttachments = input.includeAttachments
        ? await Promise.all(
            (original.attachments ?? []).map(async (attachment) => {
              const result = await this.context.service.getAttachment(
                input.accountId,
                original.id,
                attachment.id,
                this.context.config.maxAttachmentBytes,
              );
              return {
                filename: result.meta.filename,
                mimeType: result.meta.mimeType,
                content: result.content.toString("base64"),
                ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
                ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
              } satisfies AttachmentInput;
            }),
          )
        : [];
      const addedAttachments = input.attachments?.length
        ? await Promise.all(
            input.attachments.map((attachment) => this.options.resolveAttachment(attachment)),
          )
        : [];
      const payload: SendInput = {
        ...(input.from ? { from: input.from } : {}),
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        ...(input.bcc?.length ? { bcc: input.bcc } : {}),
        subject: input.subject,
        body: forwardBody(original, input.text ?? input.comment, input.html),
        ...(originalAttachments.length || addedAttachments.length
          ? { attachments: [...originalAttachments, ...addedAttachments] }
          : {}),
      };
      if (input.sendAt || input.delaySeconds) {
        const account = this.requireAccount(input.accountId);
        const draft = await this.context.service.createDraft(input.accountId, payload);
        if (!draft.draftId) throw new Error("The provider did not return a draft ID.");
        if (input.delaySeconds) this.options.cache.putOptimisticDraft(account, draft);
        else this.options.cache.putMessages(account, [draft], { invalidateBodies: true });
        this.includeThreadInViews(input.accountId, draft.threadId, [
          "drafts",
          "all",
          ...(input.delaySeconds ? (["sent"] as const) : []),
        ]);
        const sendAt = scheduledSendAt(
          input.delaySeconds ? { delaySeconds: input.delaySeconds } : { sendAt: input.sendAt! },
        );
        let scheduled: Awaited<ReturnType<AppContext["service"]["scheduleSend"]>>;
        try {
          scheduled = await this.context.service.scheduleSend(
            input.accountId,
            { draftId: draft.draftId },
            sendAt,
          );
        } catch (error) {
          await this.cleanupDraftAfterScheduleFailure(account, draft.draftId);
          throw error;
        }
        if (input.delaySeconds) this.undoScheduleIds.add(scheduled.scheduleId);
        this.trackScheduledCache({
          scheduleId: scheduled.scheduleId,
          accountId: input.accountId,
          draftId: scheduled.draftId,
          sendAt: scheduled.sendAt,
        });
        this.options.onCacheChanged();
        return {
          value: {
            scheduleId: scheduled.scheduleId,
            draftId: scheduled.draftId,
            sendAt: scheduled.sendAt,
          },
        };
      }
      const result = await this.context.service.send(input.accountId, payload);
      try {
        const thread = await this.context.service.getThread(input.accountId, result.threadId);
        this.options.cache.putThread(this.requireAccount(input.accountId), thread);
        this.includeThreadInViews(input.accountId, result.threadId, ["sent", "all"]);
      } catch {
        this.options.cache.invalidateThread(input.accountId, result.threadId);
      }
      this.options.onCacheChanged();
      return { value: undefined };
    });
  }

  private async cleanupDraftAfterScheduleFailure(
    account: AccountInfo,
    draftId: string,
  ): Promise<void> {
    try {
      await this.context.service.deleteDraft(account.id, draftId);
      this.options.cache.deleteDraft(account, draftId);
    } catch {
      // Keep an undeletable provider draft cached so it remains visible in Drafts.
    }
    this.options.onCacheChanged();
  }

  private restoreScheduledCacheTracking(): void {
    for (const scheduled of this.context.service.listScheduled()) {
      const target = {
        scheduleId: scheduled.scheduleId,
        accountId: scheduled.accountId,
        draftId: scheduled.draftId,
        sendAt: scheduled.sendAt,
      };
      if (scheduled.status === "pending" || scheduled.status === "sending") {
        this.trackScheduledCache(target);
      } else if (
        scheduled.status === "sent" &&
        scheduled.sentThreadId &&
        this.options.cache.hasDraft(scheduled.accountId, scheduled.draftId)
      ) {
        void this.completeScheduledCache(target, scheduled.sentThreadId);
      }
    }
  }

  private activeScheduled(
    accountIds?: string[],
    includeUndo = false,
  ): Array<ScheduledDraftRef & { scheduleId: string }> {
    const includedAccounts = accountIds ? new Set(accountIds) : undefined;
    return this.context.service
      .listScheduled()
      .filter(
        (item) =>
          (item.status === "pending" || item.status === "sending") &&
          (includeUndo || !this.undoScheduleIds.has(item.scheduleId)) &&
          (!includedAccounts || includedAccounts.has(item.accountId)),
      )
      .map((item) => ({
        scheduleId: item.scheduleId,
        accountId: item.accountId,
        draftId: item.draftId,
        sendAt: item.sendAt,
        ...(this.undoScheduleIds.has(item.scheduleId) ? { pendingSend: true } : {}),
      }));
  }

  private trackScheduledCache(
    target: ScheduledCacheTarget,
    delayMs = Math.max(0, Date.parse(target.sendAt) - Date.now()) + 100,
    nextPollMs = 250,
  ): void {
    const previous = this.scheduledCacheTimers.get(target.scheduleId);
    if (previous) clearTimeout(previous.timer);
    const timerDelay = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.scheduledCacheTimers.delete(target.scheduleId);
      if (delayMs > MAX_TIMER_DELAY_MS) {
        this.trackScheduledCache(target);
        return;
      }
      void this.reconcileScheduledCache(target, nextPollMs);
    }, timerDelay);
    timer.unref();
    this.scheduledCacheTimers.set(target.scheduleId, { timer, target });
  }

  private async reconcileScheduledCache(
    target: ScheduledCacheTarget,
    pollMs: number,
  ): Promise<void> {
    const scheduled = this.context.service
      .listScheduled(target.accountId)
      .find((item) => item.scheduleId === target.scheduleId);
    if (!scheduled || scheduled.status === "canceled" || scheduled.status === "failed") {
      this.undoScheduleIds.delete(target.scheduleId);
      this.options.onCacheChanged();
      return;
    }
    if (scheduled.status === "pending" || scheduled.status === "sending") {
      if (
        this.undoScheduleIds.has(target.scheduleId) &&
        (scheduled.attempts > 0 || Boolean(scheduled.lastError))
      ) {
        this.undoScheduleIds.delete(target.scheduleId);
        this.options.onCacheChanged();
      }
      this.trackScheduledCache(target, pollMs, Math.min(pollMs * 2, 30_000));
      return;
    }
    if (scheduled.sentThreadId) await this.completeScheduledCache(target, scheduled.sentThreadId);
  }

  private async completeScheduledCache(
    target: ScheduledCacheTarget,
    sentThreadId: string,
  ): Promise<void> {
    this.undoScheduleIds.delete(target.scheduleId);
    const account = this.accounts().find((candidate) => candidate.id === target.accountId);
    if (!account) return;
    this.options.cache.deleteDraft(account, target.draftId);
    this.options.onCacheChanged();
    try {
      const thread = await this.context.service.getThread(target.accountId, sentThreadId);
      this.options.cache.putThread(account, thread);
      this.includeThreadInViews(target.accountId, sentThreadId, ["sent", "all"]);
    } catch {
      this.options.cache.invalidateThread(target.accountId, sentThreadId);
    }
    this.options.onCacheChanged();
  }

  async attachment(
    accountId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{
    meta: { filename: string; mimeType: string };
    content: Buffer;
  }> {
    return this.measure("download_attachment", async () => ({
      value: await this.context.service.getAttachment(
        accountId,
        messageId,
        attachmentId,
        this.context.config.maxAttachmentBytes,
      ),
    }));
  }

  async refresh(
    trigger: SyncTrigger = "manual",
    activeInput: ThreadListInput = { view: "inbox" },
  ): Promise<number> {
    const started = performance.now();
    try {
      this.assertStoreCompatible();
      this.reconcileCachedAccounts(this.accounts());
      await this.folders(true);
      const inboxInput: ThreadListInput = { view: "inbox", pageSize: 100 };
      const draftInput: ThreadListInput = { view: "drafts", pageSize: 100 };
      const activeViewKey = viewKey(activeInput);
      let count = await this.syncView(inboxInput, trigger, "refresh");
      let draftsSynced = false;
      if (["startup", "manual", "resume", "mutation"].includes(trigger)) {
        try {
          count += await this.syncCompleteView(draftInput, trigger);
          draftsSynced = true;
        } catch {
          // Draft counts are supplemental unless Drafts is the active mailbox.
        }
      }
      if (
        activeInput.view !== "scheduled" &&
        activeViewKey !== viewKey(inboxInput) &&
        !(draftsSynced && activeViewKey === viewKey(draftInput))
      ) {
        count +=
          activeInput.view === "drafts"
            ? await this.syncCompleteView(activeInput, trigger)
            : await this.syncView(activeInput, trigger, "refresh");
      }
      this.options.analytics.captureSync({
        trigger,
        outcome: "success",
        durationMs: performance.now() - started,
        itemCount: count,
      });
      return count;
    } catch (error) {
      this.options.analytics.captureSync({
        trigger,
        outcome: "error",
        durationMs: performance.now() - started,
        itemCount: 0,
      });
      throw error;
    }
  }

  private async syncCompleteView(input: ThreadListInput, trigger: SyncTrigger): Promise<number> {
    const refreshedAccounts = new Set<string>();
    let count = await this.syncView(input, trigger, "refresh", refreshedAccounts);
    const accounts = this.accountsFor(input);
    const currentViewKey = viewKey(input);
    while (this.hasNextPage(accounts, currentViewKey))
      count += await this.syncView(input, trigger, "loadMore");
    const role = reconciledFolderRole(input);
    if (role)
      for (const account of accounts)
        if (refreshedAccounts.has(account.id))
          this.options.cache.reconcileCompleteView(account, currentViewKey, role);
    return count;
  }

  private async syncView(
    input: ThreadListInput,
    trigger: SyncTrigger,
    mode: "refresh" | "loadMore",
    refreshedAccounts?: Set<string>,
  ): Promise<number> {
    const accounts = this.accountsFor(input);
    const currentViewKey = viewKey(input);
    const refreshGeneration = mode === "refresh" ? (this.viewRefreshGeneration += 1) : undefined;
    const pageResults = await Promise.allSettled(
      accounts.map(async (account) => {
        const query = toEmailQuery(input);
        const cacheGeneration = this.cacheGeneration;
        const currentAccountViewKey = accountViewKey(account.id, currentViewKey);
        const committedRefreshGeneration = this.committedViewRefreshes.get(currentAccountViewKey);
        const pageState = this.options.cache.getPageState(account.id, currentViewKey);
        if (mode === "loadMore" && pageState.initialized && !pageState.nextToken) return undefined;
        const token = mode === "loadMore" ? pageState.nextToken : undefined;
        const page = await this.context.service.listMessages(account.id, query, {
          pageSize: input.pageSize ?? 100,
          ...(token ? { pageToken: token } : {}),
        });
        if (cacheGeneration !== this.cacheGeneration) return undefined;
        if (
          refreshGeneration !== undefined
            ? refreshGeneration < (this.committedViewRefreshes.get(currentAccountViewKey) ?? 0)
            : committedRefreshGeneration !== this.committedViewRefreshes.get(currentAccountViewKey)
        )
          return undefined;
        this.options.cache.putMessages(account, page.items);
        this.options.cache.recordResultPage(
          account.id,
          currentViewKey,
          page.items.map((message) => message.threadId),
          mode === "refresh",
        );
        const folderRole = reconciledFolderRole(input);
        if (mode === "refresh" && folderRole)
          this.options.cache.reconcileFolderPage(
            account,
            folderRole,
            page.items,
            !page.nextPageToken,
          );
        this.options.cache.setPageToken(account.id, currentViewKey, page.nextPageToken);
        if (mode === "refresh") refreshedAccounts?.add(account.id);
        if (input.view === "inbox" && mode === "refresh") {
          const notification = this.options.cache.recordInboxPage(account.id, page.items);
          const newMessages = notification.newMessages.filter(
            (message) => message.from?.email.toLowerCase() !== account.email.toLowerCase(),
          );
          if (newMessages.length) this.options.onNewMessages(newMessages, account);
        }
        if (refreshGeneration !== undefined)
          this.committedViewRefreshes.set(currentAccountViewKey, refreshGeneration);
        return page.items.length;
      }),
    );
    const pages = pageResults.flatMap((result) =>
      result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
    );
    const failure = pageResults.find((result) => result.status === "rejected");
    if (!pages.length && failure) throw failure.reason;
    if (pages.length) this.options.onCacheChanged();
    return pages.reduce((sum, value) => sum + value, 0);
  }

  private accountsFor(input: ThreadListInput): AccountInfo[] {
    return this.accounts().filter(
      (account) => !input.accountIds?.length || input.accountIds.includes(account.id),
    );
  }

  private reconcileCachedAccounts(accounts: AccountInfo[]): void {
    const connected = new Set(accounts.map((account) => account.id));
    for (const accountId of this.options.cache.accountIds())
      if (!connected.has(accountId)) this.options.cache.deleteAccount(accountId);
  }

  private hasNextPage(accounts: AccountInfo[], currentViewKey: string): boolean {
    return accounts.some(
      (account) => this.options.cache.getPageState(account.id, currentViewKey).nextToken,
    );
  }

  private refreshViewInBackground(input: ThreadListInput, refreshKey: string): void {
    if (this.backgroundViewRefreshes.has(refreshKey)) return;
    const refresh = this.syncView(input, "startup", "refresh")
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (this.backgroundViewRefreshes.get(refreshKey) === refresh)
          this.backgroundViewRefreshes.delete(refreshKey);
      });
    this.backgroundViewRefreshes.set(refreshKey, refresh);
  }

  private refreshCompleteViewInBackground(input: ThreadListInput, refreshKey: string): void {
    if (this.backgroundViewRefreshes.has(refreshKey)) return;
    const refresh = this.syncCompleteView(input, "startup")
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (this.backgroundViewRefreshes.get(refreshKey) === refresh)
          this.backgroundViewRefreshes.delete(refreshKey);
      });
    this.backgroundViewRefreshes.set(refreshKey, refresh);
  }

  private includeThreadInViews(accountId: string, threadId: string, views: MailboxView[]): void {
    for (const view of views)
      this.options.cache.recordResultPage(accountId, viewKey({ view }), [threadId], false);
  }

  private requireAccount(accountId: string): AccountInfo {
    const account = this.accounts().find((candidate) => candidate.id === accountId);
    if (!account) throw new Error("This email account is no longer connected.");
    return account;
  }

  private async toSendInput(input: ComposeInput, includeQuotedReply = false): Promise<SendInput> {
    let attachments = input.attachments?.length
      ? await Promise.all(
          input.attachments.map((attachment) => this.options.resolveAttachment(attachment)),
        )
      : undefined;
    let body: NonNullable<SendInput["body"]> = {
      ...(input.text ? { text: input.text } : {}),
      ...(input.html ? { html: input.html } : {}),
    };
    if (includeQuotedReply && input.replyToMessageId) {
      const original = await this.context.service.getMessage(
        input.accountId,
        input.replyToMessageId,
      );
      body = buildQuotedReplyBody(body, original);
      const referencedContentIds = referencedInlineContentIds(body.html);
      const existingContentIds = new Set(
        attachments?.flatMap((attachment) =>
          attachment.contentId ? [normalizeContentId(attachment.contentId)] : [],
        ),
      );
      const quotedAttachments = await Promise.all(
        (original.attachments ?? [])
          .filter(
            (attachment) =>
              attachment.contentId &&
              referencedContentIds.has(normalizeContentId(attachment.contentId)) &&
              !existingContentIds.has(normalizeContentId(attachment.contentId)),
          )
          .map(async (attachment) => {
            const result = await this.context.service.getAttachment(
              input.accountId,
              original.id,
              attachment.id,
              this.context.config.maxAttachmentBytes,
            );
            return {
              filename: result.meta.filename,
              mimeType: result.meta.mimeType,
              content: result.content.toString("base64"),
              contentId: attachment.contentId,
              disposition: "inline" as const,
            } satisfies AttachmentInput;
          }),
      );
      if (quotedAttachments.length) attachments = [...(attachments ?? []), ...quotedAttachments];
    }
    return {
      ...(input.from ? { from: input.from } : {}),
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.bcc?.length ? { bcc: input.bcc } : {}),
      subject: input.subject,
      body,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.replyAll ? { replyAll: true } : {}),
      ...(attachments?.length ? { attachments } : {}),
    };
  }

  private async measure<T>(
    operation: MailOperation,
    work: () => Promise<{ value: T; cacheStatus?: "hit" | "miss" | "mixed" }>,
  ): Promise<T> {
    const started = performance.now();
    try {
      this.assertStoreCompatible();
      const result = await work();
      this.options.analytics.captureOperation({
        operation,
        outcome: "success",
        durationMs: performance.now() - started,
        cacheStatus: result.cacheStatus,
      });
      return result.value;
    } catch (error) {
      this.options.analytics.captureOperation({
        operation,
        outcome: "error",
        errorCode: isEmailError(error) ? error.code : "desktop_error",
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }

  private enqueueProviderMutation<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.providerMutationQueues.get(accountId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.providerMutationQueues.set(accountId, tail);
    void tail.then(() => {
      if (this.providerMutationQueues.get(accountId) === tail)
        this.providerMutationQueues.delete(accountId);
    });
    return result;
  }

  private assertStoreCompatible(): StoreCompatibility {
    const compatibility = this.fluxmail.inspectStoreCompatibility(
      this.context.config.dbPath,
      this.context.config.dataDir,
    );
    if (compatibility.compatible) return compatibility;
    this.context.scheduler.stop();
    this.context.licenseController.stop();
    throw new this.fluxmail.IncompatibleStoreError(compatibility);
  }
}

function licenseActivationError(
  outcome: "invalid_key" | "not_found" | "inactive" | "in_use" | "bad_lease",
): string {
  const messages = {
    invalid_key: "That license key is invalid. Check it for typos.",
    not_found: "That license key is invalid. Check it for typos.",
    inactive: "That license is no longer active.",
    in_use:
      "This license is active on another Fluxmail instance. Deactivate it there first, or manage instances from your Fluxmail account.",
    bad_lease: "Fluxmail could not verify the license response. Update Fluxmail and try again.",
  } as const;
  return messages[outcome];
}

function forwardBody(
  original: Message,
  text?: string,
  html?: string,
): NonNullable<Message["body"]> {
  const comment = text?.trim() ? text : undefined;
  const body = buildForwardBody(original, comment);
  if (!comment || !html) return body;
  const forwarded = buildForwardBody(original);
  body.html = `${html}${
    forwarded.html ?? `<div style="white-space:pre-wrap">${escapeHtml(forwarded.text ?? "")}</div>`
  }`;
  return body;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!,
  );
}

function toAccountInfo(
  account: ReturnType<AppContext["registry"]["getAccount"]>,
  canPermanentlyDelete: boolean,
): AccountInfo {
  return {
    id: account.id,
    email: account.email,
    ...(account.displayName ? { displayName: account.displayName } : {}),
    provider: account.provider,
    status: account.status,
    canPermanentlyDelete,
  };
}

function uniqueThreadTargets(
  targets: Array<{ accountId: string; threadId: string }>,
): Array<{ accountId: string; threadId: string }> {
  return [...new Map(targets.map((target) => [threadTargetKey(target), target])).values()];
}

function threadTargetKey(target: { accountId: string; threadId: string }): string {
  return `${target.accountId}\u0000${target.threadId}`;
}

function groupThreadTargetsByAccount(
  targets: Array<{ accountId: string; threadId: string }>,
): Array<[string, Array<{ accountId: string; threadId: string }>]> {
  const groups = new Map<string, Array<{ accountId: string; threadId: string }>>();
  for (const target of targets) {
    const group = groups.get(target.accountId) ?? [];
    group.push(target);
    groups.set(target.accountId, group);
  }
  return [...groups];
}

function groupSnapshotsByAccount(
  snapshots: Array<{ accountId: string; thread: Thread }>,
): Array<[string, Array<{ accountId: string; thread: Thread }>]> {
  const groups = new Map<string, Array<{ accountId: string; thread: Thread }>>();
  for (const snapshot of snapshots) {
    const group = groups.get(snapshot.accountId) ?? [];
    group.push(snapshot);
    groups.set(snapshot.accountId, group);
  }
  return [...groups];
}

function buildSnapshotRestoreOperations(
  currentThreads: Thread[],
  snapshots: Array<{ accountId: string; thread: Thread }>,
  provider: AccountInfo["provider"],
  originalAction: ModifyActionInput,
): Array<{ messageIds: string[]; action: ModifyAction }> {
  const operations = new Map<string, { messageIds: Set<string>; action: ModifyAction }>();
  const add = (messageId: string, action: ModifyAction) => {
    const key = JSON.stringify(action);
    const operation = operations.get(key) ?? { messageIds: new Set<string>(), action };
    operation.messageIds.add(messageId);
    operations.set(key, operation);
  };

  const snapshotsByThreadId = new Map(
    snapshots.map((snapshot) => [snapshot.thread.id, snapshot.thread]),
  );
  for (const currentThread of currentThreads) {
    const snapshot = snapshotsByThreadId.get(currentThread.id);
    if (!snapshot) continue;
    const originalByMessageId = new Map(snapshot.messages.map((message) => [message.id, message]));
    for (const current of currentThread.messages) {
      const original = originalByMessageId.get(current.id);
      if (!original) continue;
      if (
        (originalAction.type === "markRead" || originalAction.type === "markUnread") &&
        current.flags.read !== original.flags.read
      )
        add(current.id, original.flags.read ? "markRead" : "markUnread");
      if (
        (originalAction.type === "star" || originalAction.type === "unstar") &&
        current.flags.starred !== original.flags.starred
      )
        add(current.id, original.flags.starred ? "star" : "unstar");

      if (originalAction.type === "addLabels" || originalAction.type === "removeLabels") {
        const currentLabels = restorableLabels(current.labels, provider);
        const originalLabels = restorableLabels(original.labels, provider);
        const actionLabels = restorableLabels(originalAction.labels, provider);
        const labelsToAdd =
          originalAction.type === "removeLabels"
            ? [...actionLabels]
                .filter((label) => originalLabels.has(label) && !currentLabels.has(label))
                .sort()
            : [];
        const labelsToRemove =
          originalAction.type === "addLabels"
            ? [...actionLabels]
                .filter((label) => !originalLabels.has(label) && currentLabels.has(label))
                .sort()
            : [];
        if (labelsToAdd.length) add(current.id, { addLabels: labelsToAdd });
        if (labelsToRemove.length) add(current.id, { removeLabels: labelsToRemove });
      }

      if (
        ["archive", "trash", "untrash", "move"].includes(originalAction.type) &&
        folderKey(current.folder) !== folderKey(original.folder)
      ) {
        for (const action of restoreFolderActions(current.folder, original.folder, provider))
          add(current.id, action);
      }
    }
  }
  return [...operations.values()].map(({ messageIds, action }) => ({
    messageIds: [...messageIds],
    action,
  }));
}

const GMAIL_SYSTEM_LABELS = new Set([
  "chat",
  "draft",
  "drafts",
  "important",
  "inbox",
  "sent",
  "spam",
  "starred",
  "trash",
  "unread",
]);

function restorableLabels(
  labels: string[] | undefined,
  provider: AccountInfo["provider"],
): Set<string> {
  return new Set(
    (labels ?? []).filter(
      (label) => provider !== "gmail" || !GMAIL_SYSTEM_LABELS.has(label.toLowerCase()),
    ),
  );
}

function folderKey(folder: Message["folder"]): string {
  if (!folder) return "archive";
  return (folder.role ?? folder.id ?? folder.name).toLowerCase();
}

function restoreFolderActions(
  current: Message["folder"],
  original: Message["folder"],
  provider: AccountInfo["provider"],
): ModifyAction[] {
  const desired = folderKey(original);
  if (provider === "gmail" && desired === "sent") {
    return folderKey(current) === "trash" ? ["untrash", "archive"] : ["archive"];
  }
  if (folderKey(current) === "trash" && desired !== "trash") {
    if (desired === "inbox") return ["untrash"];
    return ["untrash", ...restoreFolderActions(undefined, original, provider)];
  }
  if (desired === "trash") return ["trash"];
  if (desired === "archive" || desired === "all") return ["archive"];
  return [{ move: original?.id ?? original?.role ?? original?.name ?? desired }];
}

function messageFlagsForAction(action: ModifyActionInput): Partial<Message["flags"]> | undefined {
  if (action.type === "markRead") return { read: true };
  if (action.type === "markUnread") return { read: false };
  if (action.type === "star") return { starred: true };
  if (action.type === "unstar") return { starred: false };
  return undefined;
}

function toModifyAction(action: ModifyActionInput): ModifyAction {
  if (action.type === "discardDraft")
    throw new Error("Drafts must use the draft discard operation.");
  if (action.type === "move") return { move: action.folder };
  if (action.type === "addLabels") return { addLabels: action.labels };
  if (action.type === "removeLabels") return { removeLabels: action.labels };
  return action.type;
}

function parseCursor(cursor: string | undefined): number {
  const value = Number(cursor ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function reconciledFolderRole(
  input: ThreadListInput,
): "inbox" | "sent" | "drafts" | "spam" | "trash" | undefined {
  if (input.query || input.label) return undefined;
  if (["inbox", "sent", "drafts", "spam", "trash"].includes(input.view))
    return input.view as "inbox" | "sent" | "drafts" | "spam" | "trash";
  return undefined;
}

function viewKey(input: ThreadListInput): string {
  return `${input.view}:${input.label ?? ""}:${input.query ?? ""}`;
}

function accountViewKey(accountId: string, currentViewKey: string): string {
  return JSON.stringify([accountId, currentViewKey]);
}

function backgroundRefreshKey(input: ThreadListInput): string {
  return JSON.stringify([viewKey(input), [...(input.accountIds ?? [])].sort()]);
}

function scheduledSendAt(
  timing: { sendAt: string } | { delaySeconds: Exclude<UndoSendDelaySeconds, 0> },
): string {
  return "delaySeconds" in timing
    ? new Date(Date.now() + timing.delaySeconds * 1_000).toISOString()
    : timing.sendAt;
}

export function shouldUseBundledGoogleConfig(
  existingClientId: string | undefined,
  existingClientSecret: string | undefined,
  bundledClientId: string,
  bundledClientSecret: string,
): boolean {
  return Boolean(
    bundledClientId && bundledClientSecret && (!existingClientId || !existingClientSecret),
  );
}

type FluxmailConfigurationModule = Pick<
  typeof import("fluxmail"),
  "IncompatibleStoreError" | "inspectStoreCompatibility" | "resolveStoreLocation"
>;

export function prepareFluxmailConfiguration(
  fluxmail: FluxmailConfigurationModule,
  bundledClientId: string,
  bundledClientSecret: string,
): boolean {
  const storeLocation = fluxmail.resolveStoreLocation();
  const compatibility = fluxmail.inspectStoreCompatibility(
    storeLocation.dbPath,
    storeLocation.dataDir,
  );
  if (!compatibility.compatible) throw new fluxmail.IncompatibleStoreError(compatibility);

  const existingClientId = process.env.GOOGLE_CLIENT_ID;
  const existingClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (
    !shouldUseBundledGoogleConfig(
      existingClientId,
      existingClientSecret,
      bundledClientId,
      bundledClientSecret,
    )
  )
    return false;

  if (existingClientId || existingClientSecret) {
    process.env.GOOGLE_CLIENT_ID = bundledClientId;
    process.env.GOOGLE_CLIENT_SECRET = bundledClientSecret;
    return false;
  }

  return true;
}
