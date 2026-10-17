import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { parseExternalUrl } from "../shared/external-url";

export type ContextMenuInput = Pick<
  ContextMenuParams,
  | "x"
  | "y"
  | "linkURL"
  | "selectionText"
  | "isEditable"
  | "editFlags"
  | "mediaType"
  | "hasImageContents"
  | "misspelledWord"
  | "dictionarySuggestions"
>;

export interface ContextMenuActions {
  openExternal(url: string): void;
  copyText(text: string): void;
  copyImageAt(x: number, y: number): void;
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
}

export function contextMenuTemplate(
  params: ContextMenuInput,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];

  if (params.isEditable && params.misspelledWord) {
    const word = params.misspelledWord;
    const suggestions: MenuItemConstructorOptions[] = params.dictionarySuggestions
      .slice(0, 5)
      .map((suggestion) => ({
        label: suggestion,
        click: () => actions.replaceMisspelling(suggestion),
      }));
    if (!suggestions.length) suggestions.push({ label: "No Guesses Found", enabled: false });
    suggestions.push({ label: "Learn Spelling", click: () => actions.addToDictionary(word) });
    groups.push(suggestions);
  }

  const link = parseExternalUrl(params.linkURL);
  if (link?.protocol === "mailto:") {
    const address = decodeMailtoAddress(link.pathname);
    groups.push([
      { label: "Open Link", click: () => actions.openExternal(link.toString()) },
      { label: "Copy Email Address", click: () => actions.copyText(address) },
    ]);
  } else if (link) {
    groups.push([
      { label: "Open Link in Browser", click: () => actions.openExternal(link.toString()) },
      { label: "Copy Link", click: () => actions.copyText(link.toString()) },
    ]);
  }

  if (params.mediaType === "image" && params.hasImageContents) {
    groups.push([{ label: "Copy Image", click: () => actions.copyImageAt(params.x, params.y) }]);
  }

  if (params.isEditable) {
    groups.push([
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]);
  } else if (params.selectionText.trim()) {
    groups.push([{ role: "copy", enabled: params.editFlags.canCopy }]);
  }

  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ type: "separator" as const }, ...group],
  );
}

function decodeMailtoAddress(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
