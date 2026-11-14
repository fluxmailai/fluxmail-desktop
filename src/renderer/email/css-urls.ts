// Parsing for the CSS and srcset values in email. Email is untrusted, so everything here runs in
// time linear in its input: a regular expression that rescans the rest of the text for each match
// lets a crafted message freeze rendering.
//
// Tracker blocking relies on finding every image a browser would load, so the CSS scanner follows
// the CSS Syntax tokenizer (https://www.w3.org/TR/css-syntax-3/#tokenization). It decodes escapes
// in function names and URLs, skips comments and strings, and matches parentheses and braces the
// way a browser does, so text that only looks like `url(` or `image-set(` to a regular expression
// can't hide a later image.

export interface CssUrl {
  /** Index of the start of the `url(` function name, which may be escaped. */
  start: number;
  /** Index just past the closing parenthesis, or the end of the text when it isn't closed. */
  end: number;
  /** The URL with CSS escapes decoded. */
  url: string;
}

interface CssImageSetImage {
  start: number;
  end: number;
  url: string;
  /** True for a string candidate, false for a url(). */
  isString: boolean;
}

interface CssImageSetCandidate {
  start: number;
  end: number;
  /** The candidate's image, when it's a string or url() rather than another image function. */
  image?: CssImageSetImage;
}

interface CssImageSet {
  start: number;
  /** Index of the opening parenthesis. */
  open: number;
  end: number;
  candidates: CssImageSetCandidate[];
}

interface CssDeclaration {
  /** Lowercase property name, or the name as written for a custom property. */
  property: string;
  /** Whether the value has a remote url() or image-set() string. */
  remote: boolean;
  /** Custom properties the value references through var(). */
  references: string[];
}

interface CssScan {
  urls: CssUrl[];
  imageSets: CssImageSet[];
  declarations: CssDeclaration[];
}

type TokenKind =
  | "ident"
  | "function"
  | "url"
  | "string"
  | "colon"
  | "semicolon"
  | "comma"
  | "open-brace"
  | "close-brace"
  | "other";

interface Frame {
  kind: "block" | "function" | "url" | "image-set" | "var";
  closer: ")" | "]" | "}";
  start: number;
  open: number;
  /** True until the first token inside the frame. */
  awaitingFirst: boolean;
  /** The string in a quoted url(). */
  url?: string;
  /** The declaration the frame started in. */
  declaration?: number;
  /** For a url(): the image-set() candidate it is the image of. */
  candidateOf?: CssImageSetCandidate;
  /** For an image-set(): its candidates, and the one being read. */
  candidates?: CssImageSetCandidate[];
  candidate?: CssImageSetCandidate;
}

function isWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f"
  );
}

function isNewline(character: string | undefined): boolean {
  return character === "\n" || character === "\r" || character === "\f";
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isHexDigit(character: string | undefined): boolean {
  return (
    isDigit(character) ||
    (character !== undefined &&
      ((character >= "a" && character <= "f") || (character >= "A" && character <= "F")))
  );
}

function isNameStart(character: string | undefined): boolean {
  if (character === undefined) return false;
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z") ||
    character === "_" ||
    character.charCodeAt(0) >= 0x80
  );
}

function isNameCharacter(character: string | undefined): boolean {
  return isNameStart(character) || isDigit(character) || character === "-";
}

function isNonPrintable(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
}

function isValidEscape(css: string, index: number): boolean {
  return css[index] === "\\" && !isNewline(css[index + 1]);
}

function startsIdent(css: string, index: number): boolean {
  const character = css[index];
  if (character === "-") {
    const next = css[index + 1];
    return isNameStart(next) || next === "-" || isValidEscape(css, index + 1);
  }
  return isNameStart(character) || isValidEscape(css, index);
}

function startsNumber(css: string, index: number): boolean {
  let character = css[index];
  if (character === "+" || character === "-") character = css[++index];
  return isDigit(character) || (character === "." && isDigit(css[index + 1]));
}

// Consumes the escape whose backslash is at `index`, which must be a valid escape.
function consumeEscape(css: string, index: number): { value: string; next: number } {
  let position = index + 1;
  if (position >= css.length) return { value: "�", next: position };
  if (isHexDigit(css[position])) {
    const hexStart = position;
    while (position < css.length && position - hexStart < 6 && isHexDigit(css[position]))
      position += 1;
    const code = Number.parseInt(css.slice(hexStart, position), 16);
    if (css[position] === "\r" && css[position + 1] === "\n") position += 2;
    else if (isWhitespace(css[position])) position += 1;
    const valid = code !== 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return { value: valid ? String.fromCodePoint(code) : "�", next: position };
  }
  const value = String.fromCodePoint(css.codePointAt(position)!);
  return { value, next: position + value.length };
}

