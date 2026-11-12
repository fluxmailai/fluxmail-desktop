import type { Message } from "@fluxmail/core";

export const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
export const HIDDEN_TAGS = new Set(["head", "script", "style", "template"]);
export const QUOTED_REPLY_CLASSES = new Set([
  "gmail_quote",
  "gmail_quote_container",
  "moz-cite-prefix",
  "protonmail_quote",
  "yahoo_quoted",
]);
export const QUOTED_REPLY_IDS = new Set(["divrplyfwdmsg"]);

const QUOTED_TEXT_PATTERNS = [
  // The quoted lines lose their "> " markers once an editor rewrites the draft, so the attribution
  // line alone ends the reply.
  /(?:^|\n)On [^\n]+ wrote:\s*(?:\n|$)/i,
  /(?:^|\n)-{2,}\s*Original Message\s*-{2,}(?:\n|$)/i,
];
const ON_ATTRIBUTION = String.raw`On\b[^\n]{0,300}\bwrote:`;
// The dashes are bounded so a long run of them can't make the unanchored search quadratic.
const ORIGINAL_MESSAGE_SEPARATOR = String.raw`-{2,20}\s*Original Message\s*-{2,20}`;
// Only the "On" form needs a word boundary; one in front of the dashes would need a letter there.
const TRAILING_ATTRIBUTION_PATTERN = new RegExp(
  `(?:\\b${ON_ATTRIBUTION}|${ORIGINAL_MESSAGE_SEPARATOR})\\s*$`,
  "i",
);
const WHOLE_ATTRIBUTION_PATTERN = new RegExp(
  `^(?:${ON_ATTRIBUTION}|${ORIGINAL_MESSAGE_SEPARATOR})$`,
  "i",
);

export function quotedReplyCitation(original: Message): string {
  const sender = original.from?.name
    ? `${original.from.name} <${original.from.email}>`
    : (original.from?.email ?? "unknown sender");
  return `On ${formatQuotedReplyDate(original.date)} ${sender} wrote:`;
}

/** Drops the quoted history from a plain-text reply, keeping only what the sender wrote. */
export function replyWithoutQuotedText(text: string): { text: string; quoted: boolean } {
  const normalized = text.replace(/\r\n?/g, "\n");
  const start = QUOTED_TEXT_PATTERNS.reduce((earliest, pattern) => {
    const index = normalized.search(pattern);
    return index >= 0 && index < earliest ? index : earliest;
  }, normalized.length);
  return { text: normalized.slice(0, start).trimEnd(), quoted: start < normalized.length };
}

/** Normalizes the spacing that differs between a citation and its rendered markup. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

/** The attribution line that ends the text, when it ends with one. */
export function trailingQuoteAttribution(text: string): string | undefined {
  return TRAILING_ATTRIBUTION_PATTERN.exec(text.trimEnd())?.[0];
}

/** True when text is nothing but the attribution line that introduces a quoted message. */
export function isQuoteAttribution(text: string): boolean {
  return WHOLE_ATTRIBUTION_PATTERN.test(text.trim());
}

export function referencedInlineContentIds(html: string | undefined): Set<string> {
  const contentIds = new Set<string>();
  for (const match of html?.matchAll(/\bcid:([^"'()\s<>]+)/gi) ?? []) {
    let value = match[1];
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep malformed percent escapes as-is so they can still match provider metadata.
    }
    contentIds.add(normalizeContentId(value));
  }
  return contentIds;
}

export function normalizeContentId(value: string): string {
  return value.replace(/^<|>$/g, "").toLowerCase();
}

function formatQuotedReplyDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const formattedDate = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const formattedTime = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${formattedDate} at ${formattedTime}`;
}
