/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateContextMenuPosition,
  calculateSubmenuPosition,
  ContextMenu,
  type ContextMenuEntry,
  type ContextMenuItem,
} from "../src/renderer/components/Controls";
import { ThreadRow, threadContextMenuEntries } from "../src/renderer/components/ThreadListPane";
import type { MailboxView, ModifyActionInput, ThreadSummary } from "../src/shared/contracts";

afterEach(cleanup);

const thread: ThreadSummary = {
  id: "thread-1",
  accountId: "account-1",
  accountEmail: "me@example.com",
  subject: "Subject",
  senderName: "Sender",
  senderEmail: "sender@example.com",
  snippet: "Preview",
  date: "2026-07-20T12:00:00Z",
  unread: false,
  starred: false,
  draft: false,
  hasAttachments: false,
  messageCount: 1,
  labels: [],
  folderRoles: ["inbox"],
};

function entriesFor(
  view: MailboxView,
  options: Partial<Parameters<typeof threadContextMenuEntries>[0]> = {},
) {
  const onModify = vi.fn<(action: ModifyActionInput) => void>();
  const entries = threadContextMenuEntries({
    view,
    targets: [thread],
    labels: [],
    allowPermanentDelete: false,
    onModify,
    ...options,
  });
  const items = entries.filter((entry): entry is ContextMenuItem => !("type" in entry));
  const item = (id: string) => items.find((entry) => entry.id === id);
  return { entries, items, item, onModify };
}

describe("thread context menu entries", () => {
  it("offers the inbox actions for one conversation", () => {
    const { items, item, onModify } = entriesFor("inbox");
    expect(items.map((entry) => entry.label)).toEqual([
      "Archive",
      "Trash",
      "Mark as unread",
      "Star",
      "Mark as spam",
    ]);
    for (const id of ["move", "delete", "read", "star", "spam"]) item(id)!.onSelect!();
    expect(onModify.mock.calls.map(([action]) => action)).toEqual([
      { type: "archive" },
      { type: "trash" },
      { type: "markUnread" },
      { type: "star" },
      { type: "move", folder: "spam" },
    ]);
  });

  it("offers Reply, Reply all and Forward for one received conversation", () => {
    const onReply = vi.fn();
    const { items, item } = entriesFor("inbox", { onReply });
    expect(items.slice(0, 3).map((entry) => entry.label)).toEqual([
      "Reply",
      "Reply all",
      "Forward",
    ]);
    item("reply")!.onSelect!();
    item("replyAll")!.onSelect!();
    item("forward")!.onSelect!();
    expect(onReply.mock.calls).toEqual([["reply"], ["replyAll"], ["forward"]]);
  });

  it("leaves out replies for drafts and for more than one conversation", () => {
    const onReply = vi.fn();
    const draft = { ...thread, draft: true };
    expect(entriesFor("inbox", { onReply, targets: [draft] }).item("reply")).toBeUndefined();
    expect(entriesFor("drafts", { onReply }).item("reply")).toBeUndefined();
    expect(entriesFor("scheduled", { onReply }).item("reply")).toBeUndefined();
    expect(
      entriesFor("inbox", { onReply, targets: [thread, { ...thread, id: "thread-2" }] }).item(
        "reply",
      ),
    ).toBeUndefined();
  });

  it("names the count and combines read and star state across a selection", () => {
    const { entries, item } = entriesFor("inbox", {
      targets: [
        { ...thread, unread: true, starred: true },
        { ...thread, id: "thread-2", starred: true },
      ],
    });
    expect(entries[0]).toEqual({ type: "heading", id: "count", label: "2 conversations" });
    expect(item("read")!.label).toBe("Mark as read");
    expect(item("star")!.label).toBe("Unstar");
  });

  it("restores from Trash and deletes permanently only when the account allows it", () => {
    expect(entriesFor("trash").item("move")!.label).toBe("Restore");
    expect(entriesFor("trash").item("delete")).toBeUndefined();
    const { item, onModify } = entriesFor("trash", { allowPermanentDelete: true });
    expect(item("delete")).toMatchObject({ label: "Delete permanently", danger: true });
    item("delete")!.onSelect!();
    expect(onModify).toHaveBeenCalledWith({ type: "delete" });
  });

  it("leaves out moves that do not apply to scheduled mail or spam", () => {
    const scheduled = entriesFor("scheduled");
    expect(scheduled.item("move")).toBeUndefined();
    expect(scheduled.item("spam")).toBeUndefined();
    expect(scheduled.item("delete")!.label).toBe("Cancel and discard");
    expect(entriesFor("spam").item("spam")).toBeUndefined();
    expect(entriesFor("drafts").item("delete")!.label).toBe("Discard draft");
  });

  it("checks labels every conversation has and removes them when chosen again", () => {
    const { item, onModify } = entriesFor("inbox", {
      labels: ["Clients", "Hiring"],
      targets: [
        { ...thread, labels: ["Clients", "Hiring"] },
        { ...thread, id: "thread-2", labels: ["Clients"] },
      ],
    });
    const submenu = item("labels")!.submenu!;
    expect(submenu.map(({ label, selected }) => ({ label, selected }))).toEqual([
      { label: "Clients", selected: true },
      { label: "Hiring", selected: false },
    ]);
    submenu[0].onSelect!();
    submenu[1].onSelect!();
    expect(onModify.mock.calls.map(([action]) => action)).toEqual([
      { type: "removeLabels", labels: ["Clients"] },
      { type: "addLabels", labels: ["Hiring"] },
    ]);
  });
});

