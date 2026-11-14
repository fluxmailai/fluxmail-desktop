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

/**
 * Finds every `url(...)` in CSS text in time linear in its length. Email CSS is untrusted, and a
 * regular expression that rescans the rest of the text for each `url(` lets a crafted stylesheet
 * freeze rendering. A quoted URL ends at the first unescaped matching quote and must be followed by
 * optional whitespace and `)`. An unquoted URL runs to the first unescaped `)`, with optional
 * whitespace before it.
 */
export function findCssUrls(value: string): CssUrl[] {
  const urls: CssUrl[] = [];
  const start = /url\(/gi;
  if (!start.test(value)) return urls;
  start.lastIndex = 0;

  const nextNonWhitespace = nextIndexFinder(value, (from) => {
    const match = /\S/g;
    match.lastIndex = from;
    return match.exec(value)?.index ?? -1;
  });
  const skipWhitespace = (from: number) => {
    const index = nextNonWhitespace(from);
    return index === -1 ? value.length : index;
  };
  const nextDoubleQuote = nextUnescapedFinder(value, '"');
  const nextSingleQuote = nextUnescapedFinder(value, "'");
  const nextCloseParenthesis = nextUnescapedFinder(value, ")");
  const nextOpenParenthesis = nextUnescapedFinder(value, "(");
  const nextWhitespace = nextIndexFinder(value, (from) => {
    const match = /\s/g;
    match.lastIndex = from;
    return match.exec(value)?.index ?? -1;
  });

  let match: RegExpExecArray | null;
  while ((match = start.exec(value))) {
    const urlStart = skipWhitespace(start.lastIndex);
    const quote = value[urlStart];
    let url: CssUrl | undefined;
    if (quote === '"' || quote === "'") {
      const closeQuote = (quote === '"' ? nextDoubleQuote : nextSingleQuote)(urlStart + 1);
      const closeParenthesis = closeQuote === -1 ? -1 : skipWhitespace(closeQuote + 1);
      if (closeParenthesis !== -1 && value[closeParenthesis] === ")")
        url = {
          start: match.index,
          end: closeParenthesis + 1,
          url: value.slice(urlStart + 1, closeQuote),
          quote,
        };
    } else {
      // An unquoted URL can't contain whitespace, quotes or `(`. Browsers treat one that does as
      // invalid, and so do we, so scanning resumes at the next `url(` instead of skipping past it.
      const closeParenthesis = nextCloseParenthesis(urlStart);
      const urlEnd = closeParenthesis === -1 ? -1 : nextWhitespace(urlStart);
      const invalidAt = Math.min(
        ...[nextDoubleQuote, nextSingleQuote, nextOpenParenthesis].map((find) => {
          const index = find(urlStart);
          return index === -1 ? value.length : index;
        }),
      );
      const contentEnd = urlEnd === -1 || urlEnd > closeParenthesis ? closeParenthesis : urlEnd;
      if (
        closeParenthesis !== -1 &&
        invalidAt > closeParenthesis &&
        skipWhitespace(contentEnd) === closeParenthesis
      )
        url = {
          start: match.index,
          end: closeParenthesis + 1,
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

// Caches the last answer of a "next index at or after `from`" search, so lookups from increasing
// positions scan the text once in total.
function nextIndexFinder(value: string, find: (from: number) => number): (from: number) => number {
  let cachedFrom = -1;
  let cachedIndex = -1;
  return (from) => {
    if (cachedFrom !== -1 && from >= cachedFrom && (cachedIndex === -1 || cachedIndex >= from))
      return cachedIndex;
    cachedFrom = from;
    cachedIndex = find(from);
    return cachedIndex;
  };
}

// A character is escaped when an odd number of backslashes precede it. Callers search from just
// after a quote or `url(`, so a run of backslashes never starts before `from`.
function nextUnescapedFinder(value: string, character: string): (from: number) => number {
  return nextIndexFinder(value, (from) => {
    let index = value.indexOf(character, from);
    while (index !== -1 && precedingBackslashes(value, index) % 2 === 1)
      index = value.indexOf(character, index + 1);
    return index;
  });
}

function precedingBackslashes(value: string, index: number): number {
  let count = 0;
  while (index - count > 0 && value[index - count - 1] === "\\") count += 1;
  return count;
}
