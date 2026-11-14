import { normalizeRemoteImageUrl } from "../../shared/image-relay";
import {
  cssString,
  findCssImageUrls,
  parseSrcset,
  rewriteCssImages,
  serializeSrcset,
} from "./css-urls";
import { blockTrackingPixels } from "./tracking-pixels";

export function collectRemoteImageUrls(html: string): string[] {
  const document = new DOMParser().parseFromString(html, "text/html");
  blockTrackingPixels(document);
  const urls = new Set<string>();
  const add = (value?: string | null) => {
    const normalized = value ? normalizeRemoteImageUrl(value) : undefined;
    if (normalized) urls.add(normalized);
  };

  for (const image of document.querySelectorAll("img[src]")) add(image.getAttribute("src"));
  for (const element of document.querySelectorAll("img[srcset], source[srcset]")) {
    for (const entry of parseSrcset(element.getAttribute("srcset") ?? "")) add(entry.url);
  }
  for (const image of document.querySelectorAll("image"))
    add(image.getAttribute("href") || image.getAttribute("xlink:href"));
  for (const element of document.querySelectorAll("[background]"))
    add(element.getAttribute("background"));
  for (const element of document.querySelectorAll("[style]"))
    for (const url of findCssImageUrls(element.getAttribute("style") ?? "")) add(url);
  for (const style of document.querySelectorAll("style"))
    for (const url of findCssImageUrls(style.textContent ?? "")) add(url);

  return [...urls];
}

export function rewriteRemoteImageUrls(
  document: Document,
  relayUrls?: Record<string, string>,
): void {
  const replacement = (value: string): string | undefined => {
    const normalized = normalizeRemoteImageUrl(value);
    return normalized ? (relayUrls ? relayUrls[normalized] : normalized) : undefined;
  };

  for (const image of document.querySelectorAll("img[src]")) {
    const source = image.getAttribute("src") ?? "";
    if (!normalizeRemoteImageUrl(source)) continue;
    const proxied = replacement(source);
    if (proxied) image.setAttribute("src", proxied);
    else image.removeAttribute("src");
  }
  for (const element of document.querySelectorAll("img[srcset], source[srcset]")) {
    const entries = parseSrcset(element.getAttribute("srcset") ?? "").flatMap((entry) => {
      if (!normalizeRemoteImageUrl(entry.url)) return [entry];
      const proxied = replacement(entry.url);
      return proxied ? [{ ...entry, url: proxied }] : [];
    });
    if (entries.length) element.setAttribute("srcset", serializeSrcset(entries));
    else element.removeAttribute("srcset");
  }
  for (const image of document.querySelectorAll("image")) {
    const source = image.getAttribute("href") || image.getAttribute("xlink:href") || "";
    if (!normalizeRemoteImageUrl(source)) continue;
    const proxied = replacement(source);
    for (const attribute of ["href", "xlink:href"])
      if (image.hasAttribute(attribute)) {
        if (proxied) image.setAttribute(attribute, proxied);
        else image.removeAttribute(attribute);
      }
  }
  for (const element of document.querySelectorAll("[background]")) {
    const source = element.getAttribute("background") ?? "";
    if (!normalizeRemoteImageUrl(source)) continue;
    const proxied = replacement(source);
    if (proxied) element.setAttribute("background", proxied);
    else element.removeAttribute("background");
  }
  for (const element of document.querySelectorAll("[style]"))
    element.setAttribute("style", rewriteCss(element.getAttribute("style") ?? "", replacement));
  for (const style of document.querySelectorAll("style"))
    style.textContent = rewriteCss(style.textContent ?? "", replacement);
}

function rewriteCss(value: string, replace: (url: string) => string | undefined): string {
  return rewriteCssImages(value, {
    url: (url) =>
      normalizeRemoteImageUrl(url)
        ? `url(${cssString(replace(url.trim()) ?? "data:,")})`
        : undefined,
    imageSetString: (url) =>
      normalizeRemoteImageUrl(url) ? cssString(replace(url.trim()) ?? "data:,") : undefined,
  });
}
