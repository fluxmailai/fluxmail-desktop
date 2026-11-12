import type { ComposeAttachment, MailMessage } from "../../shared/contracts";
import {
  BLOCK_TAGS,
  collapseWhitespace,
  HIDDEN_TAGS,
  isQuoteAttribution,
  normalizeContentId,
  QUOTED_REPLY_CLASSES,
  QUOTED_REPLY_IDS,
  quotedReplyCitation,
  referencedInlineContentIds,
  trailingQuoteAttribution,
} from "../../shared/quoted-reply";

/**
 * Drops the quoted history from a saved reply so the composer only edits what the sender wrote.
 * The quote is rebuilt from the original message when the reply is sent, which keeps the original
 * formatting intact instead of running it through the rich-text editor.
 */
export function replyWithoutQuotedHtml(html: string): { html: string; quoted: boolean } {
  const document = new DOMParser().parseFromString(html, "text/html");
  const marker = findQuotedReplyMarker(document.body);
  if (!marker) return { html, quoted: false };
  removeFromNode(marker, document.body);
  removeTrailingAttribution(document.body);
  return { html: document.body.innerHTML, quoted: true };
}

/**
 * The message a saved draft quotes, found by the citation the quote carries. A draft written by
 * another client can cite the original in a form Fluxmail does not produce, which leaves the quote
 * unattributed rather than attributed to the wrong message.
 */
export function quotedReplyTarget<T extends MailMessage>(
  body: { html?: string; text?: string } | undefined,
  candidates: T[],
): T | undefined {
  if (!body?.html && !body?.text) return undefined;
  const quoted = collapseWhitespace(`${body.text ?? ""}\n${body.html ? plainText(body.html) : ""}`);
  return candidates.find((candidate) =>
    quoted.includes(collapseWhitespace(quotedReplyCitation(candidate))),
  );
}

/** Drops inline attachments that only the removed quote referenced. */
export function attachmentsWithoutQuotedInline(
  attachments: ComposeAttachment[],
  html: string,
): ComposeAttachment[] {
  const referenced = referencedInlineContentIds(html);
  return attachments.filter(
    (attachment) =>
      attachment.disposition !== "inline" ||
      !attachment.contentId ||
      referenced.has(normalizeContentId(attachment.contentId)),
  );
}

function plainText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

/** How much of the preceding text the attribution check needs to see. */
const ATTRIBUTION_CONTEXT = 1000;

/**
 * The element where the quoted history starts. For a received message (`received`), an
 * attribution counts only when a quote follows it and it is a line of its own that names a date
 * or an address, as mail clients write them, so prose such as "On pricing, Sam wrote:" or "here is
 * what Dana wrote:" is not mistaken for one.
 */
function findQuotedReplyMarker(root: HTMLElement, received = false): Element | undefined {
  // Keep only the end of the preceding text, so the walk stays linear in long messages.
  let tail = "";
  const append = (text: string) => {
    // Collapsing whitespace keeps padded markup from pushing an attribution out of the window.
    const collapsed = text.replace(/\s+/g, (space) => (space.includes("\n") ? "\n" : " "));
    tail += collapsed;
    if (tail.length > 2 * ATTRIBUTION_CONTEXT) tail = tail.slice(-ATTRIBUTION_CONTEXT);
  };
  const visit = (node: Node): Element | undefined => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? "");
      return undefined;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
    const element = node as Element;
    const tagName = element.tagName.toLowerCase();
    if (HIDDEN_TAGS.has(tagName)) return undefined;
    if (isQuoteMarker(element, tail, received)) return element;
    if (tagName === "br") {
      append("\n");
      return undefined;
    }
    const block = BLOCK_TAGS.has(tagName);
    if (block) append("\n");
    for (const child of element.childNodes) {
      const marker = visit(child);
      if (marker) return marker;
    }
    if (block) append("\n");
    return undefined;
  };
  for (const child of root.childNodes) {
    const marker = visit(child);
    if (marker) return marker;
  }
  return undefined;
}

