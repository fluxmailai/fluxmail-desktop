import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  Forward,
  LoaderCircle,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Reply,
  ReplyAll,
  Search,
  Star,
  Tag,
  Trash2,
  ShieldAlert,
  X,
  Undo2,
} from "lucide-react";
import {
  hasUndoSendDelay,
  type ComposeAttachment,
  MailMessage,
  MailThread,
  MailboxView,
  ModifyActionInput,
  SendAsIdentity,
  ThreadSummary,
  UndoSendDelaySeconds,
} from "../../shared/contracts";
import {
  ComposeDialog,
  formatAddresses,
  parseAddressField,
  type ComposeDelivery,
  type ComposeDialogHandle,
  type ComposeSeed,
} from "./ComposeDialog";
import { KEYBOARD_SHORTCUTS } from "../shortcuts";
import { EmailHtml } from "./EmailHtml";
import { TrackingPixelIndicator } from "./TrackingPixelIndicator";
import { MailEditorContent, MailEditorToolbar, useMailEditor } from "./MailEditor";
import { IconButton, MenuButton } from "./Controls";
import { OverlayScrollbar } from "./OverlayScrollbar";
import {
  mailboxDeleteAction,
  mailboxDeleteLabel,
  mailboxMoveAction,
  mailboxMoveLabel,
} from "../mail-actions";
import type { TrackingPixelDetail } from "../email/tracking-pixels";
import { quotedReplyCitation } from "../../shared/quoted-reply";
import { quotedReplyTarget } from "../email/quoted-reply";
import {
  hasUnsendableReplyRecipient,
  replyRecipients,
  replyTargets,
} from "../../shared/reply-recipients";
import { SendControls } from "./SendControls";
import { defaultSender, SenderSelect, useSendAsIdentities } from "./SenderSelect";

interface Props {
  view: MailboxView;
  thread?: ThreadSummary;
  labels: string[];
  allowPermanentDelete: boolean;
  blockRemoteImages?: boolean;
  imageRelay?: boolean;
  imageRelayAvailable?: boolean;
  onModify(action: ModifyActionInput): Promise<void>;
  onError(message: string): void;
  onQuickReplyDirtyChange(dirty: boolean): void;
  onDelivery?(delivery: ComposeDelivery): void;
  undoSendDelaySeconds?: UndoSendDelaySeconds;
  quickReplyDiscardVersion?: number;
  onDraftMissing?(thread: ThreadSummary): void;
  onDraftFinished?(): void;
}

export type InlineComposerMode = "reply" | "replyAll" | "forward";

export interface ReadingPaneHandle {
  openComposer(mode: InlineComposerMode): void;
  openFind(): void;
  closeDraft(): boolean | Promise<boolean>;
}

interface InlineComposerState {
  mode: InlineComposerMode;
  initialAttachments: ComposeAttachment[];
}

