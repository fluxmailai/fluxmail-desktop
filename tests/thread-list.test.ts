/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSelectionReadAction,
  groupScheduledThreadsByDate,
  ThreadRow,
} from "../src/renderer/components/ThreadListPane";
import { calculateScrollThumb } from "../src/renderer/components/OverlayScrollbar";
import type { ThreadSummary } from "../src/shared/contracts";

afterEach(cleanup);

describe("thread row activation", () => {
  it("opens the conversation from the full row without stealing action clicks", () => {
    const onOpen = vi.fn();
    const onCheck = vi.fn();
    const onMove = vi.fn();
    const { container, getByRole } = render(
      createElement(ThreadRow, {
        thread: testThread,
        active: false,
        checked: false,
        onOpen,
        onCheck,
        moveLabel: "Archive",
        restore: false,
        onMove,
        onToggleRead: vi.fn(),
        onStar: vi.fn(),
      }),
    );

    fireEvent.click(container.querySelector(".thread-row")!);
    expect(onOpen).toHaveBeenCalledOnce();

    onOpen.mockClear();
    fireEvent.click(getByRole("button", { name: "Archive conversation" }));
    expect(onMove).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(getByRole("checkbox", { name: "Select conversation" }));
    expect(onCheck).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("marks conversations that contain a draft", () => {
    const { getByText } = render(
      createElement(ThreadRow, {
        thread: { ...testThread, draft: true },
        active: false,
        checked: false,
        onOpen: vi.fn(),
        onCheck: vi.fn(),
        moveLabel: "Archive",
        restore: false,
        onMove: vi.fn(),
        onToggleRead: vi.fn(),
        onStar: vi.fn(),
      }),
    );

    expect(getByText("Draft").classList.contains("thread-draft-label")).toBe(true);
  });

  it("titles a conversation without reply prefixes but keeps a typed draft subject", () => {
    const props = {
      active: false,
      checked: false,
      onOpen: vi.fn(),
      onCheck: vi.fn(),
      moveLabel: "Archive",
      restore: false,
      onToggleRead: vi.fn(),
      onStar: vi.fn(),
    };
    const received = render(
      createElement(ThreadRow, {
        ...props,
        thread: { ...testThread, subject: "Re: Plans", messageCount: 2 },
      }),
    );
    expect(received.container.querySelector(".subject-line .truncate")!.textContent).toBe("Plans");
    received.unmount();

    const draft = render(
      createElement(ThreadRow, {
        ...props,
        thread: { ...testThread, subject: "Re: Plans", draft: true, messageCount: 1 },
      }),
    );
    expect(draft.container.querySelector(".subject-line .truncate")!.textContent).toBe("Re: Plans");
  });

  it("labels drafts in the scheduled mailbox", () => {
    const { getByText, queryByRole } = render(
      createElement(ThreadRow, {
        thread: { ...testThread, draft: true },
        active: false,
        checked: false,
        onOpen: vi.fn(),
        onCheck: vi.fn(),
        moveLabel: "Archive",
        restore: false,
        draftLabel: "Scheduled",
        onToggleRead: vi.fn(),
        onStar: vi.fn(),
      }),
    );

    expect(getByText("Scheduled").classList.contains("thread-draft-label")).toBe(true);
    expect(queryByRole("button", { name: "Archive conversation" })).toBeNull();
  });
});

describe("scheduled date groups", () => {
  it("separates today, tomorrow, and later dates", () => {
    const now = new Date("2026-07-23T12:00:00");
    const groups = groupScheduledThreadsByDate(
      [
        { ...testThread, id: "today", date: "2026-07-23T14:00:00" },
        { ...testThread, id: "tomorrow", date: "2026-07-24T09:00:00" },
        { ...testThread, id: "later", date: "2026-07-26T09:00:00" },
      ],
      now,
    );

    expect(groups.slice(0, 2).map((group) => group.label)).toEqual(["Today", "Tomorrow"]);
    expect(groups[2]?.threads[0]?.id).toBe("later");
  });
});

describe("thread list overlay scrollbar", () => {
  it("maps scroll position onto an overlaid thumb", () => {
    expect(calculateScrollThumb(500, 2_000, 0)).toEqual({
      visible: true,
      top: 0,
      height: 125,
    });
    expect(calculateScrollThumb(500, 2_000, 750)).toEqual({
      visible: true,
      top: 187.5,
      height: 125,
    });
    expect(calculateScrollThumb(500, 2_000, 1_500)).toEqual({
      visible: true,
      top: 375,
      height: 125,
    });
  });

  it("hides the thumb when the list fits", () => {
    expect(calculateScrollThumb(500, 500, 0)).toEqual({
      visible: false,
      top: 0,
      height: 0,
    });
  });
});

describe("bulk read action", () => {
  it("marks a mixed selection read", () => {
    expect(getSelectionReadAction([{ unread: false }, { unread: true }])).toBe("markRead");
  });

  it("marks a fully read selection unread", () => {
    expect(getSelectionReadAction([{ unread: false }, { unread: false }])).toBe("markUnread");
  });
});

const testThread: ThreadSummary = {
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
