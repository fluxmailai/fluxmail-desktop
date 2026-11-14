export interface CssUrl {
  /** Index of the `u` in `url(`. */
  start: number;
  /** Index just past the closing parenthesis. */
  end: number;
  /** The URL as written, without quotes. Backslash escapes are kept. */
  url: string;
  /** The quote around the URL, or an empty string for an unquoted URL. */
  quote: string;
}

const CSS_WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);
const NEWLINES = new Set(["\n", "\r", "\f"]);

/**
 * Finds every `url(...)` in CSS text, following the CSS tokenizer closely enough to see what a
 * browser would load. Email CSS is untrusted, so this runs in time linear in the text: a regular
 * expression that rescans the rest of the text for each `url(` lets a crafted stylesheet freeze
 * rendering.
 *
 * A quoted URL ends at the next unescaped matching quote, and may be followed by whitespace and
 * comments before `)`. An unquoted URL ends at `)` or at whitespace followed by `)`, and is invalid
 * if it contains an unescaped quote or `(`. The end of the text closes an open string or url().
 * Scanning resumes at the next `url(` after an invalid one, so an inner `url(` is still found.
 */
export function findCssUrls(value: string): CssUrl[] {
  const urls: CssUrl[] = [];
  const start = /url\(/gi;
  if (!start.test(value)) return urls;
  start.lastIndex = 0;

  // Several `url(` can be followed by the same whitespace, or by comments that all close at the
  // same `*/` and continue into the same chain of comments. Cache the whitespace lookup, find
  // comment ends by binary search, and remember where each chain ends, so each stretch of text
  // is walked once.
  const nextNonWhitespace = cachedSearch((from) => {
    while (CSS_WHITESPACE.has(value[from]!)) from += 1;
    return from;
  });
  const commentCloses: number[] = [];
  for (let index = value.indexOf("*/"); index !== -1; index = value.indexOf("*/", index + 1))
    commentCloses.push(index);
  const afterComment = (open: number) => {
    let low = 0;
    let high = commentCloses.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (commentCloses[middle]! < open + 2) low = middle + 1;
      else high = middle;
    }
    return low < commentCloses.length ? commentCloses[low]! + 2 : value.length;
  };
  const chainEnds = new Map<number, number>();
  const skipWhitespaceAndComments = (from: number) => {
    const walked: number[] = [];
    let position = nextNonWhitespace(from);
    while (value.startsWith("/*", position)) {
      const next = afterComment(position);
      const known = chainEnds.get(next);
      if (known !== undefined) {
        position = known;
        break;
      }
      walked.push(next);
      position = nextNonWhitespace(next);
    }
    for (const walkedPosition of walked) chainEnds.set(walkedPosition, position);
    return position;
  };

  // As in CSS, the end of the text closes an open string or url() the way `)` would.
  const closes = (position: number) => position >= value.length || value[position] === ")";

  let match: RegExpExecArray | null;
  while ((match = start.exec(value))) {
    const urlStart = nextNonWhitespace(start.lastIndex);
    const quote = value[urlStart];
    let url: CssUrl | undefined;
    if (quote === '"' || quote === "'") {
      const closeQuote = closingQuote(value, urlStart);
      const closeParenthesis =
        closeQuote === undefined ? undefined : skipWhitespaceAndComments(closeQuote + 1);
      if (closeQuote !== undefined && closes(closeParenthesis!))
        url = {
          start: match.index,
          end: Math.min(closeParenthesis! + 1, value.length),
          url: value.slice(urlStart + 1, closeQuote),
          quote,
        };
    } else {
      const contentEnd = unquotedUrlEnd(value, urlStart);
      const closeParenthesis = contentEnd === undefined ? undefined : nextNonWhitespace(contentEnd);
      if (contentEnd !== undefined && closes(closeParenthesis!))
        url = {
          start: match.index,
          end: Math.min(closeParenthesis! + 1, value.length),
          url: value.slice(urlStart, contentEnd),
          quote: "",
        };
    }
    if (!url) continue;
    urls.push(url);
    start.lastIndex = url.end;
  }
  return urls;
}

/** Replaces each `url(...)` found by `findCssUrls` with the text `replace` returns for it. */
export function replaceCssUrls(value: string, replace: (url: CssUrl, match: string) => string) {
  let result = "";
  let copiedThrough = 0;
  for (const url of findCssUrls(value)) {
    result += value.slice(copiedThrough, url.start) + replace(url, value.slice(url.start, url.end));
    copiedThrough = url.end;
  }
  return result + value.slice(copiedThrough);
}

// Returns the index of the quote that closes the string opening at `openQuote`, the end of the
// text if that comes first, or undefined when an unescaped newline makes the string invalid. The
// scan stops at the next unescaped quote of the same kind, so scans from different `url("` never
// cover the same text twice.
function closingQuote(value: string, openQuote: number): number | undefined {
  const quote = value[openQuote];
  for (let position = openQuote + 1; position < value.length; position += 1) {
    const character = value[position];
    if (character === "\\") position += 1;
    else if (character === quote) return position;
    else if (NEWLINES.has(character)) return undefined;
  }
  return value.length;
}

// Returns the index just past an unquoted URL, or undefined when it is invalid. The scan stops at
// `(`, so it never reaches past the next `url(`.
function unquotedUrlEnd(value: string, from: number): number | undefined {
  for (let position = from; position < value.length; position += 1) {
    const character = value[position]!;
    if (character === "\\") {
      // A backslash before a newline is not a valid escape, which makes the url() invalid.
      if (NEWLINES.has(value[position + 1]!)) return undefined;
      position += 1;
    } else if (character === ")" || CSS_WHITESPACE.has(character)) return position;
    else if (character === '"' || character === "'" || character === "(") return undefined;
  }
  return value.length;
}

// Wraps a forward search so lookups from positions inside the last searched stretch reuse its
// answer. `search(from)` must return the first index at or after `from` where the stretch ends.
function cachedSearch(search: (from: number) => number): (from: number) => number {
  let cachedFrom = -1;
  let cachedIndex = -1;
  return (from) => {
    if (from < cachedFrom || from > cachedIndex) {
      cachedFrom = from;
      cachedIndex = search(from);
    }
    return cachedIndex;
  };
}
