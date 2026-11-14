import {
  transformBackgroundColor,
  transformTextColor,
  transformBrandColor,
  transformBorderColor,
  ensureContrast,
  getContrastRatio,
  isValidColor,
  analyzeColor,
} from "./dark-mode-transform";
import { findCssBlocks, stripCssComments } from "./css-urls";

// Email HTML and CSS are untrusted, so every pattern here has to run in time linear in its input.
// A pattern that rescans the rest of the text from each place it could start, such as `\s*x$` or
// `a\([^)]*\)` on text with many `a(` and no `)`, lets a crafted message freeze rendering.

export interface DarkModeOptions {
  preserveBrands?: boolean;
  minContrast?: number;
  darkBackground?: string;
  lightText?: string;
  linkColor?: string;
}

const DEFAULT_OPTIONS: DarkModeOptions = {
  preserveBrands: true,
  minContrast: 4.5,
  darkBackground: "#242424", // Dark background color - matches card background fallback
  lightText: "#fafafa", // Light text color for good contrast
  linkColor: "oklch(70.7% 0.165 254.624)",
};

const MIN_PRESERVED_LINK_LUMINANCE = 0.08;
const MIN_PRESERVED_LINK_SATURATION = 30;
const MIN_PRESERVED_LINK_LIGHTNESS = 25;
const MIN_BRAND_LINK_SATURATION = 30;
const BACKGROUND_TAGS = new Set(["body", "table", "td", "th", "div", "tr"]);

interface ElementColors {
  background?: string;
  color?: string;
  borderColor?: string;
}

// Splits a trailing `!important` from a declaration value, as `/\s*!important\s*$/i` would.
function splitImportant(value: string): { value: string; important: boolean } {
  const trimmed = value.trimEnd();
  const important = trimmed.slice(-"!important".length).toLowerCase() === "!important";
  return { value: important ? trimmed.slice(0, -"!important".length) : value, important };
}

function cleanCssColorValue(value: string): string {
  return splitImportant(value).value.trim();
}

function extractElementColors(element: Element): ElementColors {
  const styles = parseStyleString(element.getAttribute("style") || "");
  const background = styles["background-color"]
    ? cleanCssColorValue(styles["background-color"])
    : undefined;
  const color = styles.color ? cleanCssColorValue(styles.color) : undefined;
  const borderColor = styles["border-color"]
    ? cleanCssColorValue(styles["border-color"])
    : undefined;

  return { background, color, borderColor };
}

function linkColorLooksReadable(analysis: ReturnType<typeof analyzeColor>): boolean {
  return (
    analysis.luminance >= MIN_PRESERVED_LINK_LUMINANCE ||
    (analysis.hsl.s >= MIN_PRESERVED_LINK_SATURATION &&
      analysis.hsl.l >= MIN_PRESERVED_LINK_LIGHTNESS)
  );
}

function resolveContrastBackgroundColor(value: string, fallback: string): string {
  const cleanValue = cleanCssColorValue(value);

  if (!isValidColor(cleanValue) || analyzeColor(cleanValue).alpha < 1) {
    return fallback;
  }

  return cleanValue;
}

function shouldPreserveExplicitLinkColor(
  color: string,
  backgroundColor: string,
  minContrast: number = DEFAULT_OPTIONS.minContrast!,
): boolean {
  const cleanColor = cleanCssColorValue(color);
  const cleanBackgroundColor = cleanCssColorValue(backgroundColor);

  if (!isValidColor(cleanColor) || !isValidColor(cleanBackgroundColor)) {
    return false;
  }

  return (
    linkColorLooksReadable(analyzeColor(cleanColor)) &&
    getContrastRatio(cleanColor, cleanBackgroundColor) >= minContrast
  );
}

function shouldTreatExplicitLinkColorAsBrand(color: string): boolean {
  const cleanColor = cleanCssColorValue(color);
  if (!isValidColor(cleanColor)) {
    return false;
  }

  const analysis = analyzeColor(cleanColor);
  if (analysis.alpha < 1) {
    return false;
  }

  return analysis.hsl.s >= MIN_BRAND_LINK_SATURATION;
}

function transformExplicitLinkColor(
  color: string,
  backgroundColor: string,
  options: DarkModeOptions,
): string | null {
  const cleanLinkBackground = resolveContrastBackgroundColor(
    backgroundColor,
    options.darkBackground!,
  );
  if (
    options.preserveBrands &&
    shouldPreserveExplicitLinkColor(color, cleanLinkBackground, options.minContrast)
  ) {
    return null;
  }

  const transformedColor =
    options.preserveBrands && shouldTreatExplicitLinkColorAsBrand(color)
      ? transformBrandValue(color)
      : transformTextColor(color, cleanLinkBackground);

  return transformedColor &&
    getContrastRatio(transformedColor, cleanLinkBackground) >= options.minContrast!
    ? transformedColor
    : ensureContrast(transformedColor || color, cleanLinkBackground, options.minContrast);
}

/**
 * Detects decorative email frame/border images that should be removed in dark mode.
 * These are typically white/light colored images used to create "card" layouts in emails
 * that don't work well on dark backgrounds.
 */
function isDecorativeFrameImage(backgroundValue: string): boolean {
  const lowerValue = backgroundValue.toLowerCase();

  // Google Play email frame images
  if (lowerValue.includes("gstatic.com") && lowerValue.includes("market_images/email/")) {
    return true;
  }

  // Common email frame/border image patterns
  const decorativePatterns = [
    /email[_-]?(top|mid|middle|bottom|border|frame)/i,
    /border[_-]?(top|mid|middle|bottom|frame)/i,
    /frame[_-]?(top|mid|middle|bottom|border)/i,
    /shadow[_-]?(top|mid|middle|bottom|border)/i,
  ];

  for (const pattern of decorativePatterns) {
    if (pattern.test(lowerValue)) {
      return true;
    }
  }

  return false;
}

