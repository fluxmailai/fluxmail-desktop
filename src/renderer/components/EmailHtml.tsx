import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Image as ImageIcon } from "lucide-react";
import { MAX_IMAGE_RELAY_URLS_PER_REQUEST, type MailMessage } from "../../shared/contracts";
import { parseExternalUrl } from "../../shared/external-url";
import { convertEmailToDarkMode, removeSenderDarkModeCSS } from "../email/convert-to-dark-mode";
import { collectRemoteImageUrls, rewriteRemoteImageUrls } from "../email/remote-images";
import { blockTrackingPixels, type TrackingPixelDetail } from "../email/tracking-pixels";

const EMPTY_IMAGE_URLS: Record<string, string> = {};
const EMAIL_SOURCE_ATTRIBUTE = "data-fluxmail-source";

export function EmailHtml({
  message,
  blockRemoteImages = true,
  imageRelay = true,
  imageRelayAvailable = true,
  findQuery = "",
  activeFindMatch,
  onError,
  onFindMatchCountChange,
  onTrackingPixelsChange,
}: {
  message: MailMessage;
  blockRemoteImages?: boolean;
  imageRelay?: boolean;
  imageRelayAvailable?: boolean;
  findQuery?: string;
  activeFindMatch?: number;
  onError?(message: string): void;
  onFindMatchCountChange?(count: number): void;
  onTrackingPixelsChange?(trackingPixels: TrackingPixelDetail[]): void;
}) {
  const [remoteImages, setRemoteImages] = useState<{
    policyKey: string;
    status: "blocked" | "loading" | "loaded";
    relayUrls?: Record<string, string>;
  }>(() => ({
    policyKey: remoteImagePolicyKey(message.id, blockRemoteImages, imageRelay, imageRelayAvailable),
    status: !blockRemoteImages && !imageRelay ? "loaded" : "blocked",
  }));
  const [inlineImages, setInlineImages] = useState<{
    messageId: string;
    urls: Record<string, string>;
  }>({ messageId: message.id, urls: {} });
  const [height, setHeight] = useState(120);
  const [frameVersion, setFrameVersion] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const attachedDocumentRef = useRef<Document | undefined>(undefined);
  const scheduleResizeRef = useRef<(() => void) | undefined>(undefined);
  const frameCleanupRef = useRef<(() => void) | undefined>(undefined);
  const darkMode = useResolvedDarkTheme();
  const rawHtml = message.body?.html || textToHtml(message.body?.text || "");
  const policyKey = remoteImagePolicyKey(
    message.id,
    blockRemoteImages,
    imageRelay,
    imageRelayAvailable,
  );
  const currentPolicyKeyRef = useRef(policyKey);
  const onFindMatchCountChangeRef = useRef(onFindMatchCountChange);
  const onErrorRef = useRef(onError);
  currentPolicyKeyRef.current = policyKey;
  onFindMatchCountChangeRef.current = onFindMatchCountChange;
  onErrorRef.current = onError;
  const currentRemoteImages =
    remoteImages.policyKey === policyKey
      ? remoteImages
      : {
          policyKey,
          status: !blockRemoteImages && !imageRelay ? ("loaded" as const) : ("blocked" as const),
        };
  const loadImages = currentRemoteImages.status === "loaded";
  const loadingImages = currentRemoteImages.status === "loading";
  const relayUnavailable = imageRelay && !imageRelayAvailable;
  const relayUrls = currentRemoteImages.relayUrls;
  const cidUrls = inlineImages.messageId === message.id ? inlineImages.urls : EMPTY_IMAGE_URLS;

  useEffect(() => () => frameCleanupRef.current?.(), []);

  const attachFrame = useCallback((document: Document) => {
    const frame = iframeRef.current;
    if (!frame) return;
    if (attachedDocumentRef.current === document) {
      scheduleResizeRef.current?.();
      return;
    }
    frameCleanupRef.current?.();
    attachedDocumentRef.current = document;
    setFrameVersion((current) => current + 1);
    const resize = () => {
      const scale = applyContentScaling(document, frame.clientWidth);
      const root = document.getElementById("email-root");
      const contentHeight = root
        ? Math.max(root.scrollHeight, root.offsetHeight) * scale
        : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const nextHeight = Math.max(80, Math.ceil(contentHeight));
      setHeight((current) => (current === nextHeight ? current : nextHeight));
    };
    resize();
    const view = document.defaultView;
    let active = true;
    let resizeFrame = 0;
    const scheduleResize = () => {
      if (!active || !view || resizeFrame) return;
      resizeFrame = view.requestAnimationFrame(() => {
        resizeFrame = 0;
        resize();
      });
    };
    scheduleResizeRef.current = scheduleResize;
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(document.body);
    observer.observe(document.documentElement);
    const root = document.getElementById("email-root");
    if (root) observer.observe(root);
    const frameObserver = new ResizeObserver(scheduleResize);
    frameObserver.observe(frame);
    document.addEventListener("load", scheduleResize, true);
    void document.fonts?.ready.then(scheduleResize);
    const forwardKeyboard = (event: KeyboardEvent) => {
      const forwarded = new KeyboardEvent(event.type, {
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) event.preventDefault();
    };
    const forwardPointer = () => window.dispatchEvent(new CustomEvent("iframe-pointerdown"));
    document.addEventListener("keydown", forwardKeyboard);
    document.addEventListener("pointerdown", forwardPointer);
    const openLink = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest("a");
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute("href");
      if (href)
        void window.fluxmail.system
          .openExternal(href)
          .catch((error) =>
            onErrorRef.current?.(
              error instanceof Error ? error.message : "Fluxmail could not open this link.",
            ),
          );
    };
    document.addEventListener("click", openLink);
    frameCleanupRef.current = () => {
      active = false;
      if (view && resizeFrame) view.cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      frameObserver.disconnect();
      document.removeEventListener("load", scheduleResize, true);
      document.removeEventListener("keydown", forwardKeyboard);
      document.removeEventListener("pointerdown", forwardPointer);
      document.removeEventListener("click", openLink);
    };
  }, []);

  useEffect(() => {
    const inline = (message.attachments ?? []).filter((attachment) => attachment.contentId);
    if (!inline.length) return;
    let canceled = false;
    void Promise.allSettled(
      inline.map(async (attachment) => {
        const data = await window.fluxmail.attachments.inlineData({
          accountId: message.accountId,
          messageId: message.id,
          attachmentId: attachment.id,
          mimeType: attachment.mimeType,
        });
        return [attachment.contentId!, data] as const;
      }),
    ).then((results) => {
      if (!canceled)
        setInlineImages({
          messageId: message.id,
          urls: Object.fromEntries(
            results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
          ),
        });
    });
    return () => {
      canceled = true;
    };
  }, [message.accountId, message.attachments, message.id]);

  const loadRemoteImages = useCallback(async () => {
    const requestPolicyKey = policyKey;
    if (!imageRelay) {
      setRemoteImages({ policyKey: requestPolicyKey, status: "loaded" });
      return;
    }
    if (!imageRelayAvailable) {
      setRemoteImages({ policyKey: requestPolicyKey, status: "blocked" });
      return;
    }
    const urls = collectRemoteImageUrls(rawHtml);
    if (!urls.length) {
      setRemoteImages({
        policyKey: requestPolicyKey,
        status: "loaded",
        relayUrls: {},
      });
      return;
    }
    setRemoteImages({ policyKey: requestPolicyKey, status: "loading" });
    try {
      const proxied = await proxyRemoteImageUrls(urls);
      if (currentPolicyKeyRef.current !== requestPolicyKey) return;
      setRemoteImages({
        policyKey: requestPolicyKey,
        status: "loaded",
        relayUrls: proxied,
      });
    } catch (error) {
      if (currentPolicyKeyRef.current !== requestPolicyKey) return;
      setRemoteImages({ policyKey: requestPolicyKey, status: "blocked" });
      onError?.(
        error instanceof Error
          ? error.message
          : "Fluxmail could not load images through the image relay.",
      );
    }
  }, [imageRelay, imageRelayAvailable, onError, policyKey, rawHtml]);

  useEffect(() => {
    if (blockRemoteImages) {
      setRemoteImages((current) =>
        current.policyKey === policyKey ? current : { policyKey, status: "blocked" },
      );
      return;
    }
    if (!imageRelay) {
      setRemoteImages({ policyKey, status: "loaded" });
      return;
    }
    if (!imageRelayAvailable) {
      setRemoteImages({ policyKey, status: "blocked" });
      return;
    }
    void loadRemoteImages();
  }, [blockRemoteImages, imageRelay, imageRelayAvailable, loadRemoteImages, policyKey]);
  const rendered = useMemo(
    () => buildEmailContent(rawHtml, cidUrls, loadImages, darkMode, relayUrls),
    [cidUrls, darkMode, loadImages, rawHtml, relayUrls],
  );

  useEffect(
    () => onTrackingPixelsChange?.(rendered.trackingPixels),
    [onTrackingPixelsChange, rendered.trackingPixels],
  );

  // The frame's load event waits for every remote image, so one slow image server would leave
  // the frame at its initial height. Start sizing as soon as the new document has been parsed.
  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    let pollFrame = 0;
    const poll = () => {
      const document = frame.contentDocument;
      if (
        document &&
        document.readyState !== "loading" &&
        document.getElementById("email-root")?.getAttribute(EMAIL_SOURCE_ATTRIBUTE) ===
          rendered.sourceId
      ) {
        attachFrame(document);
        return;
      }
      pollFrame = window.requestAnimationFrame(poll);
    };
    poll();
    return () => window.cancelAnimationFrame(pollFrame);
  }, [attachFrame, rendered.sourceId]);

  useEffect(() => {
    const document = iframeRef.current?.contentDocument;
    if (!document) return;
    const matches = highlightEmailMatches(document, findQuery);
    onFindMatchCountChangeRef.current?.(matches.length);
    return () => clearEmailFindHighlights(document);
  }, [findQuery, frameVersion, rendered.source]);

  useEffect(() => {
    const frame = iframeRef.current;
    const document = frame?.contentDocument;
    if (!document) return;
    const active = activateEmailFindMatch(document, activeFindMatch);
    if (frame && active) scrollEmailFindMatchIntoView(frame, active);
  }, [activeFindMatch, findQuery, frameVersion, rendered.source]);

  useEffect(
    () => () => {
      onFindMatchCountChangeRef.current?.(0);
    },
    [],
  );

  return (
    <div className="email-html-wrap">
      {!loadImages && hasRemoteImages(rawHtml) ? (
        <button
          className="load-images"
          disabled={loadingImages || relayUnavailable}
          onClick={loadRemoteImages}
        >
          <ImageIcon size={14} />
          {relayUnavailable
            ? "Image relay unavailable"
            : loadingImages
              ? "Loading images..."
              : "Load remote images"}
        </button>
      ) : null}
      <iframe
        ref={iframeRef}
        title="Email message"
        className="email-frame"
        sandbox="allow-same-origin"
        srcDoc={rendered.source}
        style={{ height }}
        onLoad={() => {
          const document = iframeRef.current?.contentDocument;
          if (document) attachFrame(document);
        }}
      />
    </div>
  );
}

