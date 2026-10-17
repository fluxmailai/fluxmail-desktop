import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppError,
  AppEvent,
  BootstrapState,
  MailModifyResult,
  MailboxView,
  ModifyActionInput,
  ThreadPage,
  ThreadSummary,
} from "../shared/contracts";
import { Sidebar } from "./components/Sidebar";
import { ThreadListPane } from "./components/ThreadListPane";
import {
  ReadingPane,
  type InlineComposerMode,
  type ReadingPaneHandle,
} from "./components/ReadingPane";
import {
  ComposeDialog,
  type ComposeDialogHandle,
  type ComposeDelivery,
  type ComposeSeed,
} from "./components/ComposeDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Onboarding } from "./components/Onboarding";
import { FluxmailLogoMark } from "./components/FluxmailLogoMark";
import { mailboxDeleteAction, mailboxMoveAction } from "./mail-actions";
import type { MailtoFields } from "../shared/mailto";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TOAST_DURATION_MS = 5_000;

interface DeliveryNotice {
  id: string;
  message: string;
  delivery?: ComposeDelivery;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [view, setView] = useState<MailboxView>("inbox");
  const [label, setLabel] = useState<string>();
  const [accountId, setAccountId] = useState<string>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [selectedThread, setSelectedThread] = useState<ThreadSummary>();
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchText, setSearchText] = useState("");
  const deferredSearch = useDeferredValue(searchText);
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [composeSeed, setComposeSeed] = useState<ComposeSeed | null>(null);
  const [quickReplyDiscardVersion, setQuickReplyDiscardVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [deliveryNotices, setDeliveryNotices] = useState<DeliveryNotice[]>([]);
  const [actionNotice, setActionNotice] = useState<string>();
  const [startupError, setStartupError] = useState<AppError>();
  const [sidebarWidth, setSidebarWidth] = useState(228);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState(410);
  const searchRef = useRef<HTMLInputElement>(null);
  const composeDialogRef = useRef<ComposeDialogHandle>(null);
  const readingPaneRef = useRef<ReadingPaneHandle>(null);
  const refreshTimer = useRef<number | undefined>(undefined);
  const deliveryTimers = useRef(new Map<string, number>());
  const deliveryNoticeSequence = useRef(0);
  const errorTimer = useRef<number | undefined>(undefined);
  const actionTimer = useRef<number | undefined>(undefined);
  const listRequest = useRef(0);
  const quickReplyDirty = useRef(false);
  const latestUndo = useRef<{ token: string; targetKeys: Set<string> } | undefined>(undefined);
  const modifySequence = useRef(0);
  const loadedThreadCount = useRef(DEFAULT_PAGE_SIZE);
  const mailboxContext = JSON.stringify([accountId, label, submittedSearch, view]);
  const mailboxContextRef = useRef(mailboxContext);
  const selectedThreadRef = useRef<ThreadSummary | undefined>(undefined);
  const dismissError = useCallback(() => {
    window.clearTimeout(errorTimer.current);
    errorTimer.current = undefined;
    setError(undefined);
  }, []);
  const showError = useCallback((message: string) => {
    window.clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = window.setTimeout(() => {
      errorTimer.current = undefined;
      setError(undefined);
    }, DEFAULT_TOAST_DURATION_MS);
  }, []);
  const dismissActionNotice = useCallback(() => {
    window.clearTimeout(actionTimer.current);
    actionTimer.current = undefined;
    setActionNotice(undefined);
  }, []);
  const showActionNotice = useCallback((message: string) => {
    window.clearTimeout(actionTimer.current);
    setActionNotice(message);
    actionTimer.current = window.setTimeout(() => {
      actionTimer.current = undefined;
      setActionNotice(undefined);
    }, DEFAULT_TOAST_DURATION_MS);
  }, []);
  const clearDeliveryTimer = useCallback((id: string) => {
    const timer = deliveryTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    deliveryTimers.current.delete(id);
  }, []);
  const dismissDeliveryNotice = useCallback(
    (id: string) => {
      clearDeliveryTimer(id);
      setDeliveryNotices((current) => current.filter((notice) => notice.id !== id));
    },
    [clearDeliveryTimer],
  );
  const setDeliveryTimer = useCallback((id: string, callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      deliveryTimers.current.delete(id);
      callback();
    }, delay);
    deliveryTimers.current.set(id, timer);
  }, []);
  useLayoutEffect(() => {
    mailboxContextRef.current = mailboxContext;
  }, [mailboxContext]);
  const invalidateThreadLoads = useCallback(() => {
    listRequest.current += 1;
    setLoading(false);
    setLoadingMore(false);
  }, []);
  useLayoutEffect(() => {
    selectedThreadRef.current = selectedThread;
  }, [selectedThread]);

  const accountIds = useMemo(() => (accountId ? [accountId] : undefined), [accountId]);
  const permanentDeleteAccountIds = useMemo(
    () =>
      new Set(
        (bootstrap?.accounts ?? [])
          .filter((account) => account.canPermanentlyDelete)
          .map((account) => account.id),
      ),
    [bootstrap?.accounts],
  );
  const handleQuickReplyDirtyChange = useCallback((dirty: boolean) => {
    quickReplyDirty.current = dirty;
  }, []);
  const confirmQuickReplyNavigation = useCallback(() => {
    const hasUnsavedReply = quickReplyDirty.current;
    if (!canCloseQuickReply(hasUnsavedReply)) return false;
    if (hasUnsavedReply) setQuickReplyDiscardVersion((current) => current + 1);
    quickReplyDirty.current = false;
    return true;
  }, []);
  const closeReadingDraft = useCallback(() => readingPaneRef.current?.closeDraft() ?? true, []);
  const prepareReadingNavigation = useCallback((): boolean | Promise<boolean> => {
    const draftClosed = closeReadingDraft();
    if (typeof draftClosed === "boolean") return draftClosed && confirmQuickReplyNavigation();
    return draftClosed.then((closed) => closed && confirmQuickReplyNavigation());
  }, [closeReadingDraft, confirmQuickReplyNavigation]);
  const selectedCounts = accountId
    ? (bootstrap?.countsByAccount[accountId] ?? {
        unreadCount: 0,
        draftCount: 0,
        scheduledCount: 0,
      })
    : {
        unreadCount: bootstrap?.unreadCount ?? 0,
        draftCount: bootstrap?.draftCount ?? 0,
        scheduledCount: bootstrap?.scheduledCount ?? 0,
      };
  const availableLabels = useMemo(
    () => [
      ...new Set(
        (bootstrap?.folders ?? [])
          .filter((folder) => !folder.role && (!accountId || folder.accountId === accountId))
          .map((folder) => folder.name),
      ),
    ],
    [accountId, bootstrap?.folders],
  );
  const availableSearchAccounts = useMemo(
    () => (bootstrap?.accounts ?? []).filter((account) => !accountId || account.id === accountId),
    [accountId, bootstrap?.accounts],
  );

  const loadBootstrap = useCallback(async () => {
    try {
      const state = await window.fluxmail.bootstrap();
      setBootstrap(state);
      setAccountId((current) => reconcileAccountSelection(current, state.accounts));
    } catch (caught) {
      setStartupError(errorDetails(caught));
    }
  }, []);

  const refreshMail = useCallback(async () => {
    try {
      await window.fluxmail.sync.refresh({
        view: submittedSearch ? "search" : view,
        accountIds,
        label,
        query: submittedSearch || undefined,
        pageSize: DEFAULT_PAGE_SIZE,
      });
    } catch (caught) {
      showError(errorMessage(caught));
    }
  }, [accountIds, label, showError, submittedSearch, view]);

  const loadThreads = useCallback(
    async (options?: {
      append?: boolean;
      forceSearch?: boolean;
      quiet?: boolean;
      refresh?: boolean;
      backgroundRefresh?: boolean;
      preservePages?: boolean;
      preserveSelection?: boolean;
    }) => {
      if (mailboxContext !== mailboxContextRef.current) return;
      const append = options?.append ?? false;
      const quiet = options?.quiet ?? false;
      const request = ++listRequest.current;
      if (append) setLoadingMore(true);
      else if (!quiet) setLoading(true);
      try {
        const input = {
          view: submittedSearch ? ("search" as const) : view,
          accountIds,
          label,
          query: submittedSearch || undefined,
          refresh: options?.refresh,
          backgroundRefresh: options?.backgroundRefresh,
          cursor: append ? cursor : undefined,
          pageSize: DEFAULT_PAGE_SIZE,
        };
        const sortOrder =
          !submittedSearch && view === "scheduled"
            ? ("ascending" as const)
            : ("descending" as const);
        let page = options?.forceSearch
          ? await window.fluxmail.mail.search(input)
          : await window.fluxmail.mail.listThreads(input);
        if (!append && options?.preservePages) {
          page = await loadThreadPages(
            page,
            loadedThreadCount.current,
            async (nextCursor) =>
              window.fluxmail.mail.listThreads({
                ...input,
                refresh: undefined,
                cursor: nextCursor,
              }),
            sortOrder,
          );
        }
        if (request !== listRequest.current || mailboxContext !== mailboxContextRef.current) return;
        startTransition(() => {
          setThreads((current) => {
            if (request !== listRequest.current || mailboxContext !== mailboxContextRef.current)
              return current;
            const next = append ? mergeThreads(current, page.items, sortOrder) : page.items;
            loadedThreadCount.current = Math.max(DEFAULT_PAGE_SIZE, next.length);
            return next;
          });
          if (!append)
            setSelectedThread((current) =>
              request !== listRequest.current ||
              mailboxContext !== mailboxContextRef.current ||
              !current
                ? current
                : (page.items.find((thread) => threadKey(thread) === threadKey(current)) ??
                  (options?.preserveSelection ? current : undefined)),
            );
          setCursor((current) =>
            request === listRequest.current && mailboxContext === mailboxContextRef.current
              ? page.nextCursor
              : current,
          );
        });
      } catch (caught) {
        if (request !== listRequest.current || mailboxContext !== mailboxContextRef.current) return;
        showError(errorMessage(caught));
      } finally {
        if (request === listRequest.current && mailboxContext === mailboxContextRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [accountIds, cursor, label, mailboxContext, showError, submittedSearch, view],
  );

  const showDelivery = useCallback(
    (delivery: ComposeDelivery) => {
      const id =
        delivery.kind === "sent"
          ? `sent-${(deliveryNoticeSequence.current += 1)}`
          : delivery.scheduleId;
      clearDeliveryTimer(id);
      if (delivery.kind === "sent") {
        setDeliveryNotices((current) => [...current, { id, message: "Message sent." }]);
        setDeliveryTimer(
          id,
          () => setDeliveryNotices((current) => current.filter((notice) => notice.id !== id)),
          DEFAULT_TOAST_DURATION_MS,
        );
        return;
      }
      const sendDate = new Date(delivery.sendAt);
      if (delivery.kind === "scheduled") void loadBootstrap();
      const notice = {
        id,
        delivery,
        message:
          delivery.kind === "undo"
            ? "Message sent."
            : `Message scheduled for ${sendDate.toLocaleString([], {
                dateStyle: "medium",
                timeStyle: "short",
              })}.`,
      };
      setDeliveryNotices((current) => [
        ...current.filter((candidate) => candidate.id !== id),
        notice,
      ]);
      const visibleFor =
        delivery.kind === "undo"
          ? Math.max(0, sendDate.getTime() - Date.now())
          : DEFAULT_TOAST_DURATION_MS;
      setDeliveryTimer(
        id,
        () => {
          setDeliveryNotices((current) => current.filter((candidate) => candidate.id !== id));
          if (delivery.kind === "undo") void refreshMail().then(() => loadThreads({ quiet: true }));
        },
        visibleFor,
      );
    },
    [clearDeliveryTimer, loadBootstrap, loadThreads, refreshMail, setDeliveryTimer],
  );

  const cancelDelivery = useCallback(
    async (notice: DeliveryNotice) => {
      const delivery = notice.delivery;
      if (!delivery || delivery.kind === "sent") return;
      try {
        await window.fluxmail.drafts.cancelScheduled({ scheduleId: delivery.scheduleId });
        clearDeliveryTimer(notice.id);
        setDeliveryNotices((current) =>
          current.map((candidate) =>
            candidate.id === notice.id
              ? {
                  id: notice.id,
                  message: "Sending canceled. The message is in Drafts.",
                }
              : candidate,
          ),
        );
        setDeliveryTimer(
          notice.id,
          () =>
            setDeliveryNotices((current) =>
              current.filter((candidate) => candidate.id !== notice.id),
            ),
          DEFAULT_TOAST_DURATION_MS,
        );
        void loadBootstrap();
        void loadThreads({ quiet: true });
      } catch (caught) {
        dismissDeliveryNotice(notice.id);
        showError(errorMessage(caught));
      }
    },
    [
      clearDeliveryTimer,
      dismissDeliveryNotice,
      loadBootstrap,
      loadThreads,
      setDeliveryTimer,
      showError,
    ],
  );

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    const appearance = bootstrap?.preferences.appearance;
    if (!appearance) return;
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved =
        appearance === "system" ? (systemTheme.matches ? "dark" : "light") : appearance;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    applyTheme();
    if (appearance !== "system") return;
    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [bootstrap?.preferences.appearance]);

  useEffect(() => {
    if (!bootstrap?.accounts.length) return;
    setThreads([]);
    loadedThreadCount.current = DEFAULT_PAGE_SIZE;
    setCursor(undefined);
    setSelection(new Set());
    setSelectedThread(undefined);
    void loadThreads({
      forceSearch: Boolean(submittedSearch),
      backgroundRefresh: !submittedSearch && view !== "inbox",
    });
  }, [accountId, bootstrap?.accounts.length, label, submittedSearch, view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsubscribe = window.fluxmail.onEvent((event: AppEvent) => {
      if (event.type === "sync-status")
        setBootstrap((current) => (current ? { ...current, sync: event.state } : current));
      if (event.type === "accounts-changed" || event.type === "license-changed")
        void loadBootstrap();
      if (
        event.type === "find-in-conversation-requested" &&
        selectedThread &&
        !composeSeed &&
        !settingsOpen
      )
        readingPaneRef.current?.openFind();
      if (event.type === "window-close-requested") {
        void (async () => {
          const composeDialog = composeDialogRef.current;
          const draftClosed = composeDialog ? true : await closeReadingDraft();
          const closed = composeDialog ? await composeDialog.close() : draftClosed;
          if (closed && canCloseQuickReply(quickReplyDirty.current))
            void window.fluxmail.system.confirmWindowClose();
          else void window.fluxmail.system.cancelWindowClose();
        })();
      }
      if (event.type === "cache-changed") {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          void loadBootstrap();
          void loadThreads({ quiet: true, preservePages: true, preserveSelection: true });
        }, 120);
      }
    });
    return () => {
      window.clearTimeout(refreshTimer.current);
      unsubscribe();
    };
  }, [closeReadingDraft, composeSeed, loadBootstrap, loadThreads, selectedThread, settingsOpen]);

  useEffect(
    () => () => {
      for (const timer of deliveryTimers.current.values()) window.clearTimeout(timer);
      deliveryTimers.current.clear();
      window.clearTimeout(errorTimer.current);
      window.clearTimeout(actionTimer.current);
    },
    [],
  );

  const openCompose = useCallback(async () => {
    const account = accountId
      ? bootstrap?.accounts.find((candidate) => candidate.id === accountId)
      : bootstrap?.accounts[0];
    if (!account) return;
    const canNavigate = prepareReadingNavigation();
    if (canNavigate === false || (canNavigate !== true && !(await canNavigate))) return;
    setComposeSeed({ accountId: account.id });
    void window.fluxmail.analytics
      .trackFeature({ feature: "compose", action: "opened", source: "sidebar" })
      .catch(() => undefined);
  }, [accountId, bootstrap?.accounts, prepareReadingNavigation]);

  const openMailto = useCallback(
    async ({ body, ...fields }: MailtoFields) => {
      const preferredAccountId = selectedThread?.accountId ?? accountId;
      const account =
        bootstrap?.accounts.find((candidate) => candidate.id === preferredAccountId) ??
        bootstrap?.accounts[0];
      if (!account) return;
      const canNavigate = prepareReadingNavigation();
      if (canNavigate === false || (canNavigate !== true && !(await canNavigate))) return;
      setComposeSeed({ accountId: account.id, ...fields, initialText: body || undefined });
      void window.fluxmail.analytics
        .trackFeature({ feature: "compose", action: "opened", source: "thread_detail" })
        .catch(() => undefined);
    },
    [accountId, bootstrap?.accounts, prepareReadingNavigation, selectedThread?.accountId],
  );

  const changeAccount = useCallback(
    async (nextAccountId?: string) => {
      if (nextAccountId === accountId) return;
      const canNavigate = prepareReadingNavigation();
      if (canNavigate === false || (canNavigate !== true && !(await canNavigate))) return;
      setAccountId(nextAccountId);
    },
    [accountId, prepareReadingNavigation],
  );

  const changeView = useCallback(
    async (nextView: MailboxView, nextLabel?: string) => {
      if (nextView === view && nextLabel === label && !submittedSearch) return;
      const canNavigate = prepareReadingNavigation();
      if (canNavigate === false || (canNavigate !== true && !(await canNavigate))) return;
      setView(nextView);
      setLabel(nextLabel);
      setSubmittedSearch("");
      setSearchText("");
      void window.fluxmail.analytics
        .trackFeature({
          feature: "navigation",
          action: "viewed",
          source: "sidebar",
        })
        .catch(() => undefined);
    },
    [label, prepareReadingNavigation, submittedSearch, view],
  );

  const submitSearch = useCallback(async () => {
    const query = searchText.trim();
    if (query === submittedSearch) return;
    const canNavigate = prepareReadingNavigation();
    if (canNavigate === false || (canNavigate !== true && !(await canNavigate))) return;
    if (!query) {
      setSubmittedSearch("");
      return;
    }
    setSubmittedSearch(query);
    void window.fluxmail.analytics
      .trackFeature({
        feature: "search",
        action: "submitted",
        source: "toolbar",
      })
      .catch(() => undefined);
  }, [prepareReadingNavigation, searchText, submittedSearch]);

  const undoLatest = useCallback(async () => {
    const entry = latestUndo.current;
    if (!entry) return;
    latestUndo.current = undefined;
    dismissActionNotice();
    try {
      const result = await window.fluxmail.mail.undo({ token: entry.token });
      if (!result.undone) return;
      showActionNotice("Action undone");
      await Promise.all([
        loadBootstrap(),
        loadThreads({
          quiet: true,
          forceSearch: shouldForceProviderSearchAfterMutation(submittedSearch),
          preservePages: true,
          preserveSelection: true,
        }),
      ]);
    } catch (caught) {
      showError(errorMessage(caught));
    }
  }, [
    dismissActionNotice,
    loadBootstrap,
    loadThreads,
    showActionNotice,
    showError,
    submittedSearch,
  ]);

  const markThreadRead = useCallback(
    async (thread: ThreadSummary) => {
      invalidateThreadLoads();
      setThreads((current) =>
        current.map((candidate) =>
          threadKey(candidate) === threadKey(thread) ? { ...candidate, unread: false } : candidate,
        ),
      );
      setSelectedThread((current) =>
        current && threadKey(current) === threadKey(thread)
          ? { ...current, unread: false }
          : current,
      );
      if (thread.folderRoles.includes("inbox")) {
        setBootstrap((current) =>
          current ? adjustUnreadCount(current, thread.accountId, -1) : current,
        );
      }
      if (latestUndo.current?.targetKeys.has(threadKey(thread))) {
        latestUndo.current = undefined;
        dismissActionNotice();
      }
      try {
        await window.fluxmail.mail.modify({
          targets: [{ accountId: thread.accountId, threadId: thread.id }],
          action: { type: "markRead" },
          undoable: false,
        });
      } catch (caught) {
        setThreads((current) =>
          current.map((candidate) =>
            threadKey(candidate) === threadKey(thread) ? { ...candidate, unread: true } : candidate,
          ),
        );
        setSelectedThread((current) =>
          current && threadKey(current) === threadKey(thread)
            ? { ...current, unread: true }
            : current,
        );
        if (thread.folderRoles.includes("inbox")) {
          setBootstrap((current) =>
            current ? adjustUnreadCount(current, thread.accountId, 1) : current,
          );
        }
        showError(errorMessage(caught));
      }
    },
    [dismissActionNotice, invalidateThreadLoads, showError],
  );

  const activateThread = useCallback(
    (thread: ThreadSummary) => {
      selectedThreadRef.current = thread;
      setSelectedThread(thread);
      if (!thread.unread) return;
      void markThreadRead(thread);
    },
    [markThreadRead],
  );

  const modify = useCallback(
    async (action: ModifyActionInput, explicit?: ThreadSummary[]) => {
      const targets = explicit ?? threads.filter((thread) => selection.has(threadKey(thread)));
      if (!targets.length) return;
      if (action.type === "delete") {
        if (!window.confirm(permanentDeletePrompt(targets.length))) return;
      }
      const targetKeys = new Set(targets.map(threadKey));
      const optimisticRemoval = shouldOptimisticallyRemoveFromView(
        submittedSearch ? "search" : view,
        action,
      );
      const previousThreads = threads;
      const previousSelection = selection;
      const previousSelectedThread = selectedThread;
      const shouldAdvanceAfterArchive = Boolean(
        bootstrap?.preferences.openNextAfterArchive &&
        action.type === "archive" &&
        optimisticRemoval &&
        targets.length === 1 &&
        selectedThread &&
        targetKeys.has(threadKey(selectedThread)),
      );
      const nextThread = shouldAdvanceAfterArchive
        ? nextThreadAfterArchive(threads, selectedThread!)
        : undefined;
      if (
        selectedThread &&
        targetKeys.has(threadKey(selectedThread)) &&
        shouldClearSelectedThread(submittedSearch ? "search" : view, action)
      ) {
        const canNavigate = prepareReadingNavigation();
        if (canNavigate === false || (canNavigate !== true && !(await canNavigate))) return;
      }
      const canUndo = action.type !== "delete" && action.type !== "discardDraft";
      const supersedesCurrentUndo = latestUndo.current
        ? [...targetKeys].some((key) => latestUndo.current?.targetKeys.has(key))
        : false;
      const request = canUndo ? ++modifySequence.current : modifySequence.current;
      if (canUndo || supersedesCurrentUndo) {
        latestUndo.current = undefined;
        dismissActionNotice();
      }
      const preserveQuickReply = Boolean(
        quickReplyDirty.current && selectedThread && targetKeys.has(threadKey(selectedThread)),
      );

      if (optimisticRemoval) {
        invalidateThreadLoads();
        setThreads((current) => current.filter((thread) => !targetKeys.has(threadKey(thread))));
        setSelection((current) => {
          const next = new Set(current);
          for (const key of targetKeys) next.delete(key);
          return next;
        });
        if (shouldAdvanceAfterArchive) {
          selectedThreadRef.current = nextThread;
          setSelectedThread(nextThread);
        } else {
          setSelectedThread((current) =>
            current && targetKeys.has(threadKey(current)) ? undefined : current,
          );
        }
      }
      try {
        const result: MailModifyResult =
          !submittedSearch && view === "scheduled" && action.type === "discardDraft"
            ? await Promise.all(
                targets.map((thread) =>
                  window.fluxmail.drafts.delete({
                    accountId: thread.accountId,
                    draftId: thread.draftId!,
                  }),
                ),
              ).then(() => ({}))
            : await window.fluxmail.mail.modify({
                targets: targets.map((thread) => ({
                  accountId: thread.accountId,
                  threadId: thread.id,
                })),
                action,
              });
        if (result.undoToken && request === modifySequence.current) {
          latestUndo.current = { token: result.undoToken, targetKeys };
          showActionNotice(actionSuccessMessage(action, targets.length));
        }
        if (!optimisticRemoval && mailboxContext === mailboxContextRef.current)
          setSelection(new Set());
        setSelectedThread((current) => {
          if (!current || !targetKeys.has(threadKey(current))) return current;
          if (action.type === "markRead" || action.type === "markUnread")
            return { ...current, unread: action.type === "markUnread" };
          if (action.type === "star" || action.type === "unstar")
            return { ...current, starred: action.type === "star" };
          if (mailboxContext !== mailboxContextRef.current) return current;
          if (shouldClearSelectedThread(submittedSearch ? "search" : view, action))
            return undefined;
          return current;
        });
        const currentSelectedThread = selectedThreadRef.current;
        if (
          nextThread?.unread &&
          currentSelectedThread?.unread &&
          threadKey(currentSelectedThread) === threadKey(nextThread) &&
          mailboxContext === mailboxContextRef.current
        ) {
          await markThreadRead(nextThread);
        }
        await loadThreads({
          quiet: optimisticRemoval,
          forceSearch: shouldForceProviderSearchAfterMutation(submittedSearch),
          preservePages: preserveQuickReply,
          preserveSelection: preserveQuickReply,
        });
      } catch (caught) {
        if (optimisticRemoval && mailboxContext === mailboxContextRef.current) {
          setThreads(previousThreads);
          setSelection(previousSelection);
          setSelectedThread((current) => {
            if (!previousSelectedThread) return current;
            if (!current) return previousSelectedThread;
            if (nextThread && threadKey(current) === threadKey(nextThread))
              return previousSelectedThread;
            return current;
          });
        }
        showError(errorMessage(caught));
      }
    },
    [
      bootstrap?.preferences.openNextAfterArchive,
      dismissActionNotice,
      invalidateThreadLoads,
      loadThreads,
      mailboxContext,
      markThreadRead,
      prepareReadingNavigation,
      selectedThread,
      selection,
      showActionNotice,
      showError,
      submittedSearch,
      threads,
      view,
    ],
  );

  const openThread = useCallback(
    async (thread: ThreadSummary) => {
      const changesThread = !selectedThread || threadKey(selectedThread) !== threadKey(thread);
      if (!changesThread) return;
      const canNavigate = prepareReadingNavigation();
      if (canNavigate === false || (canNavigate !== true && !(await canNavigate))) return;
      if (thread.scheduleId && !thread.pendingSend) {
        try {
          await window.fluxmail.drafts.cancelScheduled({ scheduleId: thread.scheduleId });
        } catch (caught) {
          showError(errorMessage(caught));
          return;
        }
      }
      activateThread(thread);
    },
    [activateThread, prepareReadingNavigation, selectedThread, showError],
  );

  const handleDraftMissing = useCallback((missingThread: ThreadSummary) => {
    setThreads((current) =>
      current.map((candidate) =>
        threadKey(candidate) === threadKey(missingThread)
          ? { ...candidate, draft: false }
          : candidate,
      ),
    );
    setSelectedThread((current) =>
      current && threadKey(current) === threadKey(missingThread)
        ? { ...current, draft: false }
        : current,
    );
  }, []);

  const handleDraftFinished = useCallback(() => {
    void loadThreads({ quiet: true, preservePages: true });
  }, [loadThreads]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (composeSeed || settingsOpen) return;
      const target = event.target;
      const editing =
        target instanceof Element &&
        Boolean(target.closest('input, textarea, [contenteditable="true"]'));
      if (event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.metaKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void refreshMail();
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f" &&
        selectedThread
      ) {
        event.preventDefault();
        readingPaneRef.current?.openFind();
        return;
      }
      if (editing) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undoLatest();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "[") {
        event.preventDefault();
        setSidebarCollapsed((current) => !current);
        return;
      }
      const selectedThreads = threads.filter((thread) => selection.has(threadKey(thread)));
      const actionTargets = selectedThreads.length
        ? selectedThreads
        : selectedThread
          ? [selectedThread]
          : undefined;
      if (event.key.toLowerCase() === "c") void openCompose();
      const activeView = submittedSearch ? "search" : view;
      if (event.key.toLowerCase() === "e" && activeView !== "scheduled")
        void modify(mailboxMoveAction(activeView), actionTargets);
      const deleteAction = mailboxDeleteAction(
        activeView,
        Boolean(
          actionTargets?.length &&
          actionTargets.every((thread) => permanentDeleteAccountIds.has(thread.accountId)),
        ),
      );
      if (event.key === "#" && deleteAction) void modify(deleteAction, actionTargets);
      if (event.key.toLowerCase() === "s" && selectedThread)
        void modify({ type: selectedThread.starred ? "unstar" : "star" }, [selectedThread]);
      const composerShortcut: Partial<Record<string, InlineComposerMode>> = {
        r: "reply",
        a: "replyAll",
        f: "forward",
      };
      const composerMode = composerShortcut[event.key.toLowerCase()];
      if (composerMode && selectedThread) {
        event.preventDefault();
        readingPaneRef.current?.openComposer(composerMode);
      }
      if (!event.shiftKey && event.key.toLowerCase() === "u" && actionTargets?.length)
        void modify(
          {
            type: actionTargets.some((thread) => thread.unread) ? "markRead" : "markUnread",
          },
          actionTargets,
        );
      if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
        event.preventDefault();
        const currentIndex = selectedThread
          ? threads.findIndex((thread) => threadKey(thread) === threadKey(selectedThread))
          : -1;
        const offset = event.key.toLowerCase() === "j" ? 1 : -1;
        const nextIndex = Math.min(threads.length - 1, Math.max(0, currentIndex + offset));
        if (threads[nextIndex]) void openThread(threads[nextIndex]);
      }
      if (event.key === "/" && !event.metaKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    composeSeed,
    modify,
    openCompose,
    openThread,
    permanentDeleteAccountIds,
    refreshMail,
    selectedThread,
    selection,
    settingsOpen,
    submittedSearch,
    threads,
    undoLatest,
    view,
  ]);

  if (!bootstrap) return <Splash error={startupError} />;
  if (!bootstrap.accounts.length) {
    return (
      <Onboarding
        onConnected={async () => {
          await loadBootstrap();
          await loadThreads();
        }}
      />
    );
  }
  const imageRelayAvailable = bootstrap.license.canUsePrivateImageRelay;

  return (
    <div
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      style={
        {
          "--sidebar-width": `${sidebarCollapsed ? 0 : sidebarWidth}px`,
          "--sidebar-divider-width": sidebarCollapsed ? "0px" : "1px",
          "--list-width": `${listWidth}px`,
        } as React.CSSProperties
      }
    >
      <Sidebar
        accounts={bootstrap.accounts}
        folders={bootstrap.folders}
        accountId={accountId}
        activeView={submittedSearch ? "search" : view}
        activeLabel={label}
        unreadCount={selectedCounts.unreadCount}
        draftCount={selectedCounts.draftCount}
        scheduledCount={selectedCounts.scheduledCount}
        collapsed={sidebarCollapsed}
        onAccountChange={changeAccount}
        onViewChange={changeView}
        onCompose={openCompose}
        onSettings={() => setSettingsOpen(true)}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
      />
      {sidebarCollapsed ? (
        <div className="pane-divider" />
      ) : (
        <PaneResizer
          label="Resize sidebar"
          value={sidebarWidth}
          min={188}
          max={320}
          onChange={setSidebarWidth}
        />
      )}
      <ThreadListPane
        view={submittedSearch ? "search" : view}
        title={submittedSearch ? `Search: ${submittedSearch}` : viewTitle(view, label)}
        threads={threads}
        selected={selectedThread}
        selection={selection}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={Boolean(cursor)}
        searchText={searchText}
        deferredSearch={deferredSearch}
        searchRef={searchRef}
        sync={bootstrap.sync}
        labels={availableLabels}
        accounts={availableSearchAccounts}
        permanentDeleteAccountIds={permanentDeleteAccountIds}
        sidebarCollapsed={sidebarCollapsed}
        onSearchText={setSearchText}
        onSearch={submitSearch}
        onSelect={openThread}
        onToggleSelection={(thread) =>
          setSelection((current) => {
            const next = new Set(current);
            const key = threadKey(thread);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
        onToggleSelectAll={() =>
          setSelection((current) => {
            const visibleKeys = threads.map(threadKey);
            const allSelected =
              visibleKeys.length > 0 && visibleKeys.every((key) => current.has(key));
            const next = new Set(current);
            for (const key of visibleKeys) {
              if (allSelected) next.delete(key);
              else next.add(key);
            }
            return next;
          })
        }
        onModify={modify}
        onLoadMore={() => void loadThreads({ append: true })}
        onRefresh={() => void refreshMail()}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        onCompose={openCompose}
      />
      <PaneResizer
        label="Resize message list"
        value={listWidth}
        min={330}
        max={560}
        onChange={setListWidth}
      />
      <ReadingPane
        ref={readingPaneRef}
        view={submittedSearch ? "search" : view}
        thread={selectedThread}
        labels={availableLabels}
        allowPermanentDelete={Boolean(
          selectedThread && permanentDeleteAccountIds.has(selectedThread.accountId),
        )}
        blockRemoteImages={bootstrap.preferences.blockRemoteImages}
        imageRelay={bootstrap.preferences.imageRelay}
        imageRelayAvailable={imageRelayAvailable}
        onModify={(action) =>
          selectedThread ? modify(action, [selectedThread]) : Promise.resolve()
        }
        onError={showError}
        onMailto={openMailto}
        onQuickReplyDirtyChange={handleQuickReplyDirtyChange}
        onDelivery={showDelivery}
        undoSendDelaySeconds={bootstrap.preferences.undoSendDelaySeconds}
        quickReplyDiscardVersion={quickReplyDiscardVersion}
        onDraftMissing={handleDraftMissing}
        onDraftFinished={handleDraftFinished}
      />
      {composeSeed ? (
        <ComposeDialog
          ref={composeDialogRef}
          seed={composeSeed}
          accounts={bootstrap.accounts}
          blockRemoteImages={bootstrap.preferences.blockRemoteImages}
          imageRelay={bootstrap.preferences.imageRelay}
          imageRelayAvailable={imageRelayAvailable}
          undoSendDelaySeconds={bootstrap.preferences.undoSendDelaySeconds}
          onClose={() => setComposeSeed(null)}
          onSent={(delivery) => {
            setComposeSeed(null);
            showDelivery(delivery);
            void loadThreads();
          }}
          onError={showError}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          state={bootstrap}
          onClose={() => setSettingsOpen(false)}
          onState={setBootstrap}
          onError={showError}
        />
      ) : null}
      {deliveryNotices.length || error || actionNotice ? (
        <div className="toast-stack">
          {error ? (
            <div className="toast" role="alert">
              <span>{error}</span>
              <button onClick={dismissError} aria-label="Dismiss message">
                ×
              </button>
            </div>
          ) : null}
          {deliveryNotices.map((notice) => (
            <div className="toast" role="status" key={notice.id}>
              <span>{notice.message}</span>
              {notice.delivery && notice.delivery.kind !== "sent" ? (
                <button className="toast-action" onClick={() => void cancelDelivery(notice)}>
                  {notice.delivery.kind === "undo" ? "Undo" : "Cancel"}
                </button>
              ) : null}
              <button onClick={() => dismissDeliveryNotice(notice.id)} aria-label="Dismiss message">
                ×
              </button>
            </div>
          ))}
          {actionNotice ? (
            <div className="toast" role="status">
              <span>{actionNotice}</span>
              {latestUndo.current ? (
                <button className="toast-action" onClick={() => void undoLatest()}>
                  Undo
                </button>
              ) : null}
              <button onClick={dismissActionNotice} aria-label="Dismiss message">
                ×
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PaneResizer({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
}) {
  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onChange(Math.max(min, value - 8));
        if (event.key === "ArrowRight") onChange(Math.min(max, value + 8));
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = value;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (pointer: PointerEvent) =>
          onChange(Math.min(max, Math.max(min, startWidth + pointer.clientX - startX)));
        const stop = (pointer: PointerEvent) => {
          if (target.hasPointerCapture(pointer.pointerId))
            target.releasePointerCapture(pointer.pointerId);
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", stop);
          target.removeEventListener("pointercancel", stop);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", stop);
        target.addEventListener("pointercancel", stop);
      }}
    />
  );
}

type ThreadSortOrder = "ascending" | "descending";

export function mergeThreads(
  current: ThreadSummary[],
  incoming: ThreadSummary[],
  sortOrder: ThreadSortOrder = "descending",
): ThreadSummary[] {
  const map = new Map(current.map((thread) => [threadKey(thread), thread]));
  for (const thread of incoming) map.set(threadKey(thread), thread);
  const direction = sortOrder === "ascending" ? 1 : -1;
  return [...map.values()].sort(
    (left, right) => direction * (Date.parse(left.date) - Date.parse(right.date)),
  );
}

export async function loadThreadPages(
  firstPage: ThreadPage,
  minimumItems: number,
  loadNext: (cursor: string) => Promise<ThreadPage>,
  sortOrder: ThreadSortOrder = "descending",
): Promise<ThreadPage> {
  let items = firstPage.items;
  let nextCursor = firstPage.nextCursor;
  let totalCount = firstPage.totalCount;
  while (nextCursor && items.length < minimumItems) {
    const page = await loadNext(nextCursor);
    items = mergeThreads(items, page.items, sortOrder);
    nextCursor = page.nextCursor;
    totalCount = page.totalCount;
  }
  return {
    items,
    totalCount,
    syncing: false,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function threadKey(
  thread: Pick<ThreadSummary, "accountId" | "id" | "scheduleId" | "pendingSend">,
): string {
  return `${thread.accountId}:${thread.pendingSend ? thread.id : (thread.scheduleId ?? thread.id)}`;
}

export function reconcileAccountSelection(
  accountId: string | undefined,
  accounts: Array<{ id: string }>,
): string | undefined {
  return accountId && accounts.some((account) => account.id === accountId) ? accountId : undefined;
}

export function adjustUnreadCount(
  state: BootstrapState,
  accountId: string,
  delta: number,
): BootstrapState {
  const accountCounts = state.countsByAccount[accountId];
  return {
    ...state,
    unreadCount: Math.max(0, state.unreadCount + delta),
    countsByAccount: accountCounts
      ? {
          ...state.countsByAccount,
          [accountId]: {
            ...accountCounts,
            unreadCount: Math.max(0, accountCounts.unreadCount + delta),
          },
        }
      : state.countsByAccount,
  };
}

export function shouldOptimisticallyRemoveFromView(
  view: MailboxView,
  action: ModifyActionInput,
): boolean {
  return (
    (view === "inbox" && action.type === "archive") ||
    (view === "drafts" && action.type === "discardDraft") ||
    (view === "scheduled" && action.type === "discardDraft") ||
    (view === "trash" && ["untrash", "delete"].includes(action.type))
  );
}

export function nextThreadAfterArchive(
  threads: ThreadSummary[],
  current: ThreadSummary,
): ThreadSummary | undefined {
  const currentIndex = threads.findIndex((thread) => threadKey(thread) === threadKey(current));
  if (currentIndex < 0) return undefined;
  return threads[currentIndex + 1] ?? threads[currentIndex - 1];
}

export function shouldClearSelectedThread(view: MailboxView, action: ModifyActionInput): boolean {
  return (
    shouldOptimisticallyRemoveFromView(view, action) || ["trash", "delete"].includes(action.type)
  );
}

export function actionSuccessMessage(action: ModifyActionInput, count: number): string {
  const conversation = count === 1 ? "Conversation" : `${count} conversations`;
  if (action.type === "markRead")
    return count === 1 ? "Marked as read" : `${conversation} marked as read`;
  if (action.type === "markUnread")
    return count === 1 ? "Marked as unread" : `${conversation} marked as unread`;
  if (action.type === "star") return count === 1 ? "Starred" : `${conversation} starred`;
  if (action.type === "unstar") return count === 1 ? "Unstarred" : `${conversation} unstarred`;
  if (action.type === "archive") return count === 1 ? "Archived" : `${conversation} archived`;
  if (action.type === "trash")
    return count === 1 ? "Moved to Trash" : `${conversation} moved to Trash`;
  if (action.type === "untrash")
    return count === 1 ? "Moved to Inbox" : `${conversation} moved to Inbox`;
  if (action.type === "move") return count === 1 ? "Conversation moved" : `${conversation} moved`;
  if (action.type === "addLabels" || action.type === "removeLabels")
    return count === 1 ? "Labels updated" : `Labels updated for ${conversation.toLowerCase()}`;
  return count === 1 ? "Conversation updated" : `${conversation} updated`;
}

export function shouldForceProviderSearchAfterMutation(query: string): boolean {
  return Boolean(query.trim());
}

export function permanentDeletePrompt(count: number): string {
  return count === 1
    ? "Delete this conversation permanently? This cannot be undone."
    : `Delete ${count} conversations permanently? This cannot be undone.`;
}

export function canCloseQuickReply(
  hasUnsavedReply: boolean,
  confirmDiscard: () => boolean = () => window.confirm("Discard this unsent message?"),
): boolean {
  return !hasUnsavedReply || confirmDiscard();
}

function viewTitle(view: MailboxView, label?: string): string {
  if (view === "label") return label || "Label";
  const titles: Record<MailboxView, string> = {
    inbox: "Inbox",
    starred: "Starred",
    sent: "Sent",
    drafts: "Drafts",
    scheduled: "Scheduled",
    all: "All mail",
    spam: "Spam",
    trash: "Trash",
    label: "Label",
    search: "Search",
  };
  return titles[view];
}

export function replySeed(thread: ThreadSummary): ComposeSeed {
  return {
    accountId: thread.accountId,
    subject: thread.subject.toLowerCase().startsWith("re:")
      ? thread.subject
      : `Re: ${thread.subject}`,
    threadId: thread.id,
  };
}

export function Splash({ error }: { error?: AppError }) {
  const incompatible = error?.code === "incompatible_store";
  return (
    <div className="splash">
      <div className="brand-mark">
        <FluxmailLogoMark />
      </div>
      <h1>
        {error ? (incompatible ? "Update Fluxmail to continue" : "An error occurred") : "Fluxmail"}
      </h1>
      <p>{error?.message || "Opening your mail..."}</p>
      {error ? (
        <button
          type="button"
          className="secondary-button splash-restart"
          onClick={() => void window.fluxmail.system.restart()}
        >
          {incompatible ? "Try again" : "Restart Fluxmail"}
        </button>
      ) : null}
    </div>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Fluxmail could not complete that request.";
}

export function errorDetails(error: unknown): AppError {
  if (error instanceof Error) {
    const candidate = error as Error & {
      code?: unknown;
      retryable?: unknown;
      details?: unknown;
    };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "desktop_error",
      message: candidate.message,
      retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : true,
      ...(candidate.details && typeof candidate.details === "object"
        ? { details: candidate.details as Record<string, string | number | boolean> }
        : {}),
    };
  }
  return {
    code: "desktop_error",
    message: "Fluxmail could not start.",
    retryable: true,
  };
}
