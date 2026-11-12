import type { EmailAddress, Message, MessageBody } from "@fluxmail/core";
import { buildQuotedReplyBody } from "../quoted-reply";
import type { DemoPerson } from "./people";

export const DEMO_ACCOUNT_ID = "demo-gmail-account";
export const DEMO_ACCOUNT_EMAIL = "john@acme.example.com";
export const DEMO_ACCOUNT_NAME = "John Carter";

export interface DemoAttachmentSpec {
  filename: string;
  mimeType: string;
  size: number;
}

export interface DemoMessageSpec {
  from: DemoPerson | "me";
  to?: string;
  cc?: string;
  at: { days: number; time?: string };
  html: string;
  isRead?: boolean;
  attachments?: DemoAttachmentSpec[];
  labelIds?: string[];
}

export interface DemoThreadSpec {
  id: string;
  subject: string | null;
  messages: DemoMessageSpec[];
  labelIds?: string[];
  priorityReason?: string;
  isStarred?: boolean;
  archived?: boolean;
  sentOnly?: boolean;
}

function dateAt(anchor: Date, days: number, time = "09:00"): string {
  const [hours = 9, minutes = 0] = time.split(":").map(Number);
  const date = new Date(anchor);
  date.setDate(date.getDate() - days);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function address(email: string): EmailAddress {
  return { email };
}

function messageFolder(isFromUser: boolean, spec: DemoThreadSpec): Message["folder"] {
  if (isFromUser || spec.sentOnly) return { id: "SENT", name: "Sent", role: "sent" };
  if (spec.archived) return { id: "ALL", name: "All mail", role: "all" };
  return { id: "INBOX", name: "Inbox", role: "inbox" };
}

type QuoteStyle = "gmail" | "outlook" | "apple";

const QUOTE_STYLES: QuoteStyle[] = ["gmail", "outlook", "apple"];

/**
 * Each sender's mail client quotes the message they answer, so replies carry the thread's history
 * the way real mail does. The user's replies use the quote Fluxmail sends, and other senders get
 * the Gmail, Outlook or Apple Mail format, chosen by address so a sender always uses one client.
 */
function quoteStyle(sender: DemoPerson | "me"): QuoteStyle {
  if (sender === "me") return "gmail";
  const sum = [...sender.email].reduce((total, character) => total + character.charCodeAt(0), 0);
  return QUOTE_STYLES[sum % QUOTE_STYLES.length];
}

function withQuotedHistory(reply: MessageBody, original: Message, style: QuoteStyle): MessageBody {
  if (style === "gmail") return buildQuotedReplyBody(reply, original);
  const from = original.from;
  const sender = from?.name ? `${from.name} <${from.email}>` : (from?.email ?? "");
  const date = new Date(original.date);
  const originalHtml = original.body?.html ?? "";
  const originalText = original.body?.text ?? "";
  if (style === "outlook") {
    const sent = date.toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const to = original.to.map((recipient) => recipient.name ?? recipient.email).join("; ");
    const header = [
      ["From", sender],
      ["Sent", sent],
      ["To", to],
      ["Subject", original.subject],
    ];
    return {
      text: `${reply.text}\n\n________________________________\n${header.map(([name, value]) => `${name}: ${value}`).join("\n")}\n\n${originalText}`,
      html:
        `${reply.html}<div><br></div><hr style="display:inline-block;width:98%" tabindex="-1">` +
        `<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" color="#000000" style="font-size:11pt">` +
        header.map(([name, value]) => `<b>${name}:</b> ${escapeHtml(value)}`).join("<br>") +
        `</font><div>&nbsp;</div></div><div>${originalHtml}</div>`,
    };
  }
  const attribution = `On ${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}, at ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}, ${sender} wrote:`;
  const quotedText = [attribution, "", ...originalText.split("\n")]
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return {
    text: `${reply.text}\n\n${quotedText}`,
    html:
      `${reply.html}<div><br><blockquote type="cite"><div>${escapeHtml(attribution)}</div><br>` +
      `<div>${originalHtml}</div></blockquote></div>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );
}

export function buildMessages(spec: DemoThreadSpec, anchor: Date): Message[] {
  const messages: Message[] = [];
  spec.messages.forEach((messageSpec, index) => {
    const isFromUser = messageSpec.from === "me";
    const person: DemoPerson | undefined = messageSpec.from === "me" ? undefined : messageSpec.from;
    const id = `${spec.id}-m${index + 1}`;
    const previousId = index > 0 ? `${spec.id}-m${index}` : undefined;
    const text = plainTextFromHtml(messageSpec.html);
    const isRead = messageSpec.isRead ?? (isFromUser || index < spec.messages.length - 1);

    const reply = { text, html: messageSpec.html.trim() };
    const previous = messages.at(-1);
    const message: Message = {
      id,
      threadId: spec.id,
      accountId: DEMO_ACCOUNT_ID,
      folder: messageFolder(isFromUser, spec),
      labels: [...new Set([...(spec.labelIds ?? []), ...(messageSpec.labelIds ?? [])])],
      from: isFromUser
        ? { name: DEMO_ACCOUNT_NAME, email: DEMO_ACCOUNT_EMAIL }
        : { name: person!.name, email: person!.email },
      to: isFromUser
        ? [address(messageSpec.to ?? DEMO_ACCOUNT_EMAIL)]
        : [{ name: DEMO_ACCOUNT_NAME, email: DEMO_ACCOUNT_EMAIL }],
      ...(messageSpec.cc ? { cc: [address(messageSpec.cc)] } : {}),
      subject: spec.subject ?? "",
      date: dateAt(anchor, messageSpec.at.days, messageSpec.at.time),
      snippet: text.slice(0, 200),
      body: reply,
      attachments: (messageSpec.attachments ?? []).map((attachment, attachmentIndex) => ({
        id: `${spec.id}-att${index + 1}-${attachmentIndex + 1}`,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.size,
        disposition: "attachment",
      })),
      flags: { read: isRead, starred: Boolean(spec.isStarred), draft: false },
      headers: {
        "Message-ID": `<${id}@acme.example.com>`,
        ...(previousId
          ? {
              "In-Reply-To": `<${previousId}@acme.example.com>`,
              References: Array.from(
                { length: index },
                (_, referenceIndex) => `<${spec.id}-m${referenceIndex + 1}@acme.example.com>`,
              ).join(" "),
            }
          : {}),
      },
    };
    if (previous) message.body = withQuotedHistory(reply, previous, quoteStyle(messageSpec.from));
    messages.push(message);
  });
  return messages;
}