export function buildEmailDocument(
  rawHtml: string,
  cidUrls: Record<string, string>,
  loadImages: boolean,
  darkMode = false,
  relayUrls?: Record<string, string>,
): string {
  return buildEmailContent(rawHtml, cidUrls, loadImages, darkMode, relayUrls).source;
}

function buildEmailContent(
  rawHtml: string,
  cidUrls: Record<string, string>,
  loadImages: boolean,
  darkMode = false,
  relayUrls?: Record<string, string>,
): { source: string; sourceId: string; trackingPixels: TrackingPixelDetail[] } {
  const clean = sanitizeEmailHtml(rawHtml);
  const themedHtml = darkMode
    ? convertEmailToDarkMode(clean, {
        preserveBrands: true,
        minContrast: 4.5,
        darkBackground: "#28292c",
        lightText: "#eeeeee",
        linkColor: "#9eb7ff",
      })
    : removeSenderDarkModeCSS(clean);
  const document = new DOMParser().parseFromString(themedHtml, "text/html");
  normalizePreformattedText(document);
  const trackingReport = blockTrackingPixels(document);
  for (const image of document.querySelectorAll("img")) {
    const source = image.getAttribute("src") || "";
    if (source.startsWith("cid:")) {
      const cid = source.slice(4).replace(/^<|>$/g, "");
      if (cidUrls[cid]) image.setAttribute("src", cidUrls[cid]);
      else image.removeAttribute("src");
      continue;
    }
    if (/^https?:/i.test(source) && !loadImages) {
      image.setAttribute("data-remote-src", source);
      image.removeAttribute("src");
      image.removeAttribute("srcset");
    }
  }
  if (loadImages) rewriteRemoteImageUrls(document, relayUrls);
  for (const link of document.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    if (!parseExternalUrl(href)) link.removeAttribute("href");
  }
  const relayOrigins = relayUrls
    ? [...new Set(Object.values(relayUrls).map((value) => new URL(value).origin))].join(" ")
    : "";
  const imageSources = loadImages
    ? relayUrls
      ? `data: blob: ${relayOrigins}`.trim()
      : "data: blob: https:"
    : "data: blob:";
  const csp = `default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; font-src data:; connect-src 'none'`;
  const palette = darkMode
    ? {
        background: "#28292c",
        color: "#eeeeee",
        quote: "#555555",
        muted: "#bbbbbb",
        link: "#9eb7ff",
      }
    : {
        background: "#ffffff",
        color: "#2a2a2a",
        quote: "#dddddd",
        muted: "#666666",
        link: "#315ecc",
      };
  const senderStyles = [...document.head.querySelectorAll("style")]
    .map((style) => style.outerHTML)
    .join("");
  const head = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="${darkMode ? "dark" : "light"}"><style>html,body{width:100%;min-width:0;height:auto!important;margin:0!important;padding:0!important;background:${palette.background};color:${palette.color};font:14px/1.6 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden!important;overflow-wrap:anywhere;box-sizing:border-box}#email-root{display:flow-root;width:100%;min-width:0;max-width:100%;box-sizing:border-box;transform-origin:top left;overflow-wrap:anywhere}#email-root>:first-child{margin-block-start:0!important}#email-root>:last-child{margin-block-end:0!important}a{color:${palette.link};cursor:pointer;overflow-wrap:anywhere;word-break:break-word}table{max-width:100%;overflow-wrap:break-word}td{overflow-wrap:break-word}img{border:0;max-width:100%!important;height:auto!important;object-fit:contain!important}blockquote{border-left:2px solid ${palette.quote};margin-left:4px;padding-left:12px;color:${palette.muted}}pre,pre code{max-width:100%;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}mark[data-fluxmail-find-match]{border-radius:2px;padding:0;background:#f9d65c;color:#191919;box-shadow:0 0 0 1px rgb(132 91 0 / .16)}mark[data-fluxmail-find-match].active{background:#f39a3b;box-shadow:0 0 0 2px rgb(181 90 0 / .4)}</style>${senderStyles}</head>`;
  const body = document.body.innerHTML;
  // Tag the root with a hash of the content so the component can tell this document apart from
  // the one it replaces while the frame is still navigating.
  const sourceId = hashString(`${head}\u0000${body}`);
  return {
    source: `${head}<body><div id="email-root" ${EMAIL_SOURCE_ATTRIBUTE}="${sourceId}">${body}</div></body></html>`,
    sourceId,
    trackingPixels: trackingReport.trackingPixels,
  };
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const FIND_MATCH_ATTRIBUTE = "data-fluxmail-find-match";
const FIND_TEXT_BOUNDARY = "\u0000";
const BLOCK_TEXT_ELEMENTS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BODY",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

interface FindTextSegment {
  node: Text;
  start: number;
  end: number;
}

interface FindNodeRange {
  start: number;
  end: number;
  matchIndex: number;
}

export function highlightEmailMatches(document: Document, query: string): HTMLElement[] {
  clearEmailFindHighlights(document);
  if (!query) return [];
  const root = document.getElementById("email-root") ?? document.body;
  const segments: FindTextSegment[] = [];
  let searchableText = "";
  let previousNode: Text | undefined;
  let previousBlock: Element | undefined;
  const walker = document.createTreeWalker(root, document.defaultView?.NodeFilter.SHOW_TEXT ?? 4);
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    if (node.data && isVisibleFindText(node, root)) {
      const block = findTextBlock(node, root);
      if (
        segments.length &&
        (block !== previousBlock || (previousNode && hasLineBreakBetween(previousNode, node, root)))
      )
        searchableText += FIND_TEXT_BOUNDARY;
      const start = searchableText.length;
      searchableText += node.data;
      segments.push({ node, start, end: searchableText.length });
      previousNode = node;
      previousBlock = block;
    }
    current = walker.nextNode();
  }

  const pattern = new RegExp(escapeRegularExpression(query), "giu");
  const nodeRanges = new Map<Text, FindNodeRange[]>();
  const logicalMatches = [...searchableText.matchAll(pattern)];
  let firstSegment = 0;
  logicalMatches.forEach((match, matchIndex) => {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    while (firstSegment < segments.length && segments[firstSegment].end <= matchStart)
      firstSegment += 1;
    for (
      let segmentIndex = firstSegment;
      segmentIndex < segments.length && segments[segmentIndex].start < matchEnd;
      segmentIndex += 1
    ) {
      const segment = segments[segmentIndex];
      const start = Math.max(matchStart, segment.start) - segment.start;
      const end = Math.min(matchEnd, segment.end) - segment.start;
      if (start >= end) continue;
      const ranges = nodeRanges.get(segment.node) ?? [];
      ranges.push({ start, end, matchIndex });
      nodeRanges.set(segment.node, ranges);
    }
  });

  const matches: Array<HTMLElement | undefined> = Array.from({
    length: logicalMatches.length,
  });
  for (const { node } of segments) {
    const ranges = nodeRanges.get(node);
    if (!ranges?.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const range of ranges) {
      if (range.start > offset) fragment.append(node.data.slice(offset, range.start));
      const mark = document.createElement("mark");
      mark.setAttribute(FIND_MATCH_ATTRIBUTE, String(range.matchIndex));
      mark.textContent = node.data.slice(range.start, range.end);
      fragment.append(mark);
      matches[range.matchIndex] ??= mark;
      offset = range.end;
    }
    if (offset < node.data.length) fragment.append(node.data.slice(offset));
    node.replaceWith(fragment);
  }
  return matches.filter((match): match is HTMLElement => Boolean(match));
}