export const ReadingPane = forwardRef<ReadingPaneHandle, Props>(function ReadingPane(
  {
    view,
    thread,
    labels,
    allowPermanentDelete,
    blockRemoteImages = true,
    imageRelay = true,
    imageRelayAvailable = true,
    onModify,
    onError,
    onQuickReplyDirtyChange,
    onDelivery,
    undoSendDelaySeconds = 10,
    quickReplyDiscardVersion,
    onDraftMissing,
    onDraftFinished,
  },
  ref,
) {
  const [detail, setDetail] = useState<MailThread>();
  const [loading, setLoading] = useState(false);
  const [composer, setComposer] = useState<InlineComposerState>();
  const [draftSeed, setDraftSeed] = useState<ComposeSeed>();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatchCounts, setFindMatchCounts] = useState<Record<string, number>>({});
  const [activeFindMatch, setActiveFindMatch] = useState(0);
  const forwardRequest = useRef(0);
  const composerRef = useRef<InlineComposerState | undefined>(undefined);
  const draftDialogRef = useRef<ComposeDialogHandle>(null);
  const draftSeedRef = useRef<ComposeSeed | undefined>(undefined);
  const loadedThreadKey = useRef<string | undefined>(undefined);
  const composerDirty = useRef(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  composerRef.current = composer;
  draftSeedRef.current = draftSeed;
  const threadIdentity = thread ? `${thread.accountId}:${thread.id}` : "";
  const threadIdentityRef = useRef(threadIdentity);
  threadIdentityRef.current = threadIdentity;
  // Loaded with the conversation so the reply composer opens at its final height.
  const sendAsIdentities = useSendAsIdentities(
    useMemo(() => (thread ? [thread.accountId] : []), [thread?.accountId]),
  );
  const handleScrollerRef = useCallback((element: HTMLDivElement | null) => {
    setScroller(element);
  }, []);

  const openFind = useCallback(() => {
    setFindOpen(true);
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  useLayoutEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  useLayoutEffect(() => {
    if (!composer || !scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [composer, scroller]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindMatchCounts({});
    setActiveFindMatch(0);
  }, []);

  useEffect(() => {
    composerDirty.current = false;
    setComposer(undefined);
  }, [quickReplyDiscardVersion]);

  const canReplaceComposer = useCallback((mode: InlineComposerMode) => {
    const current = composerRef.current;
    if (!current) return true;
    if (current.mode === mode) return false;
    if (composerDirty.current && !window.confirm("Discard this unsent message?")) return false;
    composerDirty.current = false;
    setComposer(undefined);
    return true;
  }, []);

  const closeComposer = useCallback(() => {
    composerDirty.current = false;
    setComposer(undefined);
  }, []);

  const handleComposerDirtyChange = useCallback(
    (dirty: boolean) => {
      composerDirty.current = dirty;
      onQuickReplyDirtyChange(dirty);
    },
    [onQuickReplyDirtyChange],
  );

  const openComposer = useCallback(
    async (mode: InlineComposerMode) => {
      if (draftSeed) return;
      const message = [...(detail?.messages ?? [])]
        .reverse()
        .find((candidate) => !candidate.flags.draft);
      if (!thread || !message) return;
      if (mode === "replyAll" && !shouldOfferReplyAll(thread.accountEmail, message)) return;
      if (!canReplaceComposer(mode)) return;
      if (mode !== "forward") {
        forwardRequest.current += 1;
        setComposer({ mode, initialAttachments: [] });
        return;
      }
      const request = ++forwardRequest.current;
      const identity = `${thread.accountId}:${thread.id}`;
      try {
        const initialAttachments = message.attachments?.length
          ? await window.fluxmail.attachments.prepare({
              accountId: thread.accountId,
              messageId: message.id,
              attachments: message.attachments,
            })
          : [];
        if (request !== forwardRequest.current || identity !== threadIdentityRef.current) {
          if (initialAttachments.length)
            void window.fluxmail.attachments
              .release(initialAttachments.map((attachment) => attachment.token))
              .catch(() => undefined);
          return;
        }
        setComposer({ mode, initialAttachments });
      } catch {
        if (request === forwardRequest.current && identity === threadIdentityRef.current) {
          onError("Could not add the original attachments. You can still forward without them.");
          setComposer({ mode, initialAttachments: [] });
        }
      }
    },
    [canReplaceComposer, detail, draftSeed, onError, thread],
  );

  useImperativeHandle(
    ref,
    () => ({
      openComposer: (mode) => void openComposer(mode),
      openFind,
      closeDraft: () => draftDialogRef.current?.close() ?? true,
    }),
    [openComposer, openFind],
  );

  useEffect(() => {
    const nextThreadKey = thread
      ? `${thread.accountId}:${thread.id}:${thread.scheduleId ?? thread.draftId ?? ""}`
      : undefined;
    if (nextThreadKey && nextThreadKey === loadedThreadKey.current && draftSeedRef.current) return;
    loadedThreadKey.current = nextThreadKey;
    closeFind();
    setDetail(undefined);
    setDraftSeed(undefined);
    composerDirty.current = false;
    setComposer(undefined);
    if (!thread) return;
    let canceled = false;
    setLoading(true);
    void window.fluxmail.mail
      .getThread({ accountId: thread.accountId, threadId: thread.id })
      .then(async (result) => {
        if (canceled) return;
        setDetail(result);
        const draft = [...result.messages]
          .reverse()
          .find(
            (message) =>
              message.flags.draft &&
              message.draftId &&
              (!thread.draftId || message.draftId === thread.draftId),
          );
        if (!draft?.draftId) {
          if (thread.draft) onDraftMissing?.(thread);
          return;
        }
        if (thread.pendingSend) return;
        const answerable = [...result.messages].reverse().filter((message) => !message.flags.draft);
        // A draft answers the message it quotes, even once newer replies have arrived.
        const quotedTarget = quotedReplyTarget(draft.body, answerable);
        const replyTarget = quotedTarget ?? answerable[0];
        const [initialAttachments, recipientFields] = await Promise.all([
          draft.attachments?.length
            ? window.fluxmail.attachments.prepare({
                accountId: thread.accountId,
                messageId: draft.id,
                attachments: draft.attachments,
              })
            : Promise.resolve([]),
          window.fluxmail.drafts.recipientFields({
            accountId: thread.accountId,
            draftId: draft.draftId,
          }),
        ]);
        if (canceled) {
          if (initialAttachments.length)
            void window.fluxmail.attachments
              .release(initialAttachments.map((attachment) => attachment.token))
              .catch(() => undefined);
          return;
        }
        setDraftSeed({
          accountId: thread.accountId,
          draftId: draft.draftId,
          ...(draft.from?.email ? { from: draft.from.email } : {}),
          to: recipientFields?.to ?? formatAddresses(draft.to),
          cc: recipientFields?.cc ?? formatAddresses(draft.cc),
          bcc: recipientFields?.bcc ?? formatAddresses(draft.bcc),
          subject: draft.subject,
          initialHtml: draft.body?.html,
          initialText: draft.body?.text,
          ...(replyTarget ? { threadId: thread.id, replyToMessageId: replyTarget.id } : {}),
          ...(quotedTarget ? { quotedMessageId: quotedTarget.id } : {}),
          initialAttachments,
        });
      })
      .catch((error) =>
        onError(
          error instanceof Error ? error.message : "Fluxmail could not open this conversation.",
        ),
      )
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [
    closeFind,
    onDraftMissing,
    onError,
    thread?.accountId,
    thread?.date,
    thread?.draftId,
    thread?.id,
    thread?.messageCount,
    thread?.pendingSend,
    thread?.scheduleId,
  ]);

  if (!thread)
    return (
      <section className="reading-pane empty-reading">
        <div className="reading-placeholder">
          <h2>Select a conversation</h2>
          <p>Your message will open here.</p>
        </div>
      </section>
    );
  if (loading || !detail)
    return (
      <section className="reading-pane empty-reading">
        <LoaderCircle className="spin" size={22} />
        <p role="status">Opening conversation...</p>
      </section>
    );
  const messages = detail.messages.filter(
    (message) =>
      !message.flags.draft ||
      Boolean(thread.pendingSend && thread.draftId && message.draftId === thread.draftId),
  );
  const totalFindMatches = messages.reduce(
    (total, message) => total + (findMatchCounts[message.id] ?? 0),
    0,
  );
  const replyTarget = [...messages].reverse().find((message) => !message.flags.draft);
  const replyAllAvailable = Boolean(
    replyTarget && shouldOfferReplyAll(detail.accountEmail, replyTarget),
  );
  const deleteAction = mailboxDeleteAction(view, allowPermanentDelete);
  const showNextFindMatch = (direction: 1 | -1) => {
    if (!totalFindMatches) return;
    setActiveFindMatch((current) => (current + direction + totalFindMatches) % totalFindMatches);
  };
  let findMatchOffset = 0;

  return (
    <section className="reading-pane">
      <header className="reading-toolbar">
        <div className="toolbar-group">
          {view !== "scheduled" ? (
            <IconButton
              label={mailboxMoveLabel(view)}
              shortcut={KEYBOARD_SHORTCUTS.archive}
              onClick={() => void onModify(mailboxMoveAction(view))}
            >
              {view === "trash" ? <Undo2 size={17} /> : <Archive size={17} />}
            </IconButton>
          ) : null}
          {deleteAction ? (
            <IconButton
              label={mailboxDeleteLabel(view)}
              shortcut={KEYBOARD_SHORTCUTS.trash}
              onClick={() => void onModify(deleteAction)}
            >
              <Trash2 size={17} />
            </IconButton>
          ) : null}
          <IconButton
            label="Mark unread"
            shortcut={KEYBOARD_SHORTCUTS.toggleRead}
            onClick={() => void onModify({ type: "markUnread" })}
          >
            <MailOpen size={17} />
          </IconButton>
          {labels.length ? (
            <MenuButton
              label="Apply label"
              options={labels.map((label) => ({
                id: label,
                label,
                onSelect: () => void onModify({ type: "addLabels", labels: [label] }),
              }))}
            >
              <Tag size={16} />
            </MenuButton>
          ) : null}
          {view !== "scheduled" ? (
            <MenuButton
              label="More actions"
              options={[
                {
                  id: "spam",
                  label: "Mark as spam",
                  icon: <ShieldAlert size={15} />,
                  onSelect: () => void onModify({ type: "move", folder: "spam" }),
                },
              ]}
            >
              <MoreHorizontal size={17} />
            </MenuButton>
          ) : null}
        </div>
        <IconButton
          label={thread.starred ? "Unstar" : "Star"}
          shortcut={KEYBOARD_SHORTCUTS.star}
          onClick={() => void onModify({ type: thread.starred ? "unstar" : "star" })}
        >
          <Star size={17} fill={thread.starred ? "currentColor" : "none"} />
        </IconButton>
      </header>
      {findOpen ? (
        <div className="message-find-bar" role="search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={findInputRef}
            aria-label="Find in conversation"
            aria-keyshortcuts={KEYBOARD_SHORTCUTS.find.keys}
            placeholder="Find in conversation"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindMatchCounts({});
              setActiveFindMatch(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                showNextFindMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="message-find-status" role="status" aria-live="polite">
            {findQuery
              ? totalFindMatches
                ? `${activeFindMatch + 1} of ${totalFindMatches}`
                : "No matches"
              : null}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            disabled={!totalFindMatches}
            onClick={() => showNextFindMatch(-1)}
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            aria-label="Next match"
            disabled={!totalFindMatches}
            onClick={() => showNextFindMatch(1)}
          >
            <ChevronDown size={16} />
          </button>
          <button type="button" aria-label="Close find" onClick={closeFind}>
            <X size={16} />
          </button>
        </div>
      ) : null}
      <div className="conversation-scroll-shell">
        <div ref={handleScrollerRef} className="conversation-scroll">
          <div className="conversation-title">
            <h1>{detail.subject || "(no subject)"}</h1>
            {thread.labels.filter((label) => labels.includes(label)).length ? (
              <div className="thread-labels">
                {thread.labels
                  .filter((label) => labels.includes(label))
                  .map((label) => (
                    <button
                      key={label}
                      title={`Remove ${label}`}
                      onClick={() => void onModify({ type: "removeLabels", labels: [label] })}
                    >
                      {label}
                      <X size={11} />
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
          {messages.map((message) => {
            const matchCount = findMatchCounts[message.id] ?? 0;
            const localActiveFindMatch =
              activeFindMatch >= findMatchOffset && activeFindMatch < findMatchOffset + matchCount
                ? activeFindMatch - findMatchOffset
                : undefined;
            findMatchOffset += matchCount;
            return (
              <MessageCard
                key={message.id}
                message={message}
                blockRemoteImages={blockRemoteImages}
                imageRelay={imageRelay}
                imageRelayAvailable={imageRelayAvailable}
                findQuery={findOpen ? findQuery : ""}
                activeFindMatch={localActiveFindMatch}
                onFindMatchCountChange={(count) =>
                  setFindMatchCounts((current) =>
                    current[message.id] === count ? current : { ...current, [message.id]: count },
                  )
                }
                onError={onError}
              />
            );
          })}
          {draftSeed ? (
            <ComposeDialog
              ref={draftDialogRef}
              inline
              seed={draftSeed}
              accounts={[]}
              blockRemoteImages={blockRemoteImages}
              imageRelay={imageRelay}
              imageRelayAvailable={imageRelayAvailable}
              undoSendDelaySeconds={undoSendDelaySeconds}
              onClose={() => {
                setDraftSeed(undefined);
                setDetail((current) =>
                  current
                    ? {
                        ...current,
                        messages: current.messages.filter((message) => !message.flags.draft),
                      }
                    : current,
                );
                onDraftFinished?.();
              }}
              onSent={(delivery) => {
                setDraftSeed(undefined);
                onDraftFinished?.();
                onDelivery?.(delivery);
              }}
              onError={onError}
            />
          ) : replyTarget ? (
            <div className="reply-actions">
              <button
                aria-keyshortcuts={KEYBOARD_SHORTCUTS.reply.keys}
                onClick={() => void openComposer("reply")}
              >
                <Reply size={16} />
                Reply
              </button>
              {replyAllAvailable ? (
                <button
                  aria-keyshortcuts={KEYBOARD_SHORTCUTS.replyAll.keys}
                  onClick={() => void openComposer("replyAll")}
                >
                  <ReplyAll size={16} />
                  Reply all
                </button>
              ) : null}
              <button
                aria-keyshortcuts={KEYBOARD_SHORTCUTS.forward.keys}
                onClick={() => void openComposer("forward")}
              >
                <Forward size={16} />
                Forward
              </button>
            </div>
          ) : null}
          {!draftSeed && composer && replyTarget ? (
            <InlineComposer
              key={composer.mode}
              accountId={thread.accountId}
              accountEmail={thread.accountEmail}
              sendAsIdentities={sendAsIdentities[thread.accountId]}
              threadId={thread.id}
              message={replyTarget}
              mode={composer.mode}
              initialAttachments={composer.initialAttachments}
              imageRelay={imageRelay}
              imageRelayAvailable={imageRelayAvailable}
              onCancel={closeComposer}
              onSent={(delivery) => {
                closeComposer();
                onDelivery?.(delivery);
              }}
              undoSendDelaySeconds={undoSendDelaySeconds}
              onError={onError}
              onDirtyChange={handleComposerDirtyChange}
              blockRemoteImages={blockRemoteImages}
            />
          ) : null}
        </div>
        <OverlayScrollbar scroller={scroller} fadeClass="reading-fade" />
      </div>
    </section>
  );
});

function MessageCard({
  message,
  blockRemoteImages,
  imageRelay,
  imageRelayAvailable,
  findQuery,
  activeFindMatch,
  onFindMatchCountChange,
  onError,
}: {
  message: MailMessage;
  blockRemoteImages: boolean;
  imageRelay: boolean;
  imageRelayAvailable: boolean;
  findQuery: string;
  activeFindMatch?: number;
  onFindMatchCountChange(count: number): void;
  onError(message: string): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [trackingPixels, setTrackingPixels] = useState<TrackingPixelDetail[]>([]);
  const senderName = message.from?.name || message.from?.email || "Unknown sender";
  const senderEmail =
    message.from?.email && message.from.email !== senderName ? message.from.email : undefined;
  const contentExpanded = expanded || Boolean(findQuery);
  const toggleExpanded = () => {
    if (!findQuery) setExpanded((value) => !value);
  };
  return (
    <article className="message-card">
      <div className="message-header">
        <button
          type="button"
          className="message-header-toggle"
          aria-label={contentExpanded ? "Collapse message" : "Expand message"}
          aria-expanded={contentExpanded}
          disabled={Boolean(findQuery)}
          onClick={toggleExpanded}
        />
        <span className="sender-avatar">{senderName.slice(0, 1).toUpperCase()}</span>
        <span className="message-sender">
          <span className="message-from">
            <span
              className="message-from-identity"
              title={senderEmail ? `${senderName} <${senderEmail}>` : senderName}
            >
              <strong>{senderName}</strong>
              {senderEmail ? (
                <span className="message-from-email">&lt;{senderEmail}&gt;</span>
              ) : null}
            </span>
            {trackingPixels.length ? (
              <TrackingPixelIndicator trackingPixels={trackingPixels} />
            ) : null}
          </span>
          <small title={`to ${formatRecipients(message.to)}`} onClick={toggleExpanded}>
            to {formatRecipients(message.to)}
          </small>
          {message.cc?.length ? (
            <small title={`cc ${formatRecipients(message.cc)}`} onClick={toggleExpanded}>
              cc {formatRecipients(message.cc)}
            </small>
          ) : null}
          {message.bcc?.length ? (
            <small title={`bcc ${formatRecipients(message.bcc)}`} onClick={toggleExpanded}>
              bcc {formatRecipients(message.bcc)}
            </small>
          ) : null}
        </span>
        <time>
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(message.date))}
        </time>
      </div>
      {contentExpanded ? (
        <div className="message-body">
          <EmailHtml
            message={message}
            blockRemoteImages={blockRemoteImages}
            imageRelay={imageRelay}
            imageRelayAvailable={imageRelayAvailable}
            findQuery={findQuery}
            activeFindMatch={activeFindMatch}
            onFindMatchCountChange={onFindMatchCountChange}
            onError={onError}
            onTrackingPixelsChange={setTrackingPixels}
          />
          {message.attachments?.length ? (
            <div className="attachment-list">
              {message.attachments
                .filter((attachment) => attachment.disposition !== "inline")
                .map((attachment) => (
                  <button
                    key={attachment.id}
                    onClick={() =>
                      void window.fluxmail.attachments
                        .save({
                          accountId: message.accountId,
                          messageId: message.id,
                          attachment,
                        })
                        .catch((error) =>
                          onError(
                            error instanceof Error
                              ? error.message
                              : "Could not save the attachment.",
                          ),
                        )
                    }
                  >
                    <Paperclip size={14} />
                    <span>{attachment.filename}</span>
                    <small>{formatBytes(attachment.sizeBytes)}</small>
                  </button>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function InlineComposer({
  accountId,
  accountEmail,
  sendAsIdentities,
  threadId,
  message,
  mode,
  initialAttachments,
  imageRelay,
  imageRelayAvailable,
  onCancel,
  onSent,
  onError,
  onDirtyChange,
  blockRemoteImages,
  undoSendDelaySeconds,
}: {
  accountId: string;
  accountEmail: string;
  sendAsIdentities?: SendAsIdentity[];
  threadId: string;
  message: MailMessage;
  mode: InlineComposerMode;
  initialAttachments: ComposeAttachment[];
  imageRelay: boolean;
  imageRelayAvailable: boolean;
  onCancel(): void;
  onSent(delivery: ComposeDelivery): void;
  onError(message: string): void;
  onDirtyChange(dirty: boolean): void;
  blockRemoteImages: boolean;
  undoSendDelaySeconds: UndoSendDelaySeconds;
}) {
  const forwarding = mode === "forward";
  const initialSubject = forwarding
    ? message.subject.toLowerCase().startsWith("fwd:")
      ? message.subject
      : `Fwd: ${message.subject}`
    : message.subject.toLowerCase().startsWith("re:")
      ? message.subject
      : `Re: ${message.subject}`;
  // A reply normally leaves its recipients to the engine, which derives them from the original
  // message. When a header address is not one a provider will accept, the reply names them
  // instead so the sender sees the address and can correct it.
  const namesRecipients =
    !forwarding && hasUnsendableReplyRecipient(accountEmail, message, mode === "replyAll");
  const showRecipientFields = forwarding || namesRecipients;
  const derivedRecipients = namesRecipients
    ? replyRecipients(accountEmail, message, mode === "replyAll")
    : { to: [], cc: [] };
  const initialTo = formatAddresses(derivedRecipients.to);
  const initialCc = formatAddresses(derivedRecipients.cc);
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(initialCc);
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(Boolean(initialCc));
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState(initialSubject);
  const [from, setFrom] = useState<string>();
  const senderEmail =
    from ?? defaultSender(sendAsIdentities, forwarding ? undefined : message)?.email;
  const showSender = (sendAsIdentities?.length ?? 0) > 1;
  const [html, setHtml] = useState("<p></p>");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [deliveryKind, setDeliveryKind] = useState<ComposeDelivery["kind"]>("undo");
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [attachments, setAttachments] = useState(initialAttachments);
  const [attachmentsChanged, setAttachmentsChanged] = useState(false);
  const attachmentTokens = useRef(
    new Set(initialAttachments.map((attachment) => attachment.token)),
  );
  const attachmentsReleased = useRef(false);
  const releaseTimer = useRef<number | undefined>(undefined);
  const ccRef = useRef<HTMLInputElement>(null);
  const bccRef = useRef<HTMLInputElement>(null);
  const editor = useMailEditor({
    autoFocus: !showRecipientFields,
    onChange: (value) => {
      setHtml(value.html);
      setText(value.text);
    },
  });

  const releaseAttachments = useCallback(() => {
    if (attachmentsReleased.current) return;
    attachmentsReleased.current = true;
    const tokens = [...attachmentTokens.current];
    for (let index = 0; index < tokens.length; index += 20)
      void window.fluxmail.attachments
        .release(tokens.slice(index, index + 20))
        .catch(() => undefined);
  }, []);

  useEffect(() => {
    onDirtyChange(
      Boolean(
        text.trim() ||
        attachmentsChanged ||
        (showRecipientFields &&
          (to.trim() !== initialTo.trim() ||
            cc.trim() !== initialCc.trim() ||
            bcc.trim() ||
            subject !== initialSubject)),
      ),
    );
  }, [
    attachmentsChanged,
    bcc,
    cc,
    initialCc,
    initialSubject,
    initialTo,
    onDirtyChange,
    showRecipientFields,
    subject,
    text,
    to,
  ]);

  useEffect(() => {
    window.clearTimeout(releaseTimer.current);
    return () => {
      onDirtyChange(false);
      releaseTimer.current = window.setTimeout(releaseAttachments, 0);
    };
  }, [onDirtyChange, releaseAttachments]);

  const send = async (timing?: { sendAt: string }) => {
    const toField = parseAddressField(to);
    const ccField = parseAddressField(cc);
    const bccField = parseAddressField(bcc);
    if (showRecipientFields && (toField.invalid || ccField.invalid || bccField.invalid)) {
      onError(
        namesRecipients
          ? "Fluxmail cannot send to the reply address on this message. Correct it and try again."
          : "Check the recipient addresses and try again.",
      );
      return;
    }
    if (
      (!forwarding && !text.trim()) ||
      (forwarding &&
        !toField.addresses.length &&
        !ccField.addresses.length &&
        !bccField.addresses.length)
    )
      return;
    // Without a To recipient the engine would derive one from the original message again,
    // which is where the address Fluxmail cannot send to came from.
    if (namesRecipients && !toField.addresses.length) {
      onError("Add a recipient before sending this reply.");
      return;
    }
    const kind = timing ? "scheduled" : hasUndoSendDelay(undoSendDelaySeconds) ? "undo" : "sent";
    setDeliveryKind(kind);
    setSending(true);
    try {
      if (forwarding) {
        const delivery = await window.fluxmail.mail.forward({
          target: { accountId, threadId },
          messageId: message.id,
          from,
          to: toField.addresses,
          cc: ccField.addresses,
          bcc: bccField.addresses,
          subject,
          text,
          html,
          attachments,
          includeAttachments: false,
          ...(timing
            ? timing
            : hasUndoSendDelay(undoSendDelaySeconds)
              ? {
                  delaySeconds: undoSendDelaySeconds,
                }
              : {}),
        });
        releaseAttachments();
        onSent(delivery ? { ...delivery, kind: timing ? "scheduled" : "undo" } : { kind: "sent" });
      } else {
        const input = {
          accountId,
          from,
          to: namesRecipients ? toField.addresses : [],
          ...(namesRecipients && ccField.addresses.length ? { cc: ccField.addresses } : {}),
          ...(namesRecipients && bccField.addresses.length ? { bcc: bccField.addresses } : {}),
          subject,
          text,
          html,
          replyToMessageId: message.id,
          replyAll: mode === "replyAll",
          attachments,
        };
        if (timing) {
          const delivery = await window.fluxmail.drafts.schedule({ ...input, ...timing });
          releaseAttachments();
          onSent({ ...delivery, kind: "scheduled" });
        } else if (hasUndoSendDelay(undoSendDelaySeconds)) {
          const delivery = await window.fluxmail.drafts.schedule({
            ...input,
            delaySeconds: undoSendDelaySeconds,
          });
          releaseAttachments();
          onSent({ ...delivery, kind: "undo" });
        } else {
          await window.fluxmail.drafts.send(input);
          releaseAttachments();
          onSent({ kind: "sent" });
        }
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Fluxmail could not send this message.");
    } finally {
      setSending(false);
    }
  };

  const sendDisabled =
    (!forwarding && !text.trim()) ||
    (forwarding && !to.trim() && !cc.trim() && !bcc.trim()) ||
    (namesRecipients && !to.trim());
  return (
    <div
      className="quick-reply"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void send();
        }
      }}
    >
      {showRecipientFields || showSender ? (
        <div className="compose-fields inline-compose-fields">
          {showSender && senderEmail ? (
            <SenderSelect
              accounts={[{ id: accountId, email: accountEmail }]}
              identities={{ [accountId]: sendAsIdentities ?? [] }}
              value={{ accountId, email: senderEmail }}
              onChange={(choice) => setFrom(choice.email)}
            />
          ) : null}
          {showRecipientFields ? (
            <>
              <label className="recipient-row">
                <span>To</span>
                <input
                  aria-label="To"
                  autoFocus
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  placeholder="name@example.com"
                />
                <span className="recipient-field-actions">
                  {!showCc ? (
                    <button
                      type="button"
                      onClick={() => {
                        setShowCc(true);
                        window.requestAnimationFrame(() => ccRef.current?.focus());
                      }}
                    >
                      Cc
                    </button>
                  ) : null}
                  {!showBcc ? (
                    <button
                      type="button"
                      onClick={() => {
                        setShowBcc(true);
                        window.requestAnimationFrame(() => bccRef.current?.focus());
                      }}
                    >
                      Bcc
                    </button>
                  ) : null}
                </span>
              </label>
              {showCc ? (
                <label className="recipient-row">
                  <span>Cc</span>
                  <input
                    ref={ccRef}
                    aria-label="Cc"
                    value={cc}
                    onChange={(event) => setCc(event.target.value)}
                  />
                </label>
              ) : null}
              {showBcc ? (
                <label className="recipient-row">
                  <span>Bcc</span>
                  <input
                    ref={bccRef}
                    aria-label="Bcc"
                    value={bcc}
                    onChange={(event) => setBcc(event.target.value)}
                  />
                </label>
              ) : null}
              {forwarding ? (
                <label>
                  <span>Subject</span>
                  <input
                    aria-label="Subject"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                  />
                </label>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <MailEditorContent
        editor={editor}
        empty={!text.trim()}
        placeholder={
          forwarding ? "Add a message" : mode === "replyAll" ? "Reply to everyone" : "Write a reply"
        }
      />
      <div className="quoted-reply">
        <IconButton
          label={quoteOpen ? "Hide quoted message" : "Show quoted message"}
          className="quoted-reply-toggle"
          tooltipSide="top"
          onClick={() => setQuoteOpen((value) => !value)}
        >
          <Ellipsis size={18} />
        </IconButton>
        {quoteOpen ? (
          <div className="quoted-reply-content">
            <div className="quoted-reply-meta">{quotedReplyCitation(message)}</div>
            <div className="quoted-reply-body">
              <EmailHtml
                message={message}
                blockRemoteImages={blockRemoteImages}
                imageRelay={imageRelay}
                imageRelayAvailable={imageRelayAvailable}
                onError={onError}
              />
            </div>
          </div>
        ) : null}
      </div>
      {attachments.length ? (
        <div className="compose-attachments inline-compose-attachments">
          {attachments.map((attachment) => (
            <span key={attachment.token}>
              <Paperclip size={13} />
              {attachment.filename}
              <button
                aria-label={`Remove ${attachment.filename}`}
                onClick={() => {
                  setAttachmentsChanged(true);
                  setAttachments((current) =>
                    current.filter((item) => item.token !== attachment.token),
                  );
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="quick-reply-footer">
        <MailEditorToolbar
          editor={editor}
          onAttach={() =>
            void window.fluxmail.attachments
              .pick()
              .then((picked) => {
                if (!picked.length) return;
                if (attachments.length + picked.length > 20) {
                  void window.fluxmail.attachments.release(
                    picked.map((attachment) => attachment.token),
                  );
                  onError("You can attach up to 20 files to a message.");
                  return;
                }
                for (const attachment of picked) attachmentTokens.current.add(attachment.token);
                setAttachmentsChanged(true);
                setAttachments((current) => [...current, ...picked]);
              })
              .catch((error) =>
                onError(
                  error instanceof Error ? error.message : "Fluxmail could not attach these files.",
                ),
              )
          }
        />
        <div className="quick-reply-actions">
          <button className="text-button" onClick={onCancel}>
            Cancel
          </button>
          <SendControls
            sending={sending}
            deliveryKind={deliveryKind}
            disabled={sendDisabled}
            onSend={() => void send()}
            onSchedule={(sendAt) => void send({ sendAt })}
            onError={onError}
          />
        </div>
      </div>
    </div>
  );
}

function formatRecipients(recipients: Array<{ name?: string; email: string }>): string {
  return (
    recipients
      .map((recipient) =>
        recipient.name && recipient.name !== recipient.email
          ? `${recipient.name} <${recipient.email}>`
          : recipient.email,
      )
      .join(", ") || "me"
  );
}

export function shouldOfferReplyAll(accountEmail: string, message: MailMessage): boolean {
  const ownAddress = normalizeAddress(accountEmail);
  const targets = replyTargets(message);
  const replyToTargets = uniqueAddresses(targets).filter((address) => address !== ownAddress);
  const normalRecipients = new Set(
    replyToTargets.length ? replyToTargets : uniqueAddresses(message.to),
  );
  const replyAllRecipients = uniqueAddresses([
    ...targets,
    ...message.to,
    ...(message.cc ?? []),
  ]).filter((address) => address !== ownAddress);
  if (!replyAllRecipients.length) replyAllRecipients.push(ownAddress);
  return replyAllRecipients.some((address) => !normalRecipients.has(address));
}

function uniqueAddresses(addresses: Array<{ email: string }>): string[] {
  return [...new Set(addresses.map((address) => normalizeAddress(address.email)).filter(Boolean))];
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