describe("context menu positioning", () => {
  const viewport = { width: 800, height: 600 };
  const menu = { width: 200, height: 300 };

  it("opens at the pointer when there is room", () => {
    expect(calculateContextMenuPosition({ x: 100, y: 120 }, menu, viewport)).toEqual({
      left: 100,
      top: 120,
    });
  });

  it("opens up and to the left near the bottom-right corner", () => {
    expect(calculateContextMenuPosition({ x: 750, y: 580 }, menu, viewport)).toEqual({
      left: 550,
      top: 280,
    });
  });

  it("keeps a menu taller than the space on both sides inside the window", () => {
    expect(
      calculateContextMenuPosition({ x: 10, y: 200 }, { width: 200, height: 500 }, viewport),
    ).toEqual({ left: 10, top: 6 });
  });

  it("flips a submenu to the left when the right side has no room", () => {
    expect(calculateSubmenuPosition({ left: 400, right: 590, top: 100 }, menu, viewport)).toEqual({
      left: 588,
      top: 95,
    });
    expect(calculateSubmenuPosition({ left: 500, right: 690, top: 100 }, menu, viewport)).toEqual({
      left: 302,
      top: 95,
    });
  });
});

describe("context menu", () => {
  function renderMenu(entries: ContextMenuEntry[]) {
    const onClose = vi.fn();
    render(
      createElement(ContextMenu, {
        label: "Conversation actions",
        position: { x: 20, y: 20 },
        entries,
        onClose,
      }),
    );
    return { onClose, menu: screen.getByRole("menu", { name: "Conversation actions" }) };
  }

  it("runs an item and closes", () => {
    const onSelect = vi.fn();
    const { onClose } = renderMenu([{ id: "archive", label: "Archive", onSelect }]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("moves through items with the arrow keys and runs one with Enter", () => {
    const archive = vi.fn();
    const star = vi.fn();
    const { menu } = renderMenu([
      { id: "archive", label: "Archive", onSelect: archive },
      { type: "separator", id: "separator" },
      { id: "disabled", label: "Unavailable", disabled: true },
      { id: "star", label: "Star", onSelect: star },
    ]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Star" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(star).toHaveBeenCalledOnce();
    expect(archive).not.toHaveBeenCalled();
  });

  it("runs an item from its shortcut key without reaching the window", () => {
    const archive = vi.fn();
    const windowKeyDown = vi.fn();
    window.addEventListener("keydown", windowKeyDown);
    const { menu } = renderMenu([
      {
        id: "archive",
        label: "Archive",
        shortcut: { display: "E", keys: "E" },
        onSelect: archive,
      },
    ]);
    fireEvent.keyDown(menu, { key: "e" });
    window.removeEventListener("keydown", windowKeyDown);
    expect(archive).toHaveBeenCalledOnce();
    expect(windowKeyDown).not.toHaveBeenCalled();
  });

  it("opens a submenu with the arrow key and returns with ArrowLeft", async () => {
    const addLabel = vi.fn();
    const { menu } = renderMenu([
      {
        id: "labels",
        label: "Label",
        submenu: [{ id: "label:Clients", label: "Clients", selected: false, onSelect: addLabel }],
      },
    ]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    const labelItem = screen.getByRole("menuitem", { name: "Label" });
    fireEvent.keyDown(labelItem, { key: "ArrowRight" });
    const submenu = await screen.findByRole("menu", { name: "Label" });
    expect(labelItem).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(submenu, { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "Label" })).not.toBeInTheDocument();
    expect(labelItem).toHaveFocus();

    fireEvent.pointerEnter(labelItem);
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Clients" }));
    expect(addLabel).toHaveBeenCalledOnce();
  });

  it("keeps the submenu open while the pointer crosses other items to reach it", () => {
    vi.useFakeTimers();
    try {
      renderMenu([
        {
          id: "labels",
          label: "Label",
          submenu: [{ id: "label:Clients", label: "Clients", selected: false }],
        },
        { id: "spam", label: "Mark as spam" },
      ]);
      fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Label" }));
      fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Mark as spam" }));
      act(() => vi.advanceTimersByTime(100));
      fireEvent.pointerEnter(screen.getByRole("menu", { name: "Label" }));
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByRole("menu", { name: "Label" })).toBeInTheDocument();

      fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Mark as spam" }));
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.queryByRole("menu", { name: "Label" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on Escape, an outside click, or a scroll elsewhere", () => {
    const { onClose, menu } = renderMenu([{ id: "archive", label: "Archive" }]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.scroll(document);
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.pointerDown(menu);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("focuses the menu after the browser finishes focusing the clicked row", async () => {
    const row = document.createElement("button");
    document.body.append(row);
    const { menu } = renderMenu([{ id: "archive", label: "Archive" }]);
    row.focus();
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(menu).toHaveFocus();
    row.remove();
  });
});

describe("thread row context menu", () => {
  it("opens at the pointer without opening the conversation", () => {
    const onOpen = vi.fn();
    const onContextMenu = vi.fn();
    const { container } = render(
      createElement(ThreadRow, {
        thread,
        active: false,
        checked: false,
        onOpen,
        onCheck: vi.fn(),
        moveLabel: "Archive",
        restore: false,
        onToggleRead: vi.fn(),
        onStar: vi.fn(),
        onContextMenu,
      }),
    );
    const row = container.querySelector(".thread-row")!;
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
    });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledWith({ x: 40, y: 60 });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
