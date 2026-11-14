import { findCssUrls, replaceCssUrls } from "./css-urls";

export interface TrackingPixelReport {
  totalImages: number;
  blockedCount: number;
  allowedCount: number;
  trackingPixels: TrackingPixelDetail[];
}

export interface TrackingPixelDetail {
  url: string;
  domain: string;
  reason: string;
}

export const TRACKING_RULESET_METADATA = {
  version: "2026-11-14.1",
  auditedAt: "2026-07-18",
  sources: [
    "https://github.com/AdguardTeam/AdguardFilters/tree/master/MailTrackingFilter",
    "https://github.com/OneClickLab/ugly-email-trackers/blob/master/list.txt",
    "https://github.com/trockerapp/trocker/blob/master/chrome/lists.js",
  ],
} as const;

const TRACKING_PROVIDER_DOMAINS = [
  "mailchimp.com",
  "list-manage.com",
  "list-manage1.com",
  "constantcontact.com",
  "sendgrid.net",
  "mailgun.org",
  "mandrill.com",
  "mandrillapp.com",
  "postmarkapp.com",
  "aweber.com",
  "getresponse.com",
  "convertkit.com",
  "drip.com",
  "google-analytics.com",
  "doubleclick.net",
  "mixpanel.com",
  "amplitude.com",
  "icptrack.com",
  "mkt4477.com",
  "strongview.com",
  "salesforceiq.com",
  "sendibm1.com",
  "esputnik.com",
];

const TRACKING_DOMAINS = [
  "ct.sendgrid.net",
  "pstmrk.it",
  "bl-1.com",
  "t.yesware.com",
  "mailfoogae.appspot.com",
  "mltrk.io",
  "mailtrack.io",
  "emltrk.com",
  "mailstat.us",
  "tracking.cirrusinsight.com",
  "r.superhuman.com",
  "openrate.aweber.com",
  "t.hubspotemail.net",
  "track.getsidekick.com",
  "hubspotlinks.com",
  "beacon.krxd.net",
  "ping.answerbook.com",
  "pixel.watch",
  "awstrack.me",
  "e.customeriomail.com",
  "track.customer.io",
  "clicks.mlsend.com",
  "clicks.mlsend2.com",
  "click.mailersend.net",
  "link.mail.beehiiv.com",
  "eotrx.substackcdn.com",
  "email.mg-d1.substack.com",
  "flask.us.nextdoor.com",
  "email.mgtp01.squarespace-mail.com",
  "emailtracking.cashstar.com",
  "onelink.soundcloud.com",
  "email-link.adtidy.org",
  "supersender.yandex.net",
  "click.sender.yandex.ru",
  "feedback.send.yandex.ru",
  "api.peeper.plus.yandex.net",
  "image-sap.sfmc-content.com",
  "postoffice.adobe.com",
  "elink.clickdimensions.com",
  "click.revolut.com",
];