function isQuoteMarker(element: Element, textBefore: string, received: boolean): boolean {
  const classes = (element.getAttribute("class") ?? "").toLowerCase().split(/\s+/);
  if (
    classes.some(
      (className) => QUOTED_REPLY_CLASSES.has(className) || className === PLAIN_TEXT_QUOTE_CLASS,
    )
  )
    return true;
  const id = element.getAttribute("id")?.toLowerCase();
  if (id && QUOTED_REPLY_IDS.has(id)) return true;
  // An editor that rewrote the draft can strip the quote markup and leave the attribution line
  // in front of the loose quoted blocks, so cut from the attribution itself.
  if (
    !received &&
    BLOCK_TAGS.has(element.tagName.toLowerCase()) &&
    element.nextSibling &&
    isQuoteAttribution(element.textContent ?? "")
  )
    return true;
  if (element.tagName !== "BLOCKQUOTE") return false;
  if (element.getAttribute("type")?.toLowerCase() === "cite") return true;
  // Only treat an unmarked blockquote as history when an attribution introduces it, so quotes
  // the sender wrote themselves stay.
  if (!received) return trailingQuoteAttribution(textBefore) !== undefined;
  return isReceivedAttribution(textBefore.trimEnd().split("\n").at(-1)!.trim());
}

/** True when a line is an attribution the way mail clients write one. */
function isReceivedAttribution(line: string): boolean {
  if (ORIGINAL_MESSAGE_LINE.test(line)) return true;
  return /^On\b/.test(line) && isQuoteAttribution(line) && /[\d@]/.test(line);
}

/** Text preceding a node, with block boundaries kept as line breaks. */
function textBefore(element: Node, root: HTMLElement): string {
  const parts: string[] = [];
  const visit = (node: Node): boolean => {
    if (node === element) return true;
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return false;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const tagName = (node as Element).tagName.toLowerCase();
    if (HIDDEN_TAGS.has(tagName)) return false;
    if (tagName === "br") {
      parts.push("\n");
      return false;
    }
    if (BLOCK_TAGS.has(tagName)) parts.push("\n");
    for (const child of node.childNodes) {
      if (visit(child)) return true;
    }
    if (BLOCK_TAGS.has(tagName)) parts.push("\n");
    return false;
  };

  for (const child of root.childNodes) {
    if (visit(child)) break;
  }
  return parts.join("");
}

function removeFromNode(marker: Element, root: HTMLElement): void {
  for (const node of nodesFrom(marker, root)) node.parentNode?.removeChild(node);
}

function removeTrailingAttribution(root: HTMLElement): void {
  removeTrailingBreaks(root);
  const last = root.lastElementChild;
  if (last && last === root.lastChild && isQuoteAttribution(last.textContent ?? "")) {
    last.remove();
    removeTrailingBreaks(root);
  }
}

function removeTrailingBreaks(root: HTMLElement): void {
  let node = root.lastChild;
  while (node && (isBlankText(node) || isLineBreak(node))) {
    const previous = node.previousSibling;
    node.remove();
    node = previous;
  }
}

function isBlankText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && !node.textContent?.trim();
}

function isLineBreak(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR";
}

/** Marks the elements of a received message's quoted history so the message view can hide them. */
export const QUOTED_HISTORY_ATTRIBUTE = "data-fluxmail-quoted";
/** Wraps the quoted history found in a plain-text message once it is converted to HTML. */
export const PLAIN_TEXT_QUOTE_CLASS = "fluxmail_plain_quote";

const FORWARDED_HEADER = /^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/i;
const FORWARDED_INTRO = /(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)\s*$/i;
// Subject prefixes in the languages mail clients localize them to, after any "[EXT]"-style tags.
// "VS" is a Norwegian and Danish forward but a Finnish reply; it counts as a forward, so those
// replies stay open rather than hiding forwarded content.
const SUBJECT_TAGS = String.raw`^\s*(?:\[[^\]]*\]\s*)*`;
const FORWARDED_SUBJECT = new RegExp(
  `${SUBJECT_TAGS}(?:fwd?|wg|tr|rv|enc|vb|vl|vs|doorst|pd|i|转发|轉寄|転送)\\s*[:：]`,
  "i",
);
const REPLY_SUBJECT = new RegExp(
  `${SUBJECT_TAGS}(?:re|aw|sv|antw|odp|r|rif|ynt|回复|答复|回覆|返信)\\s*[:：]`,
  "i",
);
/** How much text next to the quote the forwarded-message checks read. */
const FORWARD_CONTEXT = 200;
const ORIGINAL_MESSAGE_LINE = /^-{2,}\s*Original Message\s*-{2,}$/i;
const OUTLOOK_SEPARATOR_LINE = /^_{10,}$/;

