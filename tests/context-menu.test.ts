import { describe, expect, it, vi } from "vitest";
import { contextMenuTemplate, type ContextMenuInput } from "../src/main/context-menu";

const editFlags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false,
};

function params(overrides: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
    x: 10,
    y: 20,
    linkURL: "",
    selectionText: "",
    isEditable: false,
    editFlags,
    mediaType: "none",
    hasImageContents: false,
    misspelledWord: "",
    dictionarySuggestions: [],
    ...overrides,
  };
}

function actions() {
  return {
    openExternal: vi.fn(),
    copyText: vi.fn(),
    copyImageAt: vi.fn(),
    replaceMisspelling: vi.fn(),
    addToDictionary: vi.fn(),
  };
}

function click(template: ReturnType<typeof contextMenuTemplate>, label: string) {
  const item = template.find((entry) => entry.label === label);
  expect(item).toBeDefined();
  (item!.click as () => void)();
}

describe("context menu", () => {
  it("is empty when there is nothing to act on", () => {
    expect(contextMenuTemplate(params(), actions())).toEqual([]);
  });

  it("offers to open and copy web links", () => {
    const handlers = actions();
    const template = contextMenuTemplate(
      params({ linkURL: "https://example.com/path?q=1" }),
      handlers,
    );
    expect(template.map((item) => item.label)).toEqual(["Open Link in Browser", "Copy Link"]);
    click(template, "Copy Link");
    expect(handlers.copyText).toHaveBeenCalledWith("https://example.com/path?q=1");
    click(template, "Open Link in Browser");
    expect(handlers.openExternal).toHaveBeenCalledWith("https://example.com/path?q=1");
  });

  it("copies the address from mailto links", () => {
    const handlers = actions();
    const template = contextMenuTemplate(
      params({ linkURL: "mailto:first%20last@example.com?subject=Hi" }),
      handlers,
    );
    click(template, "Copy Email Address");
    expect(handlers.copyText).toHaveBeenCalledWith("first last@example.com");
  });

  it("copies mailto addresses with malformed escapes as written", () => {
    const handlers = actions();
    const template = contextMenuTemplate(
      params({ linkURL: "mailto:user%ZZ@example.com" }),
      handlers,
    );
    click(template, "Copy Email Address");
    expect(handlers.copyText).toHaveBeenCalledWith("user%ZZ@example.com");
  });

  it("ignores unsafe link protocols", () => {
    expect(contextMenuTemplate(params({ linkURL: "javascript:alert(1)" }), actions())).toEqual([]);
  });

  it("adds copy for selected text after link actions", () => {
    const template = contextMenuTemplate(
      params({
        linkURL: "https://example.com",
        selectionText: "example",
        editFlags: { ...editFlags, canCopy: true },
      }),
      actions(),
    );
    expect(template.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      "Open Link in Browser",
      "Copy Link",
      "separator",
      "copy",
    ]);
  });

  it("offers editing roles and spelling suggestions in editable fields", () => {
    const handlers = actions();
    const template = contextMenuTemplate(
      params({
        isEditable: true,
        misspelledWord: "helo",
        dictionarySuggestions: ["hello", "help"],
        editFlags: { ...editFlags, canPaste: true },
      }),
      handlers,
    );
    expect(template.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      "hello",
      "help",
      "Learn Spelling",
      "separator",
      "cut",
      "copy",
      "paste",
      "selectAll",
    ]);
    expect(template.find((item) => item.role === "paste")?.enabled).toBe(true);
    expect(template.find((item) => item.role === "cut")?.enabled).toBe(false);
    click(template, "hello");
    expect(handlers.replaceMisspelling).toHaveBeenCalledWith("hello");
    click(template, "Learn Spelling");
    expect(handlers.addToDictionary).toHaveBeenCalledWith("helo");
  });

  it("copies images at the clicked point", () => {
    const handlers = actions();
    const template = contextMenuTemplate(
      params({ mediaType: "image", hasImageContents: true }),
      handlers,
    );
    click(template, "Copy Image");
    expect(handlers.copyImageAt).toHaveBeenCalledWith(10, 20);
  });
});