export function clearEmailFindHighlights(document: Document): void {
  const parents = new Set<Node>();
  for (const mark of document.querySelectorAll<HTMLElement>(`mark[${FIND_MATCH_ATTRIBUTE}]`)) {
    const parent = mark.parentNode;
    if (parent) parents.add(parent);
    mark.replaceWith(...mark.childNodes);
  }
  for (const parent of parents) parent.normalize();
}

function activateEmailFindMatch(document: Document, activeMatch?: number): HTMLElement | undefined {
  const matches = [...document.querySelectorAll<HTMLElement>(`mark[${FIND_MATCH_ATTRIBUTE}]`)];
  const activeValue = activeMatch === undefined ? undefined : String(activeMatch);
  matches.forEach((match) =>
    match.classList.toggle("active", match.getAttribute(FIND_MATCH_ATTRIBUTE) === activeValue),
  );
  const active =
    activeValue === undefined
      ? undefined
      : matches.find((match) => match.getAttribute(FIND_MATCH_ATTRIBUTE) === activeValue);
  return active;
}

function scrollEmailFindMatchIntoView(frame: HTMLIFrameElement, match: HTMLElement): void {
  const scroller = frame.closest<HTMLElement>(".conversation-scroll");
  if (!scroller) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const matchRect = match.getBoundingClientRect();
  const matchTop = frameRect.top + matchRect.top;
  const matchBottom = matchTop + matchRect.height;
  if (matchTop >= scrollerRect.top && matchBottom <= scrollerRect.bottom) return;
  const top =
    scroller.scrollTop +
    matchTop -
    scrollerRect.top -
    Math.max(0, (scroller.clientHeight - matchRect.height) / 2);
  scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function isVisibleFindText(node: Text, root: Element): boolean {
  let element = node.parentElement;
  while (element) {
    if (
      element.matches(`style, script, noscript, template, mark[${FIND_MATCH_ATTRIBUTE}]`) ||
      element.hasAttribute("hidden")
    )
      return false;
    const inlineStyle = (element as HTMLElement).style;
    if (
      inlineStyle.display === "none" ||
      inlineStyle.visibility === "hidden" ||
      inlineStyle.visibility === "collapse" ||
      inlineStyle.contentVisibility === "hidden"
    )
      return false;
    const computedStyle = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (
      computedStyle?.display === "none" ||
      computedStyle?.visibility === "hidden" ||
      computedStyle?.visibility === "collapse" ||
      computedStyle?.contentVisibility === "hidden"
    )
      return false;
    if (element === root) break;
    element = element.parentElement;
  }
  const parent = node.parentElement;
  if (parent && typeof parent.checkVisibility === "function") {
    try {
      return parent.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
    } catch {
      // Older Chromium versions may expose checkVisibility without supporting its options.
      return parent.checkVisibility();
    }
  }
  return true;
}

function findTextBlock(node: Text, root: Element): Element {
  let element = node.parentElement;
  while (element && element !== root) {
    const display =
      element.ownerDocument.defaultView?.getComputedStyle(element).display ||
      (element as HTMLElement).style.display;
    if (
      display
        ? display !== "contents" && !display.startsWith("inline")
        : BLOCK_TEXT_ELEMENTS.has(element.tagName)
    )
      return element;
    element = element.parentElement;
  }
  return root;
}

function hasLineBreakBetween(left: Text, right: Text, root: Element): boolean {
  let current: Node | null = left;
  while ((current = nextNode(current, root))) {
    if (current === right) return false;
    if (current.nodeType === 1 && (current as Element).tagName === "BR") return true;
  }
  return false;
}

function nextNode(node: Node, root: Element): Node | null {
  if (node.firstChild) return node.firstChild;
  let current: Node | null = node;
  while (current && current !== root) {
    if (current.nextSibling) return current.nextSibling;
    current = current.parentNode;
  }
  return null;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeEmailHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "video",
      "audio",
    ],
    FORBID_ATTR: ["srcdoc"],
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel|cid|data|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
}