/** True when a subject names a forwarded message, whose quoted content is the point of it. */
export function isForwardedSubject(subject: string | undefined): boolean {
  return FORWARDED_SUBJECT.test(subject ?? "");
}

/** True when a subject names a reply. */
export function isReplySubject(subject: string | undefined): boolean {
  return REPLY_SUBJECT.test(subject ?? "");
}

/** Removes quote markers a sender put in a message, so only Fluxmail's own markers hide text. */
export function clearQuotedHistoryMarkers(root: HTMLElement): void {
  for (const element of root.querySelectorAll(`[${QUOTED_HISTORY_ATTRIBUTE}]`))
    element.removeAttribute(QUOTED_HISTORY_ATTRIBUTE);
}

/**
 * Marks the quoted history in a received message and returns whether it found any. What the
 * sender wrote after the quote, such as a signature, a list footer or a bottom-posted answer,
 * stays visible, even inside the quote's container. The message is left alone when it is a
 * forwarded message, when nothing but the quote would be left, or when the sender answered
 * between quoted passages. Outlook-style quotes carry no markup that separates an inline answer
 * from the quote, so they are hidden to the end.
 */
export function markQuotedHistory(root: HTMLElement): boolean {
  const marker = findQuotedReplyMarker(root, true);
  if (!marker) return false;
  const start = quotedHistoryStart(marker);
  const before = textBefore(start, root);
  if (FORWARDED_INTRO.test(before.trimEnd().slice(-FORWARD_CONTEXT))) return false;
  const nodes = nodesFrom(start, root);
  if (FORWARDED_HEADER.test(leadingText(nodes))) return false;
  const quote = quotedHistoryExtent(nodes, start, marker, root);
  if (!quote) return false;
  if (!before.trim() && !hasImageBefore(start, root) && !quote.contentAfter) return false;
  hideThrough(nodes, quote.last);
  return true;
}

function leadingText(nodes: Node[]): string {
  let text = "";
  for (const node of nodes) {
    text += node.textContent ?? "";
    if (text.length >= FORWARD_CONTEXT) break;
  }
  return text.slice(0, FORWARD_CONTEXT);
}

/**
 * The last node of the quote, or none when it runs to the end, and whether the sender wrote
 * anything after it. Undefined when the sender answered between quoted passages. Quoted text is
 * text in a blockquote, in the attribution and separators before the marker, or in a quote
 * container that holds no blockquote of its own.
 */
function quotedHistoryExtent(
  nodes: Node[],
  start: Node,
  marker: Element,
  root: HTMLElement,
): { last?: Node; contentAfter: boolean } | undefined {
  if (QUOTED_REPLY_IDS.has(marker.id.toLowerCase())) return { contentAfter: false };
  if (!introducedAsHistory(marker, nodes, root)) return undefined;
  const intro = new Set(nodes.slice(0, nodes.indexOf(marker)));
  const containerQuotes = marker.tagName !== "BLOCKQUOTE" && !marker.querySelector("blockquote");
  let lastQuoted: Node | undefined;
  let answered = false;
  for (const node of nodes) {
    for (const text of textNodes(node)) {
      if (!isVisibleText(text)) continue;
      const quoted =
        intro.has(node) ||
        Boolean(text.parentElement?.closest("blockquote")) ||
        (containerQuotes && marker.contains(text));
      if (!quoted) {
        if (lastQuoted) answered = true;
        continue;
      }
      if (answered) return undefined;
      lastQuoted = text;
    }
  }
  // A quote without text, such as a quoted photo, ends with its marker.
  let last: Node =
    lastQuoted && marker.compareDocumentPosition(lastQuoted) & Node.DOCUMENT_POSITION_FOLLOWING
      ? lastQuoted
      : marker;
  // The quote runs to the end of its blockquote or container, so a logo after its last line stays
  // hidden with it.
  if (containerQuotes && marker.contains(last)) last = marker;
  for (
    let element = last.parentElement;
    element && element !== root && (element === start || !element.contains(start));
    element = element.parentElement
  )
    if (element.tagName === "BLOCKQUOTE") last = element;
  // Widen to the enclosing elements that hold nothing after it, so no empty quote box is left.
  for (
    let parent = last.parentNode;
    parent &&
    parent !== root &&
    (parent === start || !parent.contains(start)) &&
    !hasContentAfter(last);
    parent = last.parentNode
  )
    last = parent;
  return { last, contentAfter: nodes.some((node) => hasContentFollowing(node, last)) };
}