function consumeName(css: string, index: number): { name: string; next: number } {
  let name = "";
  let position = index;
  while (position < css.length) {
    if (isNameCharacter(css[position])) {
      name += css[position];
      position += 1;
    } else if (isValidEscape(css, position)) {
      const escape = consumeEscape(css, position);
      name += escape.value;
      position = escape.next;
    } else break;
  }
  return { name, next: position };
}

function consumeNumber(css: string, index: number): number {
  let position = index;
  if (css[position] === "+" || css[position] === "-") position += 1;
  while (isDigit(css[position])) position += 1;
  if (css[position] === "." && isDigit(css[position + 1])) {
    position += 1;
    while (isDigit(css[position])) position += 1;
  }
  if (css[position] === "e" || css[position] === "E") {
    const sign = css[position + 1] === "+" || css[position + 1] === "-" ? 1 : 0;
    if (isDigit(css[position + 1 + sign])) {
      position += 1 + sign;
      while (isDigit(css[position])) position += 1;
    }
  }
  if (startsIdent(css, position)) return consumeName(css, position).next;
  return css[position] === "%" ? position + 1 : position;
}

// Consumes a string starting at its opening quote. A string ends at the matching quote or the end
// of the text. An unescaped newline makes it a bad string, which ends before the newline.
function consumeString(
  css: string,
  index: number,
): { value: string; next: number; valid: boolean } {
  const quote = css[index];
  let value = "";
  let position = index + 1;
  while (position < css.length) {
    const character = css[position]!;
    if (character === quote) return { value, next: position + 1, valid: true };
    if (isNewline(character)) return { value, next: position, valid: false };
    if (character === "\\") {
      const next = css[position + 1];
      if (next === undefined) position += 1;
      else if (isNewline(next)) position += next === "\r" && css[position + 2] === "\n" ? 3 : 2;
      else {
        const escape = consumeEscape(css, position);
        value += escape.value;
        position = escape.next;
      }
      continue;
    }
    value += character;
    position += 1;
  }
  return { value, next: position, valid: true };
}

// Consumes an unquoted url() from just after its opening parenthesis and any whitespace. A bad URL,
// one with a quote, parenthesis, non-printable character, or whitespace before more text, loads
// nothing and runs to the next `)` that isn't escaped.
function consumeUnquotedUrl(
  css: string,
  index: number,
): { value: string; next: number; valid: boolean } {
  let value = "";
  let position = index;
  while (position < css.length) {
    const character = css[position]!;
    if (character === ")") return { value, next: position + 1, valid: true };
    if (isWhitespace(character)) {
      while (isWhitespace(css[position])) position += 1;
      if (position >= css.length) return { value, next: position, valid: true };
      if (css[position] === ")") return { value, next: position + 1, valid: true };
      break;
    }
    if (character === '"' || character === "'" || character === "(" || isNonPrintable(character))
      break;
    if (character === "\\") {
      if (!isValidEscape(css, position)) break;
      const escape = consumeEscape(css, position);
      value += escape.value;
      position = escape.next;
      continue;
    }
    value += character;
    position += 1;
  }
  if (position >= css.length) return { value, next: position, valid: true };
  while (position < css.length) {
    if (css[position] === ")") return { value, next: position + 1, valid: false };
    position = isValidEscape(css, position) ? consumeEscape(css, position).next : position + 1;
  }
  return { value, next: position, valid: false };
}

// The kind of frame a function opens, from its lowercase name.
function functionKind(name: string): Frame["kind"] {
  if (name === "url" || name === "var") return name;
  if (name === "image-set" || name === "-webkit-image-set") return "image-set";
  return "function";
}

