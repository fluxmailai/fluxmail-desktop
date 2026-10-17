import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Ellipsis, Paperclip, Trash2, X } from "lucide-react";
import {
  addressSchema,
  hasUndoSendDelay,
  type AccountInfo,
  type ComposeAttachment,
  type MailMessage,
  type ScheduledSendResult,
  type UndoSendDelaySeconds,
} from "../../shared/contracts";
import {
  emailHtmlFromEditor,
  MailEditorContent,
  MailEditorToolbar,
  useMailEditor,
} from "./MailEditor";
import { EmailHtml } from "./EmailHtml";
import { IconButton } from "./Controls";
import { quotedReplyCitation, replyWithoutQuotedText } from "../../shared/quoted-reply";
import { replyTargets } from "../../shared/reply-recipients";
import { attachmentsWithoutQuotedInline, replyWithoutQuotedHtml } from "../email/quoted-reply";
import { SendControls } from "./SendControls";
import { defaultSender, SenderSelect, useSendAsIdentities } from "./SenderSelect";

export type ComposeDelivery =
  | { kind: "sent" }
  | (ScheduledSendResult & { kind: "undo" | "scheduled" });

export interface ComposeSeed {
  accountId: string;
  draftId?: string;
  /** The address a saved draft is sent from. */
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  initialHtml?: string;
  initialText?: string;
  threadId?: string;
  replyToMessageId?: string;
  /** The message the saved draft already quotes, when it can be identified. */
  quotedMessageId?: string;
  replyAll?: boolean;
  forwardMessageId?: string;
  initialAttachments?: ComposeAttachment[];
}

interface Props {
  seed: ComposeSeed;
  accounts: AccountInfo[];
  inline?: boolean;
  blockRemoteImages?: boolean;
  imageRelay?: boolean;
  imageRelayAvailable?: boolean;
  undoSendDelaySeconds?: UndoSendDelaySeconds;
  onClose(): void;
  onSent(delivery: ComposeDelivery): void;
  onError(message: string): void;
}

export interface ComposeDialogHandle {
  close(): Promise<boolean>;
}