/**
 * True unless the marker is a blockquote with no attribution before it or on its first line. Mail
 * clients quote history with an attribution, while a passage the sender quoted with Gmail's or
 * Apple Mail's quote formatting has none. The attribution can be in any language, so a line that
 * ends with a colon and names a date or an address counts.
 */
function introducedAsHistory(marker: Element, nodes: Node[], root: HTMLElement): boolean {
  if (marker.tagName !== "BLOCKQUOTE") return true;
  if (nodes.slice(0, nodes.indexOf(marker)).some((node) => node.textContent?.trim())) return true;
  const lineBefore = textBefore(marker, root).trimEnd().split("\n").at(-1) ?? "";
  const firstLine =
    blockText(marker)
      .split("\n")
      .find((line) => line.trim()) ?? "";
  return [lineBefore, firstLine].some(
    (line) => line.trim().length <= 400 && /[:：]\s*$/.test(line.trim()) && /[\d@]/.test(line),
  );
}

/** The text of a node, with block boundaries kept as line breaks. */
function blockText(node: Node): string {
  // textBefore walks the whole subtree when the node it stops at is the root itself.
  return textBefore(node, node as HTMLElement);
}

function isVisibleText(text: Node): boolean {
  const parent = text.parentElement;
  return (
    Boolean(text.textContent?.trim()) && !(parent && HIDDEN_TAGS.has(parent.tagName.toLowerCase()))
  );
}

/** True when a later sibling of the node has content. */
function hasContentAfter(node: Node): boolean {
  for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling)
    if (hasContent(sibling)) return true;
  return false;
}

/** True when the node has visible text or media that comes after `last` and is not inside it. */
function hasContentFollowing(node: Node, last: Node): boolean {
  const follows = (candidate: Node) =>
    Boolean(last.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) &&
    !last.contains(candidate);
  if (textNodes(node).some((text) => isVisibleText(text) && follows(text))) return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return [element, ...element.querySelectorAll(MEDIA)].some(
    (candidate) => candidate.matches(MEDIA) && follows(candidate),
  );
}

/** Hides the nodes up to and including `last`, descending into the one that contains it. */
function hideThrough(nodes: Node[], last: Node | undefined): void {
  for (const node of nodes) {
    if (last && node !== last && node.contains(last)) {
      hideThrough([...node.childNodes], last);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      (node as Element).setAttribute(QUOTED_HISTORY_ATTRIBUTE, "");
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      const wrapper = node.ownerDocument!.createElement("span");
      wrapper.setAttribute(QUOTED_HISTORY_ATTRIBUTE, "");
      node.parentNode!.replaceChild(wrapper, node);
      wrapper.append(node);
    }
    if (node === last) return;
  }
}

/**
 * Splits the quoted history out of a plain-text message: the lines from an attribution through the
 * quoted lines after it, the lines after an "Original Message" separator, or the one run of "> "
 * lines when it opens with an attribution or the message is a reply. Lines after the quote stay in
 * `after`. Returns undefined when there is no
 * quote, nothing else is left, or the sender answered between quoted lines.
 */
export function splitQuotedText(
  text: string,
  options: { reply?: boolean } = {},
): { body: string; quoted: string; after: string } | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const range = quotedTextRange(lines, options.reply ?? false);
  if (!range) return undefined;
  const body = lines.slice(0, range.start).join("\n").trimEnd();
  // Drop the blank lines after the quote but keep the indentation of the first line that follows.
  const after = lines
    .slice(range.end)
    .join("\n")
    .replace(/^\s*\n/, "")
    .trimEnd();
  if (!body.trim() && !after) return undefined;
  return { body, quoted: lines.slice(range.start, range.end).join("\n"), after };
}