// True for a URL a browser would load from the network rather than from the message itself.
function isRemoteImageUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function scanCss(css: string): CssScan {
  const urls: CssUrl[] = [];
  const imageSets: CssImageSet[] = [];
  const declarations: CssDeclaration[] = [];
  const stack: Frame[] = [];
  const openDeclarations: { index: number; depth: number }[] = [];
  let atDeclarationStart = true;
  let pendingProperty: string | undefined;
  let pendingDepth = 0;

  const currentDeclaration = () => openDeclarations.at(-1)?.index;
  const markRemote = (declaration: number | undefined, url: string) => {
    if (declaration !== undefined && !declarations[declaration]!.remote && isRemoteImageUrl(url))
      declarations[declaration]!.remote = true;
  };
  const closeDeclarations = (fromDepth: number) => {
    while (openDeclarations.length && openDeclarations.at(-1)!.depth >= fromDepth)
      openDeclarations.pop();
  };
  const finishCandidate = (frame: Frame) => {
    if (frame.candidate) frame.candidates!.push(frame.candidate);
    frame.candidate = undefined;
  };

  // Handles a token that isn't whitespace or a comment, directly inside the top frame. Returns the
  // image-set() candidate the token starts, if any.
  const token = (
    kind: TokenKind,
    start: number,
    end: number,
    value = "",
  ): CssImageSetCandidate | undefined => {
    const property = pendingProperty;
    pendingProperty = undefined;
    if (property !== undefined && kind === "colon" && stack.length === pendingDepth) {
      declarations.push({ property, remote: false, references: [] });
      openDeclarations.push({ index: declarations.length - 1, depth: stack.length });
    } else if (atDeclarationStart && kind === "ident") {
      pendingProperty = value.startsWith("--") ? value : value.toLowerCase();
      pendingDepth = stack.length;
    }
    atDeclarationStart = false;

    const top = stack.at(-1);
    if (!top) return undefined;
    if (top.awaitingFirst) {
      top.awaitingFirst = false;
      if (top.kind === "url" && kind === "string") top.url = value;
      if (top.kind === "var" && kind === "ident" && value.startsWith("--"))
        declarations[currentDeclaration() ?? -1]?.references.push(value);
    }
    if (top.kind !== "image-set") return undefined;
    if (kind === "comma") {
      finishCandidate(top);
      return undefined;
    }
    if (top.candidate) {
      top.candidate.end = end;
      return undefined;
    }
    const candidate: CssImageSetCandidate = { start, end };
    if (kind === "string" || kind === "url")
      candidate.image = { start, end, url: value, isString: kind === "string" };
    if (kind === "string") markRemote(currentDeclaration(), value);
    top.candidate = candidate;
    return candidate;
  };

  const push = (frame: Omit<Frame, "awaitingFirst" | "declaration">) =>
    stack.push({ ...frame, awaitingFirst: true, declaration: currentDeclaration() });

  const pop = (end: number) => {
    const frame = stack.pop()!;
    if (frame.kind === "url" && frame.url !== undefined) {
      urls.push({ start: frame.start, end, url: frame.url });
      markRemote(frame.declaration, frame.url);
      if (frame.candidateOf)
        frame.candidateOf.image = { start: frame.start, end, url: frame.url, isString: false };
    }
    if (frame.kind === "image-set") {
      finishCandidate(frame);
      imageSets.push({
        start: frame.start,
        open: frame.open,
        end,
        candidates: frame.candidates!,
      });
    }
    closeDeclarations(stack.length + 1);
    const parent = stack.at(-1);
    if (parent?.candidate) parent.candidate.end = end;
  };

  let index = 0;
  while (index < css.length) {
    const character = css[index]!;
    const start = index;

    if (character === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      index = close === -1 ? css.length : close + 2;
      continue;
    }
    if (isWhitespace(character)) {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const string = consumeString(css, index);
      index = string.next;
      token(string.valid ? "string" : "other", start, index, string.value);
      continue;
    }
    if (startsNumber(css, index)) {
      index = consumeNumber(css, index);
      token("other", start, index);
      continue;
    }
    if (css.startsWith("-->", index) || css.startsWith("<!--", index)) {
      index += character === "-" ? 3 : 4;
      token("other", start, index);
      continue;
    }
    if (startsIdent(css, index)) {
      const { name, next } = consumeName(css, index);
      if (css[next] !== "(") {
        index = next;
        token("ident", start, index, name);
        continue;
      }
      const functionName = name.toLowerCase();
      if (functionName === "url") {
        let argument = next + 1;
        while (isWhitespace(css[argument])) argument += 1;
        if (css[argument] !== '"' && css[argument] !== "'") {
          const url = consumeUnquotedUrl(css, argument);
          index = url.next;
          if (!url.valid) {
            token("other", start, index);
            continue;
          }
          urls.push({ start, end: index, url: url.value });
          markRemote(currentDeclaration(), url.value);
          token("url", start, index, url.value);
          continue;
        }
      }
      const candidate = token("function", start, next + 1);
      const kind = functionKind(functionName);
      push({
        kind,
        closer: ")",
        start,
        open: next,
        candidates: kind === "image-set" ? [] : undefined,
        candidateOf: kind === "url" ? candidate : undefined,
      });
      index = next + 1;
      continue;
    }
    if (
      (character === "#" && (isNameCharacter(css[index + 1]) || isValidEscape(css, index + 1))) ||
      (character === "@" && startsIdent(css, index + 1))
    ) {
      index = consumeName(css, index + 1).next;
      token("other", start, index);
      continue;
    }
    if (character === "\\") {
      index += 1;
      token("other", start, index);
      continue;
    }

    index += 1;
    const top = stack.at(-1);
    if (top && character === top.closer) {
      if (character === "}") token("close-brace", start, index);
      pop(index);
      if (character === "}") atDeclarationStart = true;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      token(character === "{" ? "open-brace" : "other", start, index);
      push({
        kind: "block",
        closer: character === "(" ? ")" : character === "[" ? "]" : "}",
        start,
        open: start,
      });
      if (character === "{") atDeclarationStart = true;
      continue;
    }
    if (character === ";") {
      token("semicolon", start, index);
      closeDeclarations(stack.length);
      atDeclarationStart = true;
      continue;
    }
    token(character === ":" ? "colon" : character === "," ? "comma" : "other", start, index);
  }
  // The end of the text closes everything still open.
  while (stack.length) pop(css.length);

  urls.sort((a, b) => a.start - b.start);
  imageSets.sort((a, b) => a.start - b.start);
  return { urls, imageSets, declarations };
}