function useResolvedDarkTheme(): boolean {
  const [darkMode, setDarkMode] = useState(() => document.documentElement.dataset.theme === "dark");
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDarkMode(root.dataset.theme === "dark");
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return darkMode;
}

export function applyContentScaling(document: Document, containerWidth: number): number {
  const root = document.getElementById("email-root");
  if (!root || containerWidth <= 0) return 1;
  root.style.transform = "none";
  void root.offsetWidth;
  const naturalWidth = root.scrollWidth;
  if (naturalWidth <= containerWidth) return 1;
  const scale = containerWidth / naturalWidth;
  root.style.transform = `scale(${scale})`;
  return scale;
}

function normalizePreformattedText(document: Document): void {
  for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
    if (element.closest("pre, code")) continue;
    const whiteSpace = element.style.whiteSpace.toLowerCase();
    if (whiteSpace === "pre") element.style.whiteSpace = "pre-wrap";
  }
}

function textToHtml(value: string): string {
  const escaped = value.replace(
    /[&<>]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!,
  );
  return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

function remoteImagePolicyKey(
  messageId: string,
  blockRemoteImages: boolean,
  imageRelay: boolean,
  imageRelayAvailable: boolean,
): string {
  const relayPolicy = imageRelay ? (imageRelayAvailable ? "relay" : "relay-unavailable") : "direct";
  return `${messageId}:${blockRemoteImages ? "blocked" : "automatic"}:${relayPolicy}`;
}

async function proxyRemoteImageUrls(urls: string[]): Promise<Record<string, string>> {
  const proxied: Record<string, string> = {};
  for (let offset = 0; offset < urls.length; offset += MAX_IMAGE_RELAY_URLS_PER_REQUEST) {
    Object.assign(
      proxied,
      await window.fluxmail.images.proxy(
        urls.slice(offset, offset + MAX_IMAGE_RELAY_URLS_PER_REQUEST),
      ),
    );
  }
  return proxied;
}

export function hasRemoteImages(value: string): boolean {
  const document = new DOMParser().parseFromString(sanitizeEmailHtml(value), "text/html");
  blockTrackingPixels(document);
  const imageAttributes = [...document.querySelectorAll("img, source, svg image, [background]")]
    .flatMap((element) => [
      element.getAttribute("src"),
      element.getAttribute("srcset"),
      element.getAttribute("href"),
      element.getAttribute("xlink:href"),
      element.getAttribute("background"),
    ])
    .filter((source): source is string => Boolean(source));
  const css = [
    ...[...document.querySelectorAll<HTMLElement>("[style]")].map(
      (element) => element.style.cssText,
    ),
    ...[...document.querySelectorAll("style")].map((style) => style.textContent || ""),
  ];
  return imageAttributes.some((source) => /https?:\/\//i.test(source)) || hasRemoteCssImage(css);
}

const CSS_IMAGE_DECLARATION =
  /(?:^|[;{])\s*(?:background(?:-image)?|border-image(?:-source)?|content|cursor|list-style(?:-image)?|mask(?:-image)?|-webkit-mask(?:-image)?|shape-outside)\s*:\s*([^;}]+)/gi;
const CSS_CUSTOM_PROPERTY = /(?:^|[;{])\s*(--[-\w]+)\s*:\s*([^;}]+)/gi;
const REMOTE_CSS_URL = /url\(\s*(?:(?:["'])?\s*https?:\/\/)/i;
const REMOTE_IMAGE_SET_STRING = /(?:-webkit-)?image-set\([^)]*["']\s*https?:\/\//i;

function hasRemoteCssImage(values: string[]): boolean {
  const css = values.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const customProperties = new Map<string, string[]>();
  for (const match of css.matchAll(CSS_CUSTOM_PROPERTY)) {
    const definitions = customProperties.get(match[1]) ?? [];
    definitions.push(match[2]);
    customProperties.set(match[1], definitions);
  }
  return [...css.matchAll(CSS_IMAGE_DECLARATION)].some((match) =>
    cssValueHasRemoteImage(match[1], customProperties, new Set()),
  );
}

function cssValueHasRemoteImage(
  value: string,
  customProperties: Map<string, string[]>,
  visited: Set<string>,
): boolean {
  if (REMOTE_CSS_URL.test(value) || REMOTE_IMAGE_SET_STRING.test(value)) return true;
  return [...value.matchAll(/var\(\s*(--[-\w]+)/gi)].some((match) => {
    const property = match[1];
    if (visited.has(property)) return false;
    const nextVisited = new Set(visited).add(property);
    return (customProperties.get(property) ?? []).some((definition) =>
      cssValueHasRemoteImage(definition, customProperties, nextVisited),
    );
  });
}