function quotedTextRange(
  lines: string[],
  reply: boolean,
): { start: number; end: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (ORIGINAL_MESSAGE_LINE.test(line)) return { start: index, end: lines.length };
    if (OUTLOOK_SEPARATOR_LINE.test(line) && /^From:/i.test(lines[index + 1]?.trim() ?? ""))
      return { start: index, end: lines.length };
    if (isQuotedLine(line)) break;
    const next = lines[index + 1]?.trim() ?? "";
    // Clients wrap a long attribution onto a second line. A first line that ends a sentence, or a
    // second line that is an attribution of its own, is the sender's text instead.
    const wrapped =
      !/[.!?]$/.test(line) &&
      !isReceivedAttribution(next) &&
      isReceivedAttribution(`${line} ${next}`);
    const attributionEnd = isReceivedAttribution(line) ? index : wrapped ? index + 1 : undefined;
    if (attributionEnd === undefined) continue;
    const end = quotedRunEnd(lines, attributionEnd + 1);
    return end === undefined ? undefined : { start: index, end };
  }
  const start = lines.findIndex(isQuotedLine);
  if (start < 0) return undefined;
  // Apple Mail puts the attribution inside the quote, which marks it as history in any message.
  // Otherwise only a reply's trailing run counts, since "> " lines followed by more text are as
  // likely to be commands or a quotation the sender wrote.
  const attributed = isReceivedAttribution(lines[start].trimStart().replace(/^>\s*/, ""));
  const end = quotedRunEnd(lines, start);
  if (end === undefined) return undefined;
  if (!attributed && (!reply || lines.slice(end).some((line) => line.trim()))) return undefined;
  return { start, end };
}

/**
 * The end of the run of quoted lines that starts at `start`, past blank lines, or undefined when
 * the run is empty or quoted lines come back after the sender's own lines.
 */
function quotedRunEnd(lines: string[], start: number): number | undefined {
  let end = start;
  let quoted = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (isQuotedLine(line)) {
      quoted = true;
      end = index + 1;
      continue;
    }
    if (!line.trim()) continue;
    if (!quoted) return undefined;
    break;
  }
  if (!quoted || lines.slice(end).some(isQuotedLine)) return undefined;
  return end;
}

function isQuotedLine(line: string): boolean {
  return line.trimStart().startsWith(">");
}

/** Moves the start of the quote back over the separators and attribution that introduce it. */
function quotedHistoryStart(marker: Element): Node {
  let start: Node = marker;
  let previous = start.previousSibling;
  while (previous && introducesQuote(previous)) {
    start = previous;
    previous = start.previousSibling;
  }
  return start;
}

function introducesQuote(node: Node): boolean {
  if (node.nodeType === Node.COMMENT_NODE) return true;
  if (node.nodeType === Node.TEXT_NODE) return !node.textContent?.trim();
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (element.tagName === "BR" || element.tagName === "HR") return true;
  const text = element.textContent ?? "";
  if (isQuoteAttribution(text)) return true;
  return !text.trim() && !hasMedia(element);
}

const MEDIA = "img, svg, table";

function hasMedia(element: Element): boolean {
  return element.matches(MEDIA) || Boolean(element.querySelector(MEDIA));
}

function hasContent(node: Node): boolean {
  if (node.textContent?.trim()) return true;
  return node.nodeType === Node.ELEMENT_NODE && hasMedia(node as Element);
}

/** True when a picture comes before the quote. Spacers of a pixel or two don't count. */
function hasImageBefore(start: Node, root: HTMLElement): boolean {
  return [...root.querySelectorAll("img, svg")].some(
    (image) =>
      Boolean(start.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_PRECEDING) &&
      !image.contains(start) &&
      !["width", "height"].some((dimension) => {
        const size = Number.parseFloat(image.getAttribute(dimension) ?? "");
        return size >= 0 && size <= 2;
      }),
  );
}

/** The start node, its later siblings, and the later siblings of each of its ancestors. */
function nodesFrom(start: Node, root: HTMLElement): Node[] {
  const nodes: Node[] = [];
  for (let node: Node | null = start; node; node = node.nextSibling) nodes.push(node);
  for (let parent = start.parentNode; parent && parent !== root; parent = parent.parentNode) {
    for (let node = parent.nextSibling; node; node = node.nextSibling) nodes.push(node);
  }
  return nodes;
}

function textNodes(node: Node): Node[] {
  if (node.nodeType === Node.TEXT_NODE) return [node];
  const walker = node.ownerDocument!.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}