/** Finds every url() a browser would load from CSS text, with escapes in each URL decoded. */
export function findCssUrls(css: string): CssUrl[] {
  return scanCss(css).urls;
}

/** Lists the images CSS text loads through url() and image-set() strings, in order. */
export function findCssImageUrls(css: string): string[] {
  const { urls, imageSets } = scanCss(css);
  const images = [
    ...urls,
    ...imageSets.flatMap(({ candidates }) =>
      candidates.flatMap(({ image }) => (image?.isString ? [image] : [])),
    ),
  ].sort((a, b) => a.start - b.start);
  return images.map(({ url }) => url.trim()).filter(Boolean);
}

export interface CssImageRewrite {
  /** Returns the text to put in place of a url(), or undefined to keep it. */
  url?(url: string): string | undefined;
  /** Returns the text to put in place of an image-set() string candidate, or undefined to keep it. */
  imageSetString?(url: string): string | undefined;
  /**
   * Returns true to drop an image-set() candidate whose image is this string or url(). An image-set()
   * with every candidate dropped becomes `none`.
   */
  removeImageSetCandidate?(url: string): boolean;
}

/** Rewrites the images in CSS text. Each callback runs once per image, in order. */
export function rewriteCssImages(css: string, rewrite: CssImageRewrite): string {
  const { urls, imageSets } = scanCss(css);
  type Node =
    | { kind: "url"; start: number; end: number; url: string }
    | { kind: "string"; start: number; end: number; url: string }
    | ({ kind: "image-set" } & CssImageSet);
  const nodes: Node[] = [
    ...urls.map((url) => ({ kind: "url" as const, ...url })),
    ...imageSets.map((imageSet) => ({ kind: "image-set" as const, ...imageSet })),
    ...imageSets.flatMap(({ candidates }) =>
      candidates.flatMap(({ image }) =>
        image?.isString ? [{ kind: "string" as const, ...image }] : [],
      ),
    ),
  ].sort((a, b) => a.start - b.start || b.end - a.end);

  // The nodes nest without overlapping. Walk them in order and collect edits that don't overlap:
  // a replaced node hides the nodes inside it, and an image-set() that keeps some candidates
  // becomes edits to the text between the kept ones, which hide the dropped candidates.
  const edits: { start: number; end: number; text: string }[] = [];
  // Ranges of dropped candidates still ahead, with the nearest on top.
  const dropped: { start: number; end: number }[] = [];
  let replacedThrough = 0;
  for (const node of nodes) {
    if (node.start < replacedThrough) continue;
    while (dropped.length && dropped.at(-1)!.end <= node.start) dropped.pop();
    if (dropped.length && dropped.at(-1)!.start <= node.start) continue;

    if (node.kind !== "image-set") {
      const text =
        node.kind === "url" ? rewrite.url?.(node.url) : rewrite.imageSetString?.(node.url);
      if (text === undefined) continue;
      edits.push({ start: node.start, end: node.end, text });
      replacedThrough = node.end;
      continue;
    }
    const kept = node.candidates.filter(
      ({ image }) => !image || !rewrite.removeImageSetCandidate?.(image.url),
    );
    if (kept.length === node.candidates.length) continue;
    if (!kept.length) {
      edits.push({ start: node.start, end: node.end, text: "none" });
      replacedThrough = node.end;
      continue;
    }
    const gaps = kept.map((candidate, index) => ({
      start: index ? kept[index - 1]!.end : node.open + 1,
      end: candidate.start,
      text: index ? ", " : "",
    }));
    gaps.push({ start: kept.at(-1)!.end, end: node.end, text: ")" });
    edits.push(...gaps);
    dropped.push(...gaps.reverse());
  }

  edits.sort((a, b) => a.start - b.start);
  let result = "";
  let copiedThrough = 0;
  for (const edit of edits) {
    result += css.slice(copiedThrough, edit.start) + edit.text;
    copiedThrough = edit.end;
  }
  return result + css.slice(copiedThrough);
}