const TRACKING_HOST_PATTERNS = [
  /^open\.convertkit-mail\d*\.com$/i,
  /^t\.(?:hubspotemail|hubspotfree)\.net$/i,
  /^t\.(?:sidekickopen|sigopn)\d*\.com$/i,
  /^t\.hsms\d{2}\.com$/i,
  /^t\.senal(?:uno|dos|tres|quatro|cinco)\.com$/i,
  /^t\.signale(?:una|due|tre|quattro|cinque)\.com$/i,
  /^t\.signaux(?:un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\.com$/i,
  /^t\.strk\d{2}\.email$/i,
];

// Image URLs in email are untrusted and unbounded, so every pattern must run in linear time. A
// pattern is a regular expression, a list of expressions that must match in order (each after the
// end of the previous match), or a function. Lists replace `a.*b`, which backtracks over the rest
// of the URL from every match of `a`: a crafted 23 KB URL made one check take seconds. Functions
// replace the two expressions that backtracked from every occurrence of their prefix.
type TrackingPattern = RegExp | readonly RegExp[] | ((value: string) => boolean);

const EMAIL_TRACKING_PATTERNS: TrackingPattern[] = [
  /\/track\/open\.php\?u=/i,
  /\/wf\/open\?upn=/i,
  /dripemail2/i,
  /icptrack\.com\/icp\/track/i,
  /mkt4477\.com\/open/i,
  /strongview\.com\/t\//i,
  hasBase64OpenPath,
  /mixmax\.com\/api\/track\//i,
  /mixmax\.com\/e\/o/i,
  [/\/\/tracking/i, /\/api\/track\/v2\//i],
  /contactmonkey\.com\/api\/v1\/tracker/i,
  [/\/\//, /\.convertkit-mail[1-9]?\.com\/o\//i],
  /polymail\.io(\/v2\/z\/)?/i,
  /share\.polymail\.io/i,
  /yamm-track\.appspot/i,
  /\/open\.html\?x=/i,
  /\/ut\.php\?u=/i,
  /close\.io\/email_opened/i,
  /\/\/ml\.closeml\.com\/t\/\w+\/\w+\.png/i,
  /\.cc\.rs6\.net\/on\.jsp/i,
  /\/trk\?t=/i,
  /returnpath\.net\/pixel\.gif/i,
  /(outrch|whosen|getoutreach)\.com\/api\/mailings\/opened/i,
  [/\/\//, /\.intercom-\w+\.com(?:\/via)?\//i],
  [/\/\/links\./i, /\/oo\//i],
  /\.mjt\.lu\//i,
  [/\/oo\//i, /\.gif/i],
  /nethunt\.com\/api\/v1\/track\/email\//i,
  /apple\.com\/report\/2\/its_mail_sf/i,
  /\/o\/\w{10}\/\w{10}\//i,
  [/lt\.php/i, /\?l=open/i],
  /email81\.com\/case/i,
  /growthdot\.com\/api\/mail-tracking/i,
  /\/e2t\/(o|c|to)\//i,
  /getmailspring\.com\/open/i,
  /mixpanel\.com\/(trk|track)/i,
  /go\.sparkpostmail2\.com\/q\//i,
  [/\/\/click\./i, /\/open\.aspx/i],
  /infinite-stream-5194\.herokuapp\.com\/pixel\//i,
  /sailthru\.com\/trk/i,
  /trackapp\.io\/static\/img\/track\.gif/i,
  /trackapp\.io\/[a-z]\//i,
  /sendib\w{2}\.com\/track\//i,
  /email\.segment\.com\/e\/o\//i,
  /salesloft\.com\/email_trackers/i,
  /salesloftlinks\.com\/t\//i,
  /saleshandy\.com\/web\/email\/countopened/i,
  /\/tools\/emails\/open\//i,
  /\/\w*I0\/\w{16}-\w{8}-\w{4}/i,
  /\/open\/\d{3}\/\w{10}/i,
  [/\/\//, /\.enewsletter\.pl\//i, /\.gif/i],
  /\/optiext\/optiextension\.dll\?ID=/i,
  [/\/\/mx\.technolutions\.net\/ss\/o\//i, /\/ho\.gif/i],
  /\/\/tracking\.vocus\.io\//i,
  /\/tr\/op\//i,
  /\/m\/opening\//i,
  /\/r\/\?id=/i,
  /\/a360\/public\/statistic\//i,
  /\/t\/[^/]+\/a(?:[/?#]|$)/i,
  /\/pix\.gif\?/i,
  /\/tf\/o\//i,
  /\/via\/o\?h=/i,
  /\/eos\/v1\//i,
  [/\/gp\/r\.html\?/i, /ref_=pe_/i, /_open/i],
  /\/pub\/as\?_ri_=/i,
  /\/q\/[^/]+~~\//i,
  /\/s\/eo\//i,
  /\/o\.gif\?mi_u=/i,
  /\/pixel\?c=/i,
  /\/CI0\/0/i,
  /\/ss\/o\/[^/]+\/ho\.gif/i,
  /github\.com\/notifications\/beacon(?:=|\/)/i,
  /t\.paypal\.com\/ts\?v=/i,
  /click\.emails\.paypal\.com/i,
  /cdn\.shopify\.com\/shopifycloud\/shopify\/assets\/themes_support\/notifications\/spacer-/i,
  [/link\.mail\.beehiiv\.com\/ss\//i, /\.gif/i],
  /line\.my\.salesforce\.com\/servlet\/servlet\.ImageServer\?/i,
  hasEmailOpenPath,
];

const GENERIC_TRACKING_PATHS: TrackingPattern[] = [
  /\/(?:track|pixel|open|beacon|counter|analytics|stats|metrics|monitor)(?:[./?_-]|$)/i,
  /\/e\/o(?:[/?#]|$)/i,
  [/email/i, /track/i],
  [/track/i, /email/i],
  [/newsletter/i, /track/i],
  [/campaign/i, /track/i],
  [/marketing/i, /track/i],
];

const BASE64_CHARACTER = /[0-9a-z+/]/i;

// Matches what /\/e\/o\/(?:[0-9a-z+/]{4})+(?:[0-9a-z+/]{2}==|[0-9a-z+/]{3}=)?(?:[/?#]|$)/i
// matches: `/e/o/`, whole groups of four base64 characters with optional padding, then `/`, `?`,
// `#` or the end. Because `/` is a base64 character, the expression can end at any `/` a multiple
// of four characters into the run. Each run of base64 characters is scanned once.
export function hasBase64OpenPath(value: string): boolean {
  const text = value.toLowerCase();
  const ends = (position: number) => position === text.length || "/?#".includes(text[position]!);
  let marker = text.indexOf("/e/o/");
  while (marker !== -1) {
    // `/e/o/` is made of base64 characters, so every marker in this run shares its end.
    let runEnd = marker;
    while (runEnd < text.length && BASE64_CHARACTER.test(text[runEnd]!)) runEnd += 1;
    const lastSlashByOffset = [-1, -1, -1, -1];
    for (let position = marker + 5; position < runEnd; position += 1)
      if (text[position] === "/") lastSlashByOffset[position % 4] = position;

    for (; marker !== -1 && marker + 5 <= runEnd; marker = text.indexOf("/e/o/", marker + 1)) {
      const groupsStart = marker + 5;
      const length = runEnd - groupsStart;
      if (lastSlashByOffset[groupsStart % 4]! >= groupsStart + 4) return true;
      if (length >= 4 && length % 4 === 0 && ends(runEnd)) return true;
      if (length >= 6 && length % 4 === 2 && text.startsWith("==", runEnd) && ends(runEnd + 2))
        return true;
      if (length >= 7 && length % 4 === 3 && text[runEnd] === "=" && ends(runEnd + 1)) return true;
    }
  }
  return false;
}

// Matches what /email\.[^/]+\.com\/o(?:[/?#]|$)/i matches: a path segment that contains
// `email.` and ends in `.com` with at least one character between them, followed by `/o` and then
// `/`, `?`, `#` or the end.
export function hasEmailOpenPath(value: string): boolean {
  const segments = value.toLowerCase().split("/");
  return segments.some((segment, index) => {
    const marker = segment.indexOf("email.");
    const next = segments[index + 1];
    return (
      marker !== -1 &&
      segment.endsWith(".com") &&
      marker + 6 < segment.length - 4 &&
      next !== undefined &&
      /^o(?:[?#]|$)/.test(next)
    );
  });
}

const TRACKING_QUERY_PREFIXES = [
  "email_",
  "campaign_",
  "track_",
  "subscriber_",
  "user_id",
  "recipient_",
  "message_id",
  "list_id",
  "open_",
  "view_",
  "read_",
];

const TRACKING_SUBDOMAIN_LABELS = new Set([
  "track",
  "tracker",
  "tracking",
  "pixel",
  "open",
  "analytics",
  "stats",
  "metrics",
  "beacon",
  "counter",
  "monitor",
]);

const ALLOWLIST = [
  {
    hostname: "permies.com",
    pathname: /^\/t\/[^/]+\/a\/?$/i,
  },
];

function matchesPattern(value: string, pattern: TrackingPattern): boolean {
  if (pattern instanceof RegExp) return pattern.test(value);
  if (typeof pattern === "function") return pattern(value);
  let position = 0;
  for (const part of pattern) {
    const match = part.exec(value.slice(position));
    if (!match) return false;
    position += match.index + match[0].length;
  }
  return true;
}

function matchesAnyPattern(value: string, patterns: TrackingPattern[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function hostnameMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function parseRemoteUrl(source: string): URL | undefined {
  try {
    const url = new URL(source);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function isAllowlisted(url: URL): boolean {
  return ALLOWLIST.some(
    (rule) =>
      hostnameMatches(url.hostname.toLowerCase(), rule.hostname) &&
      rule.pathname.test(url.pathname),
  );
}

function trackingReason(source: string, aggressiveHeuristics: boolean): string | undefined {
  const url = parseRemoteUrl(source);
  if (!url || isAllowlisted(url)) return undefined;

  // Match the parsed URL, which drops the tabs and newlines a browser ignores when it loads one.
  const hostname = url.hostname.toLowerCase();
  if (matchesAnyPattern(url.href.toLowerCase(), EMAIL_TRACKING_PATTERNS))
    return "Known tracking pattern";
  if (TRACKING_DOMAINS.some((domain) => hostnameMatches(hostname, domain)))
    return "Known tracking service";
  if (TRACKING_HOST_PATTERNS.some((pattern) => pattern.test(hostname)))
    return "Known tracking service";
  if (!aggressiveHeuristics) return undefined;

  if (TRACKING_PROVIDER_DOMAINS.some((domain) => hostnameMatches(hostname, domain)))
    return "Known tracking service";
  if (hostname.split(".").some((label) => TRACKING_SUBDOMAIN_LABELS.has(label)))
    return "Tracking subdomain";
  if (matchesAnyPattern(`${url.pathname}${url.search}`, GENERIC_TRACKING_PATHS))
    return "Tracking URL";

  const hasTrackingParameter = [...url.searchParams.keys()].some((key) =>
    TRACKING_QUERY_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix)),
  );
  return hasTrackingParameter && /(?:pixel|track|open|beacon|spacer|1x1|\.gif$)/i.test(url.pathname)
    ? "Tracking parameter"
    : undefined;
}

interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

function parseSrcsetCandidates(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let position = 0;
  while (position < value.length) {
    while (/[\s,]/.test(value[position] || "")) position += 1;
    if (position >= value.length) break;

    const urlStart = position;
    while (position < value.length && !/\s/.test(value[position])) position += 1;
    let urlEnd = position;
    while (urlEnd > urlStart && value[urlEnd - 1] === ",") urlEnd -= 1;
    const url = value.slice(urlStart, urlEnd);
    if (urlEnd < position) {
      if (url) candidates.push({ url, descriptor: "" });
      continue;
    }

    while (/\s/.test(value[position] || "")) position += 1;
    const descriptorStart = position;
    let parentheses = 0;
    while (position < value.length) {
      const character = value[position];
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses = Math.max(0, parentheses - 1);
      else if (character === "," && parentheses === 0) break;
      position += 1;
    }
    candidates.push({ url, descriptor: value.slice(descriptorStart, position).trim() });
    if (value[position] === ",") position += 1;
  }
  return candidates;
}

function serializeSrcsetCandidates(candidates: SrcsetCandidate[]): string {
  return candidates
    .map(({ url, descriptor }) => (descriptor ? `${url} ${descriptor}` : url))
    .join(", ");
}

function filterTrackingSrcset(
  value: string,
  aggressiveHeuristics: boolean,
): { candidates: SrcsetCandidate[]; trackingPixels: TrackingPixelDetail[] } {
  const candidates: SrcsetCandidate[] = [];
  const trackingPixels: TrackingPixelDetail[] = [];
  for (const candidate of parseSrcsetCandidates(value)) {
    const reason = trackingReason(candidate.url, aggressiveHeuristics);
    if (reason) trackingPixels.push(trackingPixelDetail(candidate.url, reason));
    else candidates.push(candidate);
  }
  return { candidates, trackingPixels };
}

function isLikelyContentImage(image: HTMLImageElement): boolean {
  const width = image.width || explicitPixelDimension(image, "width") || 0;
  const height = image.height || explicitPixelDimension(image, "height") || 0;
  const style = (image.getAttribute("style") || "").toLowerCase();
  return (
    width >= 64 ||
    height >= 64 ||
    /width\s*:\s*(?:100%|auto)/.test(style) ||
    /max-width\s*:\s*(?:100%|none|inherit)/.test(style)
  );
}

function explicitPixelDimension(
  image: HTMLImageElement,
  dimension: "width" | "height",
): number | undefined {
  const styleValue = image.style[dimension].trim();
  const styleMatch = /^([0-9]+(?:\.[0-9]+)?)px$/i.exec(styleValue);
  if (styleMatch) return Number(styleMatch[1]);
  if (styleValue === "0") return 0;

  const attributeValue = image.getAttribute(dimension);
  if (attributeValue === null) return undefined;
  const parsed = Number.parseInt(attributeValue, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function structuralTrackingReason(image: HTMLImageElement): string | undefined {
  const width = explicitPixelDimension(image, "width");
  const height = explicitPixelDimension(image, "height");
  if (width === 1 && height === 1) return "1 × 1 image";
  if (image.style.display === "none" || image.style.visibility === "hidden") return "Hidden image";
  if (width === 0 && height === 0) return "Zero-size image";
  if (width !== undefined && width > 0 && width <= 2) return `Image is ${width} px wide`;
  if (height !== undefined && height > 0 && height <= 2) return `Image is ${height} px tall`;
  return undefined;
}

function imageSources(image: HTMLImageElement): string[] {
  const source = image.getAttribute("src");
  return [
    source || "",
    ...parseSrcsetCandidates(image.getAttribute("srcset") || "").map(({ url }) => url),
  ].filter(Boolean);
}

function trackingPixelDetail(source: string, reason: string): TrackingPixelDetail {
  return { url: source, domain: parseRemoteUrl(source)?.hostname || "Unknown domain", reason };
}

function removeTrackingCssUrls(value: string): {
  value: string;
  trackingPixels: TrackingPixelDetail[];
} {
  const imageSetResult = removeTrackingImageSetCandidates(value);
  const trackingPixels = [...imageSetResult.trackingPixels];
  const cleaned = replaceCssUrls(imageSetResult.value, ({ url: source }, match) => {
    const reason = trackingReason(source, false);
    if (!reason) return match;
    trackingPixels.push(trackingPixelDetail(source, reason));
    return "none";
  });
  return { value: cleaned, trackingPixels };
}

function removeTrackingImageSetCandidates(value: string): {
  value: string;
  trackingPixels: TrackingPixelDetail[];
} {
  const trackingPixels: TrackingPixelDetail[] = [];
  const pattern = /(?:-webkit-)?image-set\s*\(/gi;
  let result = "";
  let copiedThrough = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const openParenthesis = pattern.lastIndex - 1;
    const closeParenthesis = findClosingParenthesis(value, openParenthesis);
    if (closeParenthesis === undefined) break;

    const candidates = splitCssFunctionArguments(
      value.slice(openParenthesis + 1, closeParenthesis),
    );
    const safeCandidates = candidates.filter((candidate) => {
      const source = cssImageCandidateUrl(candidate);
      const reason = source ? trackingReason(source, false) : undefined;
      if (!source || !reason) return true;
      trackingPixels.push(trackingPixelDetail(source, reason));
      return false;
    });
    if (safeCandidates.length === candidates.length) {
      pattern.lastIndex = closeParenthesis + 1;
      continue;
    }

    result += value.slice(copiedThrough, match.index);
    result += safeCandidates.length
      ? `${value.slice(match.index, openParenthesis + 1)}${safeCandidates.join(", ")})`
      : "none";
    copiedThrough = closeParenthesis + 1;
    pattern.lastIndex = copiedThrough;
  }
  return { value: result + value.slice(copiedThrough), trackingPixels };
}

function findClosingParenthesis(value: string, openParenthesis: number): number | undefined {
  let depth = 1;
  let quote = "";
  for (let position = openParenthesis + 1; position < value.length; position += 1) {
    const character = value[position];
    if (quote) {
      if (character === "\\") position += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  return undefined;
}

function splitCssFunctionArguments(value: string): string[] {
  const candidates: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let position = 0; position < value.length; position += 1) {
    const character = value[position];
    if (quote) {
      if (character === "\\") position += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      candidates.push(value.slice(start, position).trim());
      start = position + 1;
    }
  }
  candidates.push(value.slice(start).trim());
  return candidates.filter(Boolean);
}

function cssImageCandidateUrl(candidate: string): string | undefined {
  const stringMatch = /^(["'])(.*?)\1/.exec(candidate);
  if (stringMatch) return stringMatch[2];
  const [url] = findCssUrls(candidate);
  return url?.start === 0 ? url.url : undefined;
}

export function blockTrackingPixels(document: Document): TrackingPixelReport {
  const images = [...document.querySelectorAll<HTMLImageElement>("img")];
  let allowedCount = 0;
  const trackingPixels = new Map<string, TrackingPixelDetail>();
  const record = (detail: TrackingPixelDetail) => trackingPixels.set(detail.url, detail);

  for (const image of images) {
    const likelyContent = isLikelyContentImage(image);
    const source = image.getAttribute("src") || "";
    const sourceReason = trackingReason(source, !likelyContent);
    const srcsetResult = filterTrackingSrcset(image.getAttribute("srcset") || "", !likelyContent);
    const remoteSources = imageSources(image).filter((candidate) => parseRemoteUrl(candidate));
    const hasNonAllowlistedRemoteSource = remoteSources.some((candidate) => {
      const url = parseRemoteUrl(candidate);
      return url !== undefined && !isAllowlisted(url);
    });
    const structuralReason = hasNonAllowlistedRemoteSource
      ? structuralTrackingReason(image)
      : undefined;
    if (structuralReason) {
      for (const source of remoteSources) record(trackingPixelDetail(source, structuralReason));
      image.remove();
      continue;
    }

    if (sourceReason) {
      record(trackingPixelDetail(source, sourceReason));
      image.removeAttribute("src");
    }
    for (const detail of srcsetResult.trackingPixels) record(detail);
    if (srcsetResult.trackingPixels.length) {
      if (srcsetResult.candidates.length)
        image.setAttribute("srcset", serializeSrcsetCandidates(srcsetResult.candidates));
      else image.removeAttribute("srcset");
    }

    const safeSources = imageSources(image);
    if ((sourceReason || srcsetResult.trackingPixels.length) && !safeSources.length) image.remove();
    else allowedCount += safeSources.length;
  }

  for (const source of document.querySelectorAll("source[srcset]")) {
    const result = filterTrackingSrcset(source.getAttribute("srcset") || "", false);
    for (const detail of result.trackingPixels) record(detail);
    if (!result.trackingPixels.length) allowedCount += result.candidates.length;
    else if (result.candidates.length) {
      source.setAttribute("srcset", serializeSrcsetCandidates(result.candidates));
      allowedCount += result.candidates.length;
    } else source.remove();
  }

  for (const image of document.querySelectorAll("svg image")) {
    const sources = [image.getAttribute("href"), image.getAttribute("xlink:href")].filter(
      (source): source is string => Boolean(source),
    );
    const matched = sources.flatMap((source) => {
      const reason = trackingReason(source, false);
      return reason ? [trackingPixelDetail(source, reason)] : [];
    });
    if (matched.length) {
      for (const detail of matched) record(detail);
      image.remove();
    } else {
      allowedCount += sources.length;
    }
  }

  for (const element of document.querySelectorAll<HTMLElement>("[background]")) {
    const source = element.getAttribute("background") || "";
    const reason = trackingReason(source, false);
    if (reason) {
      record(trackingPixelDetail(source, reason));
      element.removeAttribute("background");
    } else if (source) {
      allowedCount += 1;
    }
  }

  for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
    const result = removeTrackingCssUrls(element.style.cssText);
    if (result.trackingPixels.length) {
      for (const detail of result.trackingPixels) record(detail);
      element.style.cssText = result.value;
    }
  }

  for (const style of document.querySelectorAll("style")) {
    const result = removeTrackingCssUrls(style.textContent || "");
    if (result.trackingPixels.length) {
      for (const detail of result.trackingPixels) record(detail);
      style.textContent = result.value;
    }
  }

  const details = [...trackingPixels.values()];
  return {
    totalImages: images.length,
    blockedCount: details.length,
    allowedCount,
    trackingPixels: details,
  };
}