export const ComposeDialog = forwardRef<ComposeDialogHandle, Props>(function ComposeDialog(
  {
    seed,
    accounts,
    inline = false,
    blockRemoteImages = true,
    imageRelay = true,
    imageRelayAvailable = true,
    undoSendDelaySeconds = 10,
    onClose,
    onSent,
    onError,
  },
  ref,
) {
  const seededBody = useMemo(
    () => composerBody(seed),
    [
      seed.initialAttachments,
      seed.initialHtml,
      seed.initialText,
      seed.quotedMessageId,
      seed.replyToMessageId,
    ],
  );
  const initialEditorHtml = seededBody.html;
  const [accountId, setAccountId] = useState(seed.accountId);
  // Left unset, the engine picks the sender, matching the address a reply was sent to.
  const [from, setFrom] = useState(seed.from);
  const [to, setTo] = useState(seed.to ?? "");
  const [cc, setCc] = useState(seed.cc ?? "");
  const [bcc, setBcc] = useState(seed.bcc ?? "");
  const [subject, setSubject] = useState(seed.subject ?? "");
  const [replyToMessageId, setReplyToMessageId] = useState(seed.replyToMessageId);
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(seededBody.attachments);
  const [draftId, setDraftId] = useState(seed.draftId);
  const [html, setHtml] = useState(() => emailHtmlFromEditor(initialEditorHtml));
  const [text, setText] = useState(seededBody.text);
  const [showCc, setShowCc] = useState(Boolean(seed.cc));
  const [showBcc, setShowBcc] = useState(Boolean(seed.bcc));
  const [recipientsCollapsed, setRecipientsCollapsed] = useState(Boolean(seed.to));
  const [sending, setSending] = useState(false);
  const [deliveryKind, setDeliveryKind] = useState<ComposeDelivery["kind"]>("undo");
  const [saving, setSaving] = useState(false);
  const [quotedMessage, setQuotedMessage] = useState<MailMessage>();
  const [quoteOpen, setQuoteOpen] = useState(false);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const finishing = useRef(false);
  const attachmentTokens = useRef(
    new Set((seed.initialAttachments ?? []).map((attachment) => attachment.token)),
  );
  const attachmentsReleased = useRef(false);
  const releaseTimer = useRef<number | undefined>(undefined);
  const saveInFlight = useRef<Promise<{ draftId: string; messageId: string }> | undefined>(
    undefined,
  );
  const ccRef = useRef<HTMLInputElement>(null);
  const bccRef = useRef<HTMLInputElement>(null);
  const editor = useMailEditor({
    initialHtml: initialEditorHtml,
    autoFocus: !inline && Boolean(seed.to),
    onChange: ({ html: nextHtml, text: nextText }) => {
      revision.current += 1;
      setHtml(nextHtml);
      setText(nextText);
    },
  });

  const releaseTokens = useCallback((tokens: string[]) => {
    for (let index = 0; index < tokens.length; index += 20)
      void window.fluxmail.attachments
        .release(tokens.slice(index, index + 20))
        .catch(() => undefined);
  }, []);

  const releaseAttachments = useCallback(() => {
    if (attachmentsReleased.current) return;
    attachmentsReleased.current = true;
    releaseTokens([...attachmentTokens.current]);
  }, [releaseTokens]);

  useEffect(() => {
    window.clearTimeout(releaseTimer.current);
    return () => {
      releaseTimer.current = window.setTimeout(releaseAttachments, 0);
    };
  }, [releaseAttachments]);

  useEffect(() => {
    if (!seed.threadId) return;
    let canceled = false;
    void window.fluxmail.mail
      .getThread({ accountId: seed.accountId, threadId: seed.threadId })
      .then((thread) => {
        const message = seed.replyToMessageId
          ? thread.messages.find((candidate) => candidate.id === seed.replyToMessageId)
          : [...thread.messages].reverse().find((candidate) => !candidate.flags.draft);
        if (!message || canceled) return;
        setQuotedMessage(message);
        if (!seed.forwardMessageId) {
          if (revision.current > 0) revision.current += 1;
          setReplyToMessageId((current) => current ?? message.id);
          setTo((current) => current || replyRecipient(thread.accountEmail, message));
        }
      })
      .catch((error) => {
        if (!canceled)
          onError(
            error instanceof Error ? error.message : "Fluxmail could not open this conversation.",
          );
      });
    return () => {
      canceled = true;
    };
  }, [onError, seed.accountId, seed.forwardMessageId, seed.replyToMessageId, seed.threadId]);

  const toField = useMemo(() => parseAddressField(to), [to]);
  const ccField = useMemo(() => parseAddressField(cc), [cc]);
  const bccField = useMemo(() => parseAddressField(bcc), [bcc]);
  const parsedTo = toField.addresses;
  const parsedCc = ccField.addresses;
  const parsedBcc = bccField.addresses;
  const senderAccounts = useMemo(
    () => (accounts.length ? accounts : [{ id: seed.accountId, email: "" }]),
    [accounts, seed.accountId],
  );
  const sendAsIdentities = useSendAsIdentities(
    useMemo(() => senderAccounts.map((account) => account.id), [senderAccounts]),
  );
  const senderEmail =
    from ??
    defaultSender(sendAsIdentities[accountId], seed.forwardMessageId ? undefined : quotedMessage)
      ?.email ??
    senderAccounts.find((account) => account.id === accountId)?.email ??
    "";
  const hasDraftContent = Boolean(
    text.trim() || subject.trim() || to.trim() || cc.trim() || bcc.trim() || attachments.length,
  );
  const composeTitle =
    subject.trim() ||
    (seed.forwardMessageId ? "Forward message" : replyToMessageId ? "Reply" : "New message");
  useEffect(() => {
    if (
      seed.forwardMessageId ||
      sending ||
      finishing.current ||
      revision.current === savedRevision.current ||
      (!hasDraftContent && !draftId)
    )
      return;
    const timer = window.setTimeout(() => {
      if (finishing.current) return;
      setSaving(true);
      const requestRevision = revision.current;
      const save = (pending?: { draftId: string }) =>
        window.fluxmail.drafts.save({
          accountId,
          draftId: draftId ?? pending?.draftId,
          from,
          to: parsedTo,
          cc: parsedCc,
          bcc: parsedBcc,
          subject,
          html,
          text,
          replyToMessageId,
          replyAll: seed.replyAll,
          attachments,
          recipientFields: { to, cc, bcc },
        });
      const previous = saveInFlight.current;
      const request = previous ? previous.catch(() => undefined).then(save) : save();
      saveInFlight.current = request;
      void request
        .then((result) => {
          setDraftId(result.draftId);
          savedRevision.current = Math.max(savedRevision.current, requestRevision);
        })
        .catch((error) =>
          onError(error instanceof Error ? error.message : "Fluxmail could not save this draft."),
        )
        .finally(() => {
          if (saveInFlight.current === request) saveInFlight.current = undefined;
          setSaving(false);
        });
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [
    accountId,
    attachments,
    draftId,
    from,
    hasDraftContent,
    html,
    onError,
    parsedBcc,
    parsedCc,
    parsedTo,
    replyToMessageId,
    seed.forwardMessageId,
    seed.replyAll,
    sending,
    subject,
    text,
  ]);

  const validateSend = () => {
    if (toField.invalid || ccField.invalid || bccField.invalid) {
      onError("Check the recipient addresses and try again.");
      return false;
    }
    const hasRecipient = Boolean(parsedTo.length || parsedCc.length || parsedBcc.length);
    if (!hasRecipient || (!seed.forwardMessageId && !text.trim())) {
      onError("Add a recipient and write a message before sending.");
      return false;
    }
    return true;
  };

  const deliver = async (
    kind: "undo" | "scheduled",
    timing: { sendAt: string } | { delaySeconds: Exclude<UndoSendDelaySeconds, 0> },
  ) => {
    if (!validateSend()) return;
    finishing.current = true;
    setDeliveryKind(kind);
    setSending(true);
    try {
      const pendingDraft = await saveInFlight.current?.catch(() => undefined);
      const currentDraftId = draftId ?? pendingDraft?.draftId;
      if (seed.forwardMessageId) {
        const scheduled = await window.fluxmail.mail.forward({
          target: {
            accountId,
            threadId: seed.threadId ?? seed.forwardMessageId,
          },
          messageId: seed.forwardMessageId,
          from,
          to: parsedTo,
          cc: parsedCc,
          bcc: parsedBcc,
          subject,
          text,
          html,
          attachments,
          includeAttachments: false,
          ...timing,
        });
        if (!scheduled) throw new Error("Fluxmail could not schedule this message.");
        releaseAttachments();
        onSent({ ...scheduled, kind });
      } else {
        const scheduled = await window.fluxmail.drafts.schedule({
          accountId,
          draftId: currentDraftId,
          from,
          to: parsedTo,
          cc: parsedCc,
          bcc: parsedBcc,
          subject,
          html,
          text,
          replyToMessageId,
          replyAll: seed.replyAll,
          attachments,
          recipientFields: { to, cc, bcc },
          ...timing,
        });
        releaseAttachments();
        onSent({ ...scheduled, kind });
      }
      void window.fluxmail.analytics
        .trackFeature({
          feature: "compose",
          action: "completed",
          source: "compose",
        })
        .catch(() => undefined);
    } catch (error) {
      finishing.current = false;
      onError(error instanceof Error ? error.message : "Fluxmail could not send this message.");
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (hasUndoSendDelay(undoSendDelaySeconds)) {
      await deliver("undo", { delaySeconds: undoSendDelaySeconds });
      return;
    }
    if (!validateSend()) return;
    finishing.current = true;
    setSending(true);
    try {
      const pendingDraft = await saveInFlight.current?.catch(() => undefined);
      const currentDraftId = draftId ?? pendingDraft?.draftId;
      if (seed.forwardMessageId) {
        await window.fluxmail.mail.forward({
          target: { accountId, threadId: seed.threadId ?? seed.forwardMessageId },
          messageId: seed.forwardMessageId,
          from,
          to: parsedTo,
          cc: parsedCc,
          bcc: parsedBcc,
          subject,
          text,
          html,
          attachments,
          includeAttachments: false,
        });
      } else {
        await window.fluxmail.drafts.send({
          accountId,
          draftId: currentDraftId,
          from,
          to: parsedTo,
          cc: parsedCc,
          bcc: parsedBcc,
          subject,
          html,
          text,
          replyToMessageId,
          replyAll: seed.replyAll,
          attachments,
          recipientFields: { to, cc, bcc },
        });
      }
      releaseAttachments();
      onSent({ kind: "sent" });
    } catch (error) {
      finishing.current = false;
      onError(error instanceof Error ? error.message : "Fluxmail could not send this message.");
    } finally {
      setSending(false);
    }
  };

  const close = async (): Promise<boolean> => {
    if (finishing.current) return false;
    finishing.current = true;
    if (seed.forwardMessageId && !canCloseForward(revision.current !== savedRevision.current)) {
      finishing.current = false;
      return false;
    }
    let currentDraftId = draftId;
    if (!seed.forwardMessageId && saveInFlight.current) {
      try {
        currentDraftId ??= (await saveInFlight.current).draftId;
      } catch (error) {
        finishing.current = false;
        onError(error instanceof Error ? error.message : "Fluxmail could not save this draft.");
        return false;
      }
    }
    if (
      !seed.forwardMessageId &&
      revision.current !== savedRevision.current &&
      (hasDraftContent || Boolean(currentDraftId))
    ) {
      setSaving(true);
      try {
        const requestRevision = revision.current;
        const result = await window.fluxmail.drafts.save({
          accountId,
          draftId: currentDraftId,
          from,
          to: parsedTo,
          cc: parsedCc,
          bcc: parsedBcc,
          subject,
          html,
          text,
          replyToMessageId,
          replyAll: seed.replyAll,
          attachments,
          recipientFields: { to, cc, bcc },
        });
        setDraftId(result.draftId);
        savedRevision.current = requestRevision;
      } catch (error) {
        finishing.current = false;
        onError(error instanceof Error ? error.message : "Fluxmail could not save this draft.");
        setSaving(false);
        return false;
      }
      setSaving(false);
    }
    releaseAttachments();
    onClose();
    return true;
  };

  useImperativeHandle(ref, () => ({ close }));

  const discard = async () => {
    finishing.current = true;
    try {
      const pendingDraft = await saveInFlight.current;
      const currentDraftId = draftId ?? pendingDraft?.draftId;
      if (currentDraftId)
        await window.fluxmail.drafts.delete({
          accountId,
          draftId: currentDraftId,
        });
    } catch (error) {
      finishing.current = false;
      onError(error instanceof Error ? error.message : "Fluxmail could not discard this draft.");
      return;
    }
    releaseAttachments();
    onClose();
  };

  const composer = (
    <section
      className={`compose-dialog ${inline ? "inline-draft-composer" : ""}`}
      role={inline ? undefined : "dialog"}
      aria-modal={inline ? undefined : true}
      aria-label={inline ? "Draft" : "New message"}
      onKeyDown={(event) => {
        if (event.metaKey && event.key === "Enter") {
          event.preventDefault();
          void send();
        }
        if (!inline && event.key === "Escape") void close();
      }}
    >
      <header>
        <strong className={inline ? "inline-draft-label" : undefined} title={composeTitle}>
          {inline ? "Draft" : composeTitle}
        </strong>
        <span>
          {saving
            ? inline
              ? "Saving..."
              : "Saving draft..."
            : draftId
              ? inline
                ? "Saved"
                : "Draft saved"
              : ""}
        </span>
        {!inline ? (
          <button className="icon-button" onClick={() => void close()} aria-label="Close compose">
            <X size={17} />
          </button>
        ) : null}
      </header>
      <div className="compose-fields">
        <SenderSelect
          accounts={senderAccounts}
          identities={sendAsIdentities}
          value={{ accountId, email: senderEmail }}
          lockAccount={Boolean(draftId) || saving}
          onChange={(choice) => {
            revision.current += 1;
            setAccountId(choice.accountId);
            setFrom(choice.email);
          }}
        />
        <div
          className="compose-recipients"
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !event.currentTarget.contains(next))
              setRecipientsCollapsed(true);
          }}
        >
          {recipientsCollapsed ? (
            <button
              type="button"
              className="recipient-summary"
              aria-label="Edit recipients"
              onClick={() => setRecipientsCollapsed(false)}
            >
              <span>To</span>
              <span className="truncate">
                {to || "No recipients"}
                {cc ? `, Cc: ${cc}` : ""}
                {bcc ? `, Bcc: ${bcc}` : ""}
              </span>
            </button>
          ) : (
            <>
              <label className="recipient-row">
                <span>To</span>
                <input
                  autoFocus={!seed.to}
                  value={to}
                  onFocus={() => setRecipientsCollapsed(false)}
                  onChange={(event) => {
                    revision.current += 1;
                    setTo(event.target.value);
                  }}
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
                    value={cc}
                    onFocus={() => setRecipientsCollapsed(false)}
                    onChange={(event) => {
                      revision.current += 1;
                      setCc(event.target.value);
                    }}
                  />
                </label>
              ) : null}
              {showBcc ? (
                <label className="recipient-row">
                  <span>Bcc</span>
                  <input
                    ref={bccRef}
                    value={bcc}
                    onFocus={() => setRecipientsCollapsed(false)}
                    onChange={(event) => {
                      revision.current += 1;
                      setBcc(event.target.value);
                    }}
                  />
                </label>
              ) : null}
            </>
          )}
        </div>
        <label>
          <span>Subject</span>
          <input
            value={subject}
            onChange={(event) => {
              revision.current += 1;
              setSubject(event.target.value);
            }}
          />
        </label>
      </div>
      <MailEditorContent
        editor={editor}
        empty={!text.trim()}
        placeholder="Write a message"
        className="compose-editor"
        onFocus={() => setRecipientsCollapsed(true)}
      />
      {quotedMessage ? (
        <div className="compose-quoted">
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
              <div className="quoted-reply-meta">{quotedReplyCitation(quotedMessage)}</div>
              <div className="quoted-reply-body">
                <EmailHtml
                  message={quotedMessage}
                  blockRemoteImages={blockRemoteImages}
                  imageRelay={imageRelay}
                  imageRelayAvailable={imageRelayAvailable}
                  onError={onError}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {attachments.length ? (
        <div className="compose-attachments">
          {attachments.map((attachment) => (
            <span key={attachment.token}>
              <Paperclip size={13} />
              {attachment.filename}
              <button
                aria-label={`Remove ${attachment.filename}`}
                onClick={() =>
                  setAttachments((current) => {
                    revision.current += 1;
                    return current.filter((item) => item.token !== attachment.token);
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <footer>
        <SendControls
          sending={sending}
          deliveryKind={deliveryKind}
          onSend={() => void send()}
          onSchedule={(sendAt) => void deliver("scheduled", { sendAt })}
          onError={onError}
        />
        <MailEditorToolbar
          editor={editor}
          onAttach={() =>
            void window.fluxmail.attachments
              .pick()
              .then((picked) => {
                if (!picked.length) return;
                if (attachments.length + picked.length > 20) {
                  releaseTokens(picked.map((attachment) => attachment.token));
                  onError("You can attach up to 20 files to a message.");
                  return;
                }
                for (const attachment of picked) attachmentTokens.current.add(attachment.token);
                revision.current += 1;
                setAttachments((current) => [...current, ...picked]);
              })
              .catch((error) =>
                onError(
                  error instanceof Error ? error.message : "Fluxmail could not attach these files.",
                ),
              )
          }
        />
        <button
          className="icon-button discard-button"
          onClick={() => void discard()}
          aria-label="Discard draft"
        >
          <Trash2 size={16} />
        </button>
      </footer>
    </section>
  );
  if (inline) return composer;
  return (
    <div
      className="modal-backdrop compose-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) void close();
      }}
    >
      {composer}
    </div>
  );
});

export function parseAddressField(value: string): {
  addresses: Array<{ name?: string; email: string }>;
  invalid: boolean;
} {
  const entries = splitAddressEntries(value);
  const addresses = entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const match = entry.match(/^(.*?)\s*<([^>]+)>$/);
      const email = (match?.[2] ?? entry).trim();
      const rawName = match?.[1]?.trim();
      const name =
        rawName?.startsWith('"') && rawName.endsWith('"')
          ? rawName.slice(1, -1).replaceAll('\\"', '"')
          : rawName;
      const address = { email, ...(name ? { name } : {}) };
      return addressSchema.safeParse(address).success ? [address] : [];
    });
  return {
    addresses,
    invalid: addresses.length !== entries.filter((entry) => entry.trim()).length,
  };
}

function splitAddressEntries(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (!quoted && character === "<") angleDepth += 1;
    if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (!quoted && angleDepth === 0 && (character === "," || character === ";")) {
      entries.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  entries.push(current);
  return entries;
}

/**
 * Seeds the editor with the reply itself. A saved reply carries the quoted message, and the
 * editor cannot round-trip the original markup, so the quote is left out here and appended again
 * from the original message when the reply is sent. That only reproduces the draft when the quote
 * belongs to the message this reply answers, so any other quote stays in the body.
 */
function composerBody(seed: ComposeSeed): {
  html: string;
  text: string;
  attachments: ComposeAttachment[];
} {
  const attachments = seed.initialAttachments ?? [];
  const saved = {
    html: seed.initialHtml ?? htmlFromText(seed.initialText ?? ""),
    text: seed.initialText ?? textFromHtml(seed.initialHtml),
    attachments,
  };
  if (!seed.replyToMessageId) return saved;
  const replyHtml = seed.initialHtml ? replyWithoutQuotedHtml(seed.initialHtml) : undefined;
  const replyText =
    seed.initialText === undefined ? undefined : replyWithoutQuotedText(seed.initialText);
  const quoted = Boolean(replyHtml?.quoted || replyText?.quoted);
  if (quoted && seed.quotedMessageId !== seed.replyToMessageId) return saved;
  const text = replyText ? replyText.text : textFromHtml(replyHtml?.html);
  const html = replyHtml?.html ?? htmlFromText(text);
  return {
    html,
    text,
    attachments: quoted ? attachmentsWithoutQuotedInline(attachments, html) : attachments,
  };
}

function textFromHtml(value?: string): string {
  if (!value) return "";
  const document = new DOMParser().parseFromString(value, "text/html");
  return document.body.textContent?.trim() ?? "";
}

function htmlFromText(value: string): string {
  const escaped = value.replace(
    /[&<>]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!,
  );
  return `<p>${escaped.replaceAll("\n", "<br>")}</p>`;
}

export function replyRecipient(accountEmail: string, message: MailMessage): string {
  const ownAddress = accountEmail.toLowerCase();
  const externalReplyTargets = replyTargets(message).filter(
    (address) => address.email.toLowerCase() !== ownAddress,
  );
  if (externalReplyTargets.length) return externalReplyTargets.map(formatAddress).join(", ");
  const recipient = message.to.find((address) => address.email.toLowerCase() !== ownAddress);
  return formatAddress(recipient);
}

export function canCloseForward(
  hasUnsavedChanges: boolean,
  confirmDiscard: () => boolean = () => window.confirm("Discard this unsent forward?"),
): boolean {
  return !hasUnsavedChanges || confirmDiscard();
}

function formatAddress(address?: { name?: string; email: string }): string {
  if (!address) return "";
  if (!address.name) return address.email;
  const name = /[,;"]/.test(address.name)
    ? `"${address.name.replaceAll('"', '\\"')}"`
    : address.name;
  return `${name} <${address.email}>`;
}

export function formatAddresses(addresses?: Array<{ name?: string; email: string }>): string {
  return (addresses ?? []).map(formatAddress).join(", ");
}