export function convertEmailToDarkMode(html: string, options: DarkModeOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  try {
    // Steps 1 and 2: Remove conflicting dark mode media queries and styles, and transform CSS in
    // style blocks without inlining
    const processedHtml = removeConflictingDarkModeCSS(html, opts);

    // Step 3: Parse the HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(processedHtml, "text/html");

    // Step 4: Inline unscoped stylesheet rules. Media-scoped rules remain in the head.
    inlineTransformedStyleRules(doc);

    // Step 5: Set base dark theme
    const preservedBodyBackground = setupBaseDarkTheme(doc, opts);

    // Step 6: Transform all elements
    transformElements(doc, opts);

    // Step 7: Final contrast adjustments
    ensureOverallContrast(doc, opts);

    // Step 8: Final cleanup - aggressive replacement of problematic colors
    const headStyles = [...doc.head.querySelectorAll("style")]
      .map((style) => style.outerHTML)
      .join("");
    let result = `${headStyles}${doc.body.innerHTML}`;
    if (preservedBodyBackground) {
      result = wrapWithBodyBackground(result, preservedBodyBackground);
    }

    // Remove any LAB color values that might have slipped through - these are usually very light colors
    // LAB colors like lab(98.26% 0 0) represent nearly white colors that should be replaced with proper light text
    // Also catch LAB colors like lab(16.48% 0 0) which are dark grays that create visible boxes
    // Require declaration boundaries to avoid matching custom properties like --bg-color.
    // `lab\([^)]+\)` would rescan to the end of the text from every `lab(` when no `)` follows,
    // so these match through the end of the text and leave a lab( that isn't closed alone.
    result = result.replace(
      /(^|[;"'{]\s*)color:\s*lab\([^)]+(\)|$)(\s*!important)?/gi,
      (match, prefix, close, important) =>
        close ? `${prefix}color: ${opts.lightText}${important || ""}` : match,
    );
    // For background colors, we want to remove LAB colors entirely or replace with transparent
    // This prevents gray boxes from appearing on tables
    result = result.replace(
      /background-color:\s*lab\([^)]+(\)|$)(\s*!important)?/gi,
      (match, close, important) => {
        if (!close) return match;
        // Extract the lightness value from LAB color
        const labMatch = match.match(/lab\(([\d.]+)%/);
        if (labMatch) {
          const lightness = parseFloat(labMatch[1]);
          // If it's very dark (< 20%), use dark background
          // If it's very light (> 80%), use dark background
          // For medium values, make it transparent to avoid gray boxes
          if (lightness < 20 || lightness > 80) {
            return `background-color: ${opts.darkBackground}${important || ""}`;
          }
          // For medium lightness (gray boxes), remove background entirely
          return "";
        }
        return `background-color: ${opts.darkBackground}${important || ""}`;
      },
    );
    result = result.replace(
      /border-color:\s*lab\([^)]+(\)|$)(\s*!important)?/gi,
      (match, close, important) => (close ? `border-color: #555555${important || ""}` : match),
    );

    // Remove any remaining black TEXT colors - avoid matching background-color or border-color
    result = result.replace(
      /(^|[;"'{]\s*)color:\s*#000000(?![0-9a-f])/gi,
      `$1color: ${opts.lightText}`,
    );
    result = result.replace(/(^|[;"'{]\s*)color:\s*#000(?!\w)/gi, `$1color: ${opts.lightText}`);
    result = result.replace(/(^|[;"'{]\s*)color:\s*black/gi, `$1color: ${opts.lightText}`);

    // Aggressively replace very dark grays like #222222 - but only for text color
    result = result.replace(/(^|[;"'{]\s*)color:\s*#222222(?![0-9a-f])/gi, `$1color: #d0d0d0`);
    result = result.replace(/(^|[;"'{]\s*)color:\s*#222(?![0-9a-f])/gi, `$1color: #d0d0d0`);
    result = result.replace(/(^|[;"'{]\s*)color:\s*#333333(?![0-9a-f])/gi, `$1color: #c0c0c0`);
    result = result.replace(/(^|[;"'{]\s*)color:\s*#333(?![0-9a-f])/gi, `$1color: #c0c0c0`);
    result = result.replace(
      /(^|[;"'{]\s*)color:\s*#ebebeb(?![0-9a-f])(\s*!important)?/gi,
      `$1color: ${opts.lightText}$2`,
    );

    // Remove problematic mix-blend-mode styles that cause poor contrast in dark mode
    // mix-blend-mode: multiply makes images blend with the background, causing them to disappear on dark backgrounds
    result = result.replace(
      /mix-blend-mode\s*:\s*multiply(\s*!important)?/gi,
      "mix-blend-mode: normal$1",
    );
    result = result.replace(
      /mix-blend-mode\s*:\s*darken(\s*!important)?/gi,
      "mix-blend-mode: normal$1",
    );

    // Step 9: Return transformed HTML
    return result;
  } catch (error) {
    console.warn("Failed to convert email to dark mode:", error);
    return html; // Return original on error
  }
}

// `transformStyleSheet` runs on each style sheet after the sender's dark mode rules are gone, and
// removes the sheet when it returns null.
export function removeSenderDarkModeCSS(
  html: string,
  transformStyleSheet?: (css: string) => string | null,
): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString("<!doctype html><html><body></body></html>", "text/html");
  const template = doc.createElement("template");
  template.innerHTML = html;

  for (const element of template.content.querySelectorAll<HTMLElement>("[style]")) {
    const declarations = splitCssDeclarations(element.getAttribute("style") || "").filter(
      (declaration) => {
        const colonIndex = declaration.indexOf(":");
        return (
          colonIndex <= 0 ||
          normalizeCssPropertyName(declaration.slice(0, colonIndex)) !== "color-scheme"
        );
      },
    );

    if (declarations.length > 0) {
      element.setAttribute("style", declarations.join("; "));
    } else {
      element.removeAttribute("style");
    }
  }

  for (const styleElement of template.content.querySelectorAll("style")) {
    if (/prefers-color-scheme\s*:\s*dark/i.test(styleElement.getAttribute("media") || "")) {
      styleElement.remove();
      continue;
    }

    const css = removeDarkColorSchemeMediaRules(styleElement.textContent || "").replace(
      /(^|[;{]\s*)color-scheme\s*:\s*[^;}]+;?/gi,
      "$1",
    );
    const transformed = transformStyleSheet ? transformStyleSheet(css) : css;
    if (transformed === null) styleElement.remove();
    else styleElement.textContent = transformed;
  }

  return template.innerHTML;
}

// Removes `@media (prefers-color-scheme: dark) { ... }` rules. The end of each rule is found from the
// braces a browser would pair, found in one pass, so rules that never close don't rescan the text.
function removeDarkColorSchemeMediaRules(css: string): string {
  const rule = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/gi;
  if (!rule.test(css)) return css;
  rule.lastIndex = 0;

  const closingBraces = findCssBlocks(css);
  let result = "";
  let copiedThrough = 0;
  for (let match = rule.exec(css); match; match = rule.exec(css)) {
    const close = closingBraces.get(rule.lastIndex - 1);
    if (close === undefined) continue;
    result += css.slice(copiedThrough, match.index);
    copiedThrough = close + 1;
    rule.lastIndex = copiedThrough;
  }
  return result + css.slice(copiedThrough);
}

const FORCED_LIGHT_SELECTOR =
  /body,\s*p,\s*td,\s*tr,\s*\.body,\s*table,\s*h[1-6],\s*div,\s*span\s*\{/gi;
const FORCED_LIGHT_BACKGROUND = /background-color:\s*#FEFEFE\s*!\s*important/i;

// True when a style sheet has a `body, p, td, ... span {` rule whose block, up to its first `}`,
// forces `background-color: #FEFEFE !important`. A later selector in the same block sees only part
// of the text an earlier one did, so each block is checked once.
function hasForcedLightRule(css: string): boolean {
  let checkedThrough = -1;
  for (const match of css.matchAll(FORCED_LIGHT_SELECTOR)) {
    const blockStart = match.index + match[0].length;
    if (blockStart <= checkedThrough) continue;
    const close = css.indexOf("}", blockStart);
    checkedThrough = close === -1 ? css.length : close;
    if (FORCED_LIGHT_BACKGROUND.test(css.slice(blockStart, checkedThrough))) return true;
  }
  return false;
}

const FORCED_OVERRIDES = [
  /background-color\s*:\s*#FEFEFE\s*!\s*important/gi,
  /color\s*:\s*#010101\s*!\s*important/gi,
];

function removeForcedOverrides(value: string): string {
  return FORCED_OVERRIDES.reduce((result, pattern) => result.replace(pattern, ""), value);
}

function removeConflictingDarkModeCSS(html: string, options: DarkModeOptions): string {
  // Only remove CSS that explicitly conflicts with dark mode, not normal email styles
  const processedHtml = removeSenderDarkModeCSS(html, (css) => {
    // Only remove very specific problematic style blocks that use !important overrides
    if (hasForcedLightRule(css)) return null;

    // Only remove CSS rules that use !important overrides with #FEFEFE or #010101
    const cleaned = removeForcedOverrides(css);
    try {
      return transformCSSContent(cleaned, options);
    } catch (error) {
      console.error("Failed to transform CSS in style tags, falling back to original:", error);
      return cleaned;
    }
  });

  // Also remove the overrides from inline styles.
  return removeForcedOverrides(processedHtml);
}

function transformCSSContent(cssContent: string, options: DarkModeOptions): string {
  let transformedCSS = stripCssComments(cssContent);

  transformedCSS = transformCSSCustomProperties(transformedCSS, options);

  // Transform background colors in CSS rules (including !important)
  // Updated regex to handle CSS without semicolons (e.g., .wrapper{background-color:#eef0f3})
  transformedCSS = transformedCSS.replace(
    /(^|[;{]\s*)background-color\s*:\s*([^;!}]+)(\s*!important)?/gi,
    (match, prefix, color, important) => {
      const cleanColor = color.trim();

      const transformed = transformBackgroundValue(cleanColor, options);
      if (transformed) {
        const importantSuffix = important ? " !important" : "";
        return `${prefix}background-color: ${transformed}${importantSuffix}`;
      }

      return `${prefix}background-color: ${cleanColor}${important || ""}`;
    },
  );

  // Updated regex to handle CSS without semicolons
  transformedCSS = transformedCSS.replace(
    /(^|[;{]\s*)background\s*:\s*([^;!}]+)(\s*!important)?/gi,
    (match, prefix, value, important) => {
      const cleanValue = value.trim();
      // Check for decorative frame images that should be removed in dark mode
      if (cleanValue.includes("url(") && isDecorativeFrameImage(cleanValue)) {
        return `${prefix}background: none`;
      }
      const transformed = transformBackgroundPaintValue(cleanValue, options);
      if (transformed) {
        const importantSuffix = important ? " !important" : "";
        return `${prefix}background: ${transformed}${importantSuffix}`;
      }
      return match;
    },
  );

  // Transform text colors in CSS - avoid matching background-color or border-color
  // Updated regex to handle CSS without semicolons
  transformedCSS = transformedCSS.replace(
    /(^|[;{]\s*)color\s*:\s*([^;!}]+)(\s*!important)?/gi,
    (_, prefix, color, important) => {
      const cleanColor = color.trim();

      const transformed = transformTextValue(cleanColor, options);
      if (transformed) {
        const importantSuffix = important ? " !important" : "";
        return `${prefix}color: ${transformed}${importantSuffix}`;
      }

      return `${prefix}color: ${cleanColor}${important || ""}`;
    },
  );

  // Transform border colors
  // Updated regex to handle CSS without semicolons
  transformedCSS = transformedCSS.replace(
    /(^|[;{]\s*)border-color\s*:\s*([^;!}]+)(\s*!important)?/gi,
    (_, prefix, color, important) => {
      const cleanColor = color.trim();

      const transformed = transformBorderValue(cleanColor);
      if (transformed) {
        const importantSuffix = important ? " !important" : "";
        return `${prefix}border-color: ${transformed}${importantSuffix}`;
      }

      return `${prefix}border-color: ${cleanColor}${important || ""}`;
    },
  );

  // Transform border shorthand properties that include colors
  // Handle patterns like: border: 1px solid #color, border-top: 2px dotted #color, etc.
  // Updated regex to handle CSS without semicolons
  transformedCSS = transformedCSS.replace(
    /(^|[;{]\s*)border(-top|-right|-bottom|-left)?\s*:\s*([^;!}]+)(\s*!important)?/gi,
    (match, prefix, side, value, important) => {
      const cleanValue = value.trim();
      const parts = cleanValue.split(/\s+/);

      // Look for color values in the border declaration
      let hasColorTransformation = false;
      const transformedParts = parts.map((part: string) => {
        if (isValidColor(part)) {
          hasColorTransformation = true;
          return transformBorderColor(part);
        }
        return part;
      });

      if (hasColorTransformation) {
        const borderProperty = side ? `border${side}` : "border";
        const importantSuffix = important ? " !important" : "";
        return `${prefix}${borderProperty}: ${transformedParts.join(" ")}${importantSuffix}`;
      }

      return match;
    },
  );

  // Remove problematic mix-blend-mode styles in CSS blocks
  transformedCSS = transformedCSS.replace(
    /mix-blend-mode\s*:\s*multiply(\s*!important)?/gi,
    "mix-blend-mode: normal$1",
  );
  transformedCSS = transformedCSS.replace(
    /mix-blend-mode\s*:\s*darken(\s*!important)?/gi,
    "mix-blend-mode: normal$1",
  );

  return transformedCSS;
}

function transformCSSCustomProperties(cssContent: string, options: DarkModeOptions): string {
  // The lookbehind starts each match at the start of a name, so a long run of `-` isn't rescanned
  // from each of its characters.
  return cssContent.replace(
    /(?<![\w-])(--[\w-]+\s*:\s*)([^;!}]+)(\s*!important)?/gi,
    (match, prefix, value, important) => {
      const propertyName = String(prefix).split(":")[0]?.trim() || "";
      const cleanValue = String(value).trim();
      const transformed = transformCustomPropertyColor(propertyName, cleanValue, options);

      if (!transformed) {
        return match;
      }

      return `${prefix}${transformed}${important || ""}`;
    },
  );
}

function transformCustomPropertyColor(
  propertyName: string,
  value: string,
  options: DarkModeOptions,
): string | null {
  if (!isValidColor(value)) {
    return null;
  }

  const normalizedName = propertyName.toLowerCase();
  if (/(?:border|stroke|divider|rule)/i.test(normalizedName)) {
    return transformBorderColor(value);
  }

  if (/(?:background|bg|surface|canvas|card|fill)/i.test(normalizedName)) {
    return transformBackgroundColor(value, options.darkBackground);
  }

  if (/(?:foreground|text|fg|color)/i.test(normalizedName)) {
    return transformTextColor(value, options.darkBackground!);
  }

  return null;
}

function replaceCssVarFallbackColor(
  value: string,
  transformColor: (color: string) => string,
): string | null {
  // Matches `^(var\(\s*--[\w-]+\s*,\s*)([^)]+?)(\s*\))$`, which rescans the trailing whitespace
  // from each character of a long fallback.
  const prefix = /^var\(\s*--[\w-]+\s*,\s*/i.exec(value);
  if (!prefix || !value.endsWith(")")) {
    return null;
  }

  const body = value.slice(prefix[0].length, -1);
  const fallback = body.trim();
  if (!fallback || body.includes(")") || !isValidColor(fallback)) {
    return null;
  }

  return `${prefix[0]}${transformColor(fallback)}${body.slice(body.trimEnd().length)})`;
}

function transformBackgroundValue(value: string, options: DarkModeOptions): string | null {
  if (isValidColor(value)) {
    return transformBackgroundColor(value, options.darkBackground);
  }

  return replaceCssVarFallbackColor(value, (color) =>
    transformBackgroundColor(color, options.darkBackground),
  );
}

function transformBackgroundPaintValue(value: string, options: DarkModeOptions): string | null {
  let changed = false;
  const transformed = transformCssColors(value, (color) => {
    const nextColor = transformBackgroundColor(color, options.darkBackground);
    changed ||= nextColor !== color;
    return nextColor;
  });

  return changed ? transformed : null;
}

const CSS_HEX_COLOR = /#[0-9a-f]+/iy;
const CSS_IDENTIFIER = /[a-z][\w-]*/iy;
const CSS_COLOR_FUNCTION = /^(?:rgba?|hsla?)$/i;

function transformCssColors(value: string, transform: (color: string) => string): string {
  // Find every function's closing parenthesis up front. Searching from each `(` rescans the rest of
  // the text when parentheses don't close. Nested gradients are walked in place with a stack of the
  // ends of the gradients being read, rather than by recursion, which deep nesting would overflow.
  const closingParentheses = matchCssParentheses(value);
  const gradientEnds: number[] = [];
  let end = value.length;
  let result = "";
  let index = 0;

  for (;;) {
    if (index >= end) {
      if (!gradientEnds.length) break;
      result += ")";
      index = end + 1;
      end = gradientEnds.pop()!;
      continue;
    }
    const char = value[index]!;

    if (char === '"' || char === "'") {
      const stringEnd = findCssStringEnd(value, index, char);
      result += value.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }

    if (char === "#") {
      CSS_HEX_COLOR.lastIndex = index;
      const match = CSS_HEX_COLOR.exec(value);
      if (match) {
        const hex = match[0].slice(0, end - index);
        result += isValidColor(hex) ? transform(hex) : hex;
        index += hex.length;
        continue;
      }
    }

    CSS_IDENTIFIER.lastIndex = index;
    const identifierMatch = CSS_IDENTIFIER.exec(value);
    if (identifierMatch && index + identifierMatch[0].length <= end) {
      const identifier = identifierMatch[0];
      const functionStart = index + identifier.length;
      const functionEnd = value[functionStart] === "(" ? closingParentheses[functionStart]! : -1;
      if (functionEnd !== -1 && functionEnd < end) {
        if (/gradient$/i.test(identifier)) {
          result += `${identifier}(`;
          gradientEnds.push(end);
          end = functionEnd;
          index = functionStart + 1;
          continue;
        }
        const functionValue = value.slice(index, functionEnd + 1);
        // colord, behind isValidColor, only parses rgb() and hsl() functions.
        result +=
          CSS_COLOR_FUNCTION.test(identifier) && isValidColor(functionValue)
            ? transform(functionValue)
            : functionValue;
        index = functionEnd + 1;
        continue;
      }

      result += isValidColor(identifier) ? transform(identifier) : identifier;
      index += identifier.length;
      continue;
    }

    result += char;
    index++;
  }

  return result;
}

// Maps the index of each `(` to the index of the `)` that closes it, or -1, skipping strings.
function matchCssParentheses(value: string): Int32Array {
  const closingParentheses = new Int32Array(value.length).fill(-1);
  const open: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"' || char === "'") {
      index = findCssStringEnd(value, index, char) - 1;
    } else if (char === "(") {
      open.push(index);
    } else if (char === ")" && open.length) {
      closingParentheses[open.pop()!] = index;
    }
  }
  return closingParentheses;
}

function findCssStringEnd(value: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index++) {
    const char = value[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return index + 1;
    }
  }

  return value.length;
}

function transformTextValue(
  value: string,
  options: DarkModeOptions,
  backgroundColor: string = options.darkBackground!,
): string | null {
  if (isValidColor(value)) {
    return transformTextColor(value, backgroundColor);
  }

  return replaceCssVarFallbackColor(value, (color) => transformTextColor(color, backgroundColor));
}

function transformBrandValue(value: string): string | null {
  if (isValidColor(value)) {
    return transformBrandColor(value);
  }

  return replaceCssVarFallbackColor(value, transformBrandColor);
}

function transformBorderValue(value: string): string | null {
  if (isValidColor(value)) {
    return transformBorderColor(value);
  }

  return replaceCssVarFallbackColor(value, transformBorderColor);
}

function transformInlineCustomProperties(
  currentStyle: string,
  styleUpdates: Record<string, string>,
  options: DarkModeOptions,
): void {
  const styles = parseStyleString(currentStyle);

  Object.entries(styles).forEach(([propertyName, value]) => {
    if (!propertyName.startsWith("--")) {
      return;
    }

    const transformed = transformCustomPropertyColor(propertyName, value, options);

    if (transformed) {
      styleUpdates[propertyName] = transformed;
    }
  });
}

type CssDeclaration = {
  property: string;
  value: string;
  important: boolean;
};

type CssSpecificity = [number, number, number];

type AppliedCssDeclaration = {
  important: boolean;
  specificity: CssSpecificity;
  order: number;
};

function isImportantValue(value: string | undefined): boolean {
  return Boolean(value && splitImportant(value).important);
}

function normalizeCssPropertyName(property: string): string {
  const trimmedProperty = property.trim();
  return trimmedProperty.startsWith("--") ? trimmedProperty : trimmedProperty.toLowerCase();
}

function parseCssDeclarationBlock(block: string): CssDeclaration[] {
  return splitCssDeclarations(block)
    .map((declaration) => {
      const colonIndex = declaration.indexOf(":");
      if (colonIndex <= 0) {
        return null;
      }

      const property = normalizeCssPropertyName(declaration.slice(0, colonIndex));
      const rawValue = declaration.slice(colonIndex + 1).trim();
      if (!property || !rawValue) {
        return null;
      }

      const { value: valueWithoutImportant, important } = splitImportant(rawValue);
      const value = valueWithoutImportant.trim();
      if (!value) {
        return null;
      }

      return { property, value, important };
    })
    .filter((declaration): declaration is CssDeclaration => Boolean(declaration));
}

function forEachTopLevelCssRule(
  css: string,
  callback: (selectorText: string, declarationBlock: string) => void,
): void {
  let index = 0;

  while (index < css.length) {
    const blockStart = css.indexOf("{", index);
    if (blockStart === -1) {
      return;
    }

    const selectorText = css.slice(index, blockStart).trim();
    let depth = 1;
    let cursor = blockStart + 1;

    while (cursor < css.length && depth > 0) {
      const char = css[cursor];
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
      }
      cursor++;
    }

    if (depth !== 0) {
      return;
    }

    const declarationBlock = css.slice(blockStart + 1, cursor - 1);
    if (selectorText && !selectorText.startsWith("@")) {
      callback(selectorText, declarationBlock);
    }

    index = cursor;
  }
}

function calculateCssSpecificity(selector: string): CssSpecificity {
  // An unclosed `(` or `[` runs to the end of the selector, as it does when a browser parses it.
  // Requiring the closing character would rescan the rest of the selector from each opening one.
  const withoutWhere = selector.replace(/:where\([^)]*(?:\)|$)/gi, "");
  const idCount = withoutWhere.match(/#[\w-]+/g)?.length || 0;
  const classCount = withoutWhere.match(/\.[\w-]+/g)?.length || 0;
  const attributeCount = withoutWhere.match(/\[[^\]]+(?:\]|$)/g)?.length || 0;
  const pseudoClassCount = withoutWhere.match(/:(?!:)[\w-]+(?:\([^)]*(?:\)|$))?/g)?.length || 0;
  const pseudoElementCount = withoutWhere.match(/::[\w-]+/g)?.length || 0;
  const typeSelectorText = withoutWhere
    .replace(/#[\w-]+/g, " ")
    .replace(/\.[\w-]+/g, " ")
    .replace(/\[[^\]]+(?:\]|$)/g, " ")
    .replace(/::[\w-]+/g, " ")
    .replace(/:(?!:)[\w-]+(?:\([^)]*(?:\)|$))?/g, " ");
  const typeCount =
    typeSelectorText
      .match(/(^|[\s>+~])([a-zA-Z][\w-]*|\*)/g)
      ?.filter((match) => !match.trim().startsWith("*")).length || 0;

  return [idCount, classCount + attributeCount + pseudoClassCount, typeCount + pseudoElementCount];
}

function compareCssSpecificity(a: CssSpecificity, b: CssSpecificity): number {
  for (let index = 0; index < a.length; index++) {
    const diff = a[index] - b[index];
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function shouldApplyCssDeclaration(
  originalInlineValue: string | undefined,
  previousDeclaration: AppliedCssDeclaration | undefined,
  nextDeclaration: AppliedCssDeclaration,
): boolean {
  if (originalInlineValue) {
    if (isImportantValue(originalInlineValue)) {
      return false;
    }

    if (!nextDeclaration.important) {
      return false;
    }
  }

  if (!previousDeclaration) {
    return true;
  }

  if (previousDeclaration.important !== nextDeclaration.important) {
    return nextDeclaration.important;
  }

  const specificityComparison = compareCssSpecificity(
    nextDeclaration.specificity,
    previousDeclaration.specificity,
  );
  if (specificityComparison !== 0) {
    return specificityComparison > 0;
  }

  return nextDeclaration.order >= previousDeclaration.order;
}

function inlineTransformedStyleRules(doc: Document): void {
  const originalInlineStyles = new WeakMap<Element, Record<string, string>>();
  const appliedCssDeclarations = new WeakMap<Element, Record<string, AppliedCssDeclaration>>();

  const getOriginalInlineStyles = (element: Element) => {
    let styles = originalInlineStyles.get(element);
    if (!styles) {
      styles = parseStyleString(element.getAttribute("style") || "");
      originalInlineStyles.set(element, styles);
    }
    return styles;
  };

  const getAppliedCssDeclarations = (element: Element) => {
    let declarations = appliedCssDeclarations.get(element);
    if (!declarations) {
      declarations = {};
      appliedCssDeclarations.set(element, declarations);
    }
    return declarations;
  };

  let ruleOrder = 0;
  const styleElements = Array.from(doc.querySelectorAll("style"));
  styleElements.forEach((styleElement) => {
    if ((styleElement.getAttribute("media") || "").trim()) {
      return;
    }

    const css = stripCssComments(styleElement.textContent || "");

    forEachTopLevelCssRule(css, (selectorText, declarationBlock) => {
      const currentRuleOrder = ruleOrder++;
      const declarations = parseCssDeclarationBlock(declarationBlock);
      if (declarations.length === 0) {
        return;
      }

      selectorText
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean)
        .forEach((selector) => {
          const specificity = calculateCssSpecificity(selector);
          let matchedElements: Element[];
          try {
            matchedElements = Array.from(doc.querySelectorAll(selector));
          } catch {
            return;
          }

          matchedElements.forEach((element) => {
            const originalStyles = getOriginalInlineStyles(element);
            const appliedDeclarations = getAppliedCssDeclarations(element);
            const updates: Record<string, string> = {};

            declarations.forEach(({ property, value, important }) => {
              const originalValue = originalStyles[property];
              const nextDeclaration = {
                important,
                specificity,
                order: currentRuleOrder,
              };

              if (
                !shouldApplyCssDeclaration(
                  originalValue,
                  appliedDeclarations[property],
                  nextDeclaration,
                )
              ) {
                return;
              }

              updates[property] = important ? `${value} !important` : value;
              appliedDeclarations[property] = nextDeclaration;
            });

            if (Object.keys(updates).length === 0) {
              return;
            }

            element.setAttribute(
              "style",
              updateStyleAttribute(element.getAttribute("style") || "", updates),
            );
          });
        });
    });
  });
}

function getPreservedBodyBackgroundColor(
  body: HTMLElement,
  options: DarkModeOptions,
): string | null {
  const explicitBackground = extractElementColors(body).background;
  if (!explicitBackground || !isValidColor(explicitBackground)) {
    return null;
  }

  const transformedBackground = transformBackgroundValue(explicitBackground, options);
  if (!transformedBackground || !isValidColor(transformedBackground)) {
    return null;
  }

  const backgroundAnalysis = analyzeColor(transformedBackground);
  if (
    backgroundAnalysis.alpha < 1 ||
    transformedBackground.toLowerCase() === options.darkBackground!.toLowerCase()
  ) {
    return null;
  }

  return transformedBackground;
}

function wrapWithBodyBackground(html: string, backgroundColor: string): string {
  return `<div data-email-body-background="true" style="background-color: ${backgroundColor} !important; width: 100%; box-sizing: border-box">${html}</div>`;
}

function setupBaseDarkTheme(doc: Document, options: DarkModeOptions): string | null {
  // Set body background and text color
  const body = doc.body;
  let preservedBodyBackground: string | null = null;
  if (body) {
    preservedBodyBackground = getPreservedBodyBackgroundColor(body, options);
    const currentStyle = body.getAttribute("style") || "";
    const newStyle = updateStyleAttribute(currentStyle, {
      "background-color": (preservedBodyBackground || options.darkBackground!) + " !important",
      color: options.lightText! + " !important",
    });
    body.setAttribute("style", newStyle);
  }

  // Handle html element as well
  const html = doc.documentElement;
  if (html) {
    const currentStyle = html.getAttribute("style") || "";
    const newStyle = updateStyleAttribute(currentStyle, {
      "background-color": options.darkBackground! + " !important",
    });
    html.setAttribute("style", newStyle);
  }

  return preservedBodyBackground;
}

function transformElements(doc: Document, options: DarkModeOptions): void {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);

  const elements: Element[] = [];
  let currentNode: Node | null = walker.nextNode();

  while (currentNode) {
    if (currentNode.nodeType === Node.ELEMENT_NODE) {
      elements.push(currentNode as Element);
    }
    currentNode = walker.nextNode();
  }

  // Transform each element
  elements.forEach((element) => transformElement(element, options));
}

function asOpaqueColor(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const color = cleanCssColorValue(value);
  return isValidColor(color) && analyzeColor(color).alpha === 1 ? color : null;
}

function resolveOwnBackgroundColor(
  element: Element,
  styleUpdates: Record<string, string>,
  options: DarkModeOptions,
): string | null {
  const styles = parseStyleString(element.getAttribute("style") || "");
  const candidates = [
    styleUpdates["background-color"],
    styleUpdates.background,
    styles["background-color"],
    styles.background,
  ];

  for (const candidate of candidates) {
    const color = asOpaqueColor(candidate);
    if (color) {
      return color;
    }
  }

  const bgcolor = element.getAttribute("bgcolor");
  return bgcolor && isValidColor(bgcolor)
    ? transformBackgroundColor(bgcolor, options.darkBackground)
    : null;
}

function resolveAncestorBackgroundColor(element: Element, options: DarkModeOptions): string {
  let ancestor = element.parentElement;
  while (ancestor) {
    const color = resolveOwnBackgroundColor(ancestor, {}, options);
    if (color) {
      return color;
    }
    ancestor = ancestor.parentElement;
  }

  return options.darkBackground!;
}

function transformElement(element: Element, options: DarkModeOptions): void {
  const tagName = element.tagName.toLowerCase();
  const currentStyle = element.getAttribute("style") || "";
  const currentStyles = parseStyleString(currentStyle);
  const colors = extractElementColors(element);
  const isInsideLink = tagName !== "a" && Boolean(element.closest("a[href]"));
  const styleUpdates: Record<string, string> = {};

  // Check for background or background-color in inline styles
  const backgroundColor = currentStyles["background-color"]
    ? cleanCssColorValue(currentStyles["background-color"])
    : undefined;
  const background = currentStyles.background
    ? cleanCssColorValue(currentStyles.background)
    : undefined;

  if (backgroundColor) {
    // Transform background colors dynamically
    const transformedBg = transformBackgroundValue(backgroundColor, options);
    if (transformedBg) {
      styleUpdates["background-color"] = transformedBg + " !important";
    }
  } else if (background) {
    // Check if it's a decorative frame image that should be removed in dark mode
    if (background.includes("url(") && isDecorativeFrameImage(background)) {
      styleUpdates["background"] = "none !important";
      styleUpdates["background-color"] = options.darkBackground! + " !important";
    } else {
      const transformedBg = transformBackgroundPaintValue(background, options);
      if (transformedBg) {
        styleUpdates["background"] = transformedBg + " !important";
      }
    }
  }

  // Force background colors for background elements, but only if they have explicit backgrounds
  if (BACKGROUND_TAGS.has(tagName)) {
    if (colors.background) {
      const transformedBg = transformBackgroundValue(colors.background, options);
      if (transformedBg) {
        styleUpdates["background-color"] = transformedBg + " !important";
      }
    } else {
      // Only force dark background for body and elements that truly need it
      if (tagName === "body") {
        styleUpdates["background-color"] = options.darkBackground! + " !important";
      }

      // For tables, be very conservative - don't add backgrounds unless absolutely necessary
      // This prevents gray boxes from appearing on structural/layout tables
      if (tagName === "table") {
        const className = element.getAttribute("class") || "";
        // Only add background for very specific container classes, not generic "email" classes
        if (
          className.includes("nl-container") ||
          className.includes("row-content") ||
          className.includes("message-content")
        ) {
          styleUpdates["background-color"] = options.darkBackground! + " !important";
        }
        // Don't add background for tables with generic classes like "email-button"
        // Let them inherit or be transparent to avoid gray boxes
      }
    }
  }

  const ownBackgroundColor = resolveOwnBackgroundColor(element, styleUpdates, options);
  const textBackgroundColor =
    ownBackgroundColor || resolveAncestorBackgroundColor(element, options);

  // Keep explicit sender link colors unless they are near-black and unreadable.
  if (tagName === "a") {
    if (colors.color && isValidColor(colors.color)) {
      const readableColor = transformExplicitLinkColor(colors.color, textBackgroundColor, options);

      if (!readableColor) {
        delete styleUpdates["color"];
      } else {
        styleUpdates["color"] = `${readableColor} !important`;
      }
    } else if (colors.color) {
      const transformed = transformTextValue(colors.color, options, textBackgroundColor);
      if (transformed && !options.preserveBrands) {
        styleUpdates["color"] =
          ensureContrast(transformed, textBackgroundColor, options.minContrast) + " !important";
      }
    } else {
      // No existing color
      styleUpdates["color"] =
        ensureContrast(options.linkColor!, textBackgroundColor, options.minContrast) +
        " !important";
    }
  }

  // Transform explicit text colors on every element, including tags such as small and code.
  if (tagName !== "a" && colors.color) {
    const transformedColor = isInsideLink
      ? transformExplicitLinkColor(colors.color, textBackgroundColor, options)
      : transformTextValue(colors.color, options, textBackgroundColor);
    if (transformedColor) {
      styleUpdates["color"] =
        ensureContrast(transformedColor, textBackgroundColor, options.minContrast) + " !important";
    }
  } else if (tagName !== "a" && ownBackgroundColor && !isInsideLink) {
    // Establish a readable inherited color for descendants of an explicit background.
    styleUpdates["color"] =
      ensureContrast(options.lightText!, ownBackgroundColor, options.minContrast) + " !important";
  }

  // Handle border colors
  if (colors.borderColor) {
    const transformedBorderColor = transformBorderValue(colors.borderColor);
    if (transformedBorderColor) {
      styleUpdates["border-color"] = transformedBorderColor + " !important";
    }
  }

  // Handle border shorthand properties in inline styles
  const borderShorthandMatch = currentStyle.match(
    /border(-top|-right|-bottom|-left)?\s*:\s*([^;]+)/i,
  );
  if (borderShorthandMatch) {
    const [, side, value] = borderShorthandMatch;
    const parts = value.trim().split(/\s+/);
    let hasColorTransformation = false;

    const transformedParts = parts.map((part: string) => {
      if (isValidColor(part)) {
        hasColorTransformation = true;
        return transformBorderColor(part);
      }
      return part;
    });

    if (hasColorTransformation) {
      const borderProperty = side ? `border${side}` : "border";
      styleUpdates[borderProperty] = transformedParts.join(" ") + " !important";
    }
  }

  // Handle problematic mix-blend-mode in inline styles
  const mixBlendMatch = currentStyle.match(/mix-blend-mode\s*:\s*([^;!]+)(\s*!important)?/i);
  if (mixBlendMatch) {
    const [, blendMode, important] = mixBlendMatch;
    const cleanBlendMode = blendMode.trim();

    // Convert problematic blend modes to normal for better contrast in dark mode
    if (cleanBlendMode === "multiply" || cleanBlendMode === "darken") {
      const importantSuffix = important ? " !important" : "";
      styleUpdates["mix-blend-mode"] = `normal${importantSuffix}`;
    }
  }

  transformInlineCustomProperties(currentStyle, styleUpdates, options);

  // Handle special elements
  handleSpecialElements(element, styleUpdates, options);

  // Apply style updates
  const newStyle = updateStyleAttribute(currentStyle, styleUpdates);
  if (newStyle) {
    element.setAttribute("style", newStyle);
  } else {
    element.removeAttribute("style");
  }

  // Handle legacy HTML attributes
  handleLegacyAttributes(element, options);
}

function handleSpecialElements(
  element: Element,
  styleUpdates: Record<string, string>,
  options: DarkModeOptions,
): void {
  const tagName = element.tagName.toLowerCase();

  switch (tagName) {
    case "table":
    case "td":
    case "th":
      handleTableElement(element, styleUpdates, options);
      break;

    case "hr":
      // Keep email separators as thin rules instead of filled bars.
      const hrBorderColor = transformBorderColor("#cccccc");
      styleUpdates["background-color"] = "transparent !important";
      styleUpdates["border"] = "0 !important";
      styleUpdates["border-top"] = `1px solid ${hrBorderColor} !important`;
      styleUpdates["height"] = "0 !important";
      break;

    case "img":
      // Also check for border styles on images
      const imgStyle = element.getAttribute("style") || "";
      if (
        imgStyle.includes("border") &&
        (imgStyle.includes("#F5F5F5") || imgStyle.includes("#eee"))
      ) {
        // Force better border visibility on images
        if (imgStyle.includes("#F5F5F5")) {
          styleUpdates["border-color"] = "#666666 !important";
        }
        if (imgStyle.includes("#eee")) {
          styleUpdates["border-color"] = "#555555 !important";
        }
      }
      break;
  }
}

function handleTableElement(
  element: Element,
  styleUpdates: Record<string, string>,
  options: DarkModeOptions,
): void {
  // Handle bgcolor attribute
  const bgcolor = element.getAttribute("bgcolor");
  if (bgcolor && isValidColor(bgcolor)) {
    styleUpdates["background-color"] =
      transformBackgroundColor(bgcolor, options.darkBackground) + " !important";
    element.removeAttribute("bgcolor");
  }

  // Convert legacy border colors without removing the sender's border or spacing.
  const borderColor = element.getAttribute("bordercolor");
  if (borderColor && isValidColor(borderColor)) {
    styleUpdates["border-color"] = transformBorderColor(borderColor) + " !important";
    element.removeAttribute("bordercolor");
  }
}

function handleLegacyAttributes(element: Element, options: DarkModeOptions): void {
  // Handle font color attributes
  const color = element.getAttribute("color");
  if (color && isValidColor(color)) {
    const currentStyle = element.getAttribute("style") || "";
    const backgroundColor =
      resolveOwnBackgroundColor(element, {}, options) ||
      resolveAncestorBackgroundColor(element, options);
    const transformedColor =
      ensureContrast(
        transformTextColor(color, backgroundColor),
        backgroundColor,
        options.minContrast,
      ) + " !important";
    const newStyle = updateStyleAttribute(currentStyle, {
      color: transformedColor,
    });
    element.setAttribute("style", newStyle);
    element.removeAttribute("color");
  }

  // Handle bgcolor attributes
  const bgcolor = element.getAttribute("bgcolor");
  if (bgcolor && isValidColor(bgcolor)) {
    const currentStyle = element.getAttribute("style") || "";
    const transformedBg = transformBackgroundColor(bgcolor, options.darkBackground) + " !important";
    const newStyle = updateStyleAttribute(currentStyle, {
      "background-color": transformedBg,
    });
    element.setAttribute("style", newStyle);
    element.removeAttribute("bgcolor");
  }
}

function ensureOverallContrast(doc: Document, options: DarkModeOptions): void {
  const elements = doc.querySelectorAll('[style*="color"]');

  elements.forEach((element) => {
    const style = element.getAttribute("style") || "";
    const colors = extractElementColors(element);

    if (
      element.tagName.toLowerCase() === "a" &&
      options.preserveBrands &&
      colors.color &&
      shouldPreserveExplicitLinkColor(
        colors.color,
        resolveContrastBackgroundColor(
          colors.background || options.darkBackground!,
          options.darkBackground!,
        ),
        options.minContrast,
      )
    ) {
      return;
    }

    if (
      colors.color &&
      colors.background &&
      isValidColor(colors.color) &&
      isValidColor(colors.background)
    ) {
      const adjustedColor = ensureContrast(colors.color, colors.background, options.minContrast);

      if (adjustedColor !== colors.color) {
        const newStyle = updateStyleAttribute(style, { color: adjustedColor });
        element.setAttribute("style", newStyle);
      }
    }
  });
}

function updateStyleAttribute(currentStyle: string, updates: Record<string, string>): string {
  const declarations = parseInlineStyleDeclarations(currentStyle);
  const normalizedUpdates = new Map(
    Object.entries(updates).map(([property, value]) => [normalizeCssPropertyName(property), value]),
  );
  const winningIndices = new Map<string, number>();

  declarations.forEach((declaration, index) => {
    if (!normalizedUpdates.has(declaration.property)) {
      return;
    }

    const previousIndex = winningIndices.get(declaration.property);
    const previous = previousIndex === undefined ? undefined : declarations[previousIndex];
    if (!previous || !isImportantValue(previous.value) || isImportantValue(declaration.value)) {
      winningIndices.set(declaration.property, index);
    }
  });

  const serialized = declarations.map(({ property, value }, index) => {
    const update = normalizedUpdates.get(property);
    return `${property}: ${winningIndices.get(property) === index ? update : value}`;
  });

  normalizedUpdates.forEach((value, property) => {
    if (!winningIndices.has(property)) {
      serialized.push(`${property}: ${value}`);
    }
  });

  return serialized.join("; ");
}

function parseStyleString(styleString: string): Record<string, string> {
  const styles: Record<string, string> = {};

  parseInlineStyleDeclarations(styleString).forEach(({ property, value }) => {
    const previous = styles[property];
    if (!previous || !isImportantValue(previous) || isImportantValue(value)) {
      styles[property] = value;
    }
  });

  return styles;
}

type InlineStyleDeclaration = {
  property: string;
  value: string;
};

function parseInlineStyleDeclarations(styleString: string): InlineStyleDeclaration[] {
  return splitCssDeclarations(styleString).flatMap((declaration) => {
    const colonIndex = declaration.indexOf(":");
    if (colonIndex <= 0) {
      return [];
    }

    const property = normalizeCssPropertyName(declaration.slice(0, colonIndex));
    const value = declaration.slice(colonIndex + 1).trim();
    return property && value ? [{ property, value }] : [];
  });
}

function splitCssDeclarations(styleString: string): string[] {
  const declarations: string[] = [];
  let declarationStart = 0;
  let parenthesisDepth = 0;

  for (let index = 0; index < styleString.length; index++) {
    const char = styleString[index];
    if (char === '"' || char === "'") {
      index = findCssStringEnd(styleString, index, char) - 1;
    } else if (char === "(") {
      parenthesisDepth++;
    } else if (char === ")" && parenthesisDepth > 0) {
      parenthesisDepth--;
    } else if (char === ";" && parenthesisDepth === 0) {
      declarations.push(styleString.slice(declarationStart, index).trim());
      declarationStart = index + 1;
    }
  }

  declarations.push(styleString.slice(declarationStart).trim());
  return declarations.filter(Boolean);
}