/** Quotes a value as a CSS string. */
export function cssString(value: string): string {
  return `"${value.replace(/[\\"\n\r\f]/g, (character) =>
    character === "\\" || character === '"'
      ? `\\${character}`
      : `\\${character.charCodeAt(0).toString(16)} `,
  )}"`;
}

/** Removes closed comments, as `/\/\*[\s\S]*?\*\//g` does, without rescanning the text. */
export function stripCssComments(css: string): string {
  let result = "";
  let copiedThrough = 0;
  for (;;) {
    const open = css.indexOf("/*", copiedThrough);
    const close = open === -1 ? -1 : css.indexOf("*/", open + 2);
    if (close === -1) return result + css.slice(copiedThrough);
    result += css.slice(copiedThrough, open);
    copiedThrough = close + 2;
  }
}

const IMAGE_PROPERTIES = new Set([
  "background",
  "background-image",
  "border-image",
  "border-image-source",
  "content",
  "cursor",
  "list-style",
  "list-style-image",
  "mask",
  "mask-image",
  "-webkit-mask",
  "-webkit-mask-image",
  "shape-outside",
]);

/**
 * True when declarations in these style sheets or style attributes show a remote image. A custom
 * property can reference others through var(), so a declaration shows a remote image when it has
 * one or references a property that leads to one. Following references from each declaration takes
 * exponential time on a crafted chain of properties that each reference the next twice, so this
 * finds every property that leads to a remote image in one pass instead.
 */
export function hasRemoteCssImage(values: string[]): boolean {
  const declarations = values.flatMap((value) => scanCss(value).declarations);
  const referrers = new Map<string, Set<string>>();
  const remoteProperties = new Set<string>();
  const pending: string[] = [];
  const markRemote = (property: string) => {
    if (remoteProperties.has(property)) return;
    remoteProperties.add(property);
    pending.push(property);
  };
  for (const { property, remote, references } of declarations) {
    if (!property.startsWith("--")) continue;
    if (remote) markRemote(property);
    for (const referenced of references) {
      const propertyReferrers = referrers.get(referenced) ?? new Set<string>();
      propertyReferrers.add(property);
      referrers.set(referenced, propertyReferrers);
    }
  }
  for (let property = pending.pop(); property !== undefined; property = pending.pop())
    for (const referrer of referrers.get(property) ?? []) markRemote(referrer);

  return declarations.some(
    ({ property, remote, references }) =>
      IMAGE_PROPERTIES.has(property) &&
      (remote || references.some((referenced) => remoteProperties.has(referenced))),
  );
}

export interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

/** Parses a srcset attribute the way the HTML standard's algorithm does. */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let position = 0;
  while (position < value.length) {
    while (isSrcsetSeparator(value[position])) position += 1;
    if (position >= value.length) break;

    const urlStart = position;
    while (position < value.length && !isWhitespace(value[position])) position += 1;
    let urlEnd = position;
    while (urlEnd > urlStart && value[urlEnd - 1] === ",") urlEnd -= 1;
    const url = value.slice(urlStart, urlEnd);
    if (urlEnd < position) {
      if (url) candidates.push({ url, descriptor: "" });
      continue;
    }

    while (isWhitespace(value[position])) position += 1;
    const descriptorStart = position;
    let inParentheses = false;
    while (position < value.length) {
      const character = value[position];
      if (character === "(") inParentheses = true;
      else if (character === ")") inParentheses = false;
      else if (character === "," && !inParentheses) break;
      position += 1;
    }
    candidates.push({ url, descriptor: value.slice(descriptorStart, position).trim() });
    if (value[position] === ",") position += 1;
  }
  return candidates;
}

export function serializeSrcset(candidates: SrcsetCandidate[]): string {
  return candidates
    .map(({ url, descriptor }) => (descriptor ? `${url} ${descriptor}` : url))
    .join(", ");
}

// HTML's ASCII whitespace is the same set as CSS whitespace.
function isSrcsetSeparator(character: string | undefined): boolean {
  return character === "," || isWhitespace(character);
}
