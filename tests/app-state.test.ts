/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  adjustUnreadCount,
  canCloseQuickReply,
  loadThreadPages,
  nextThreadAfterArchive,
  permanentDeletePrompt,
  reconcileAccountSelection,
  replySeed,
  shouldClearSelectedThread,
  shouldForceProviderSearchAfterMutation,
  shouldOptimisticallyRemoveFromView,
  threadKey,
  threadsToPrefetch,
} from "../src/renderer/App";
import { parseAddressField, replyRecipient } from "../src/renderer/components/ComposeDialog";
import {
  mailboxDeleteAction,
  mailboxDeleteLabel,
  mailboxMoveAction,
  mailboxMoveLabel,
} from "../src/renderer/mail-actions";
import type { ThreadPage, ThreadSummary } from "../src/shared/contracts";

describe("thread prefetching", () => {
  const threads = Array.from({ length: 12 }, (_, index) => thread(`thread-${index}`));
  const ids = (targets: Array<{ threadId: string }>) => targets.map((target) => target.threadId);

  it("prefetches the top of the list before anything is open", () => {
    expect(ids(threadsToPrefetch(threads))).toEqual(threads.slice(0, 8).map((item) => item.id));
  });

  it("prefetches the conversations around the open one", () => {
    expect(ids(threadsToPrefetch(threads, threadKey(threads[5]!)))).toEqual([
      "thread-3",
      "thread-4",
      "thread-6",
      "thread-7",
      "thread-8",
      "thread-9",
      "thread-10",
    ]);
  });
});

describe("mail view optimistic updates", () => {
  it("removes archived Inbox threads immediately", () => {
    expect(shouldOptimisticallyRemoveFromView("inbox", { type: "archive" })).toBe(true);
  });

  it("keeps archived threads in views where they still belong", () => {
    expect(shouldOptimisticallyRemoveFromView("all", { type: "archive" })).toBe(false);
    expect(shouldOptimisticallyRemoveFromView("starred", { type: "archive" })).toBe(false);
    expect(shouldOptimisticallyRemoveFromView("search", { type: "archive" })).toBe(false);
    expect(shouldClearSelectedThread("sent", { type: "archive" })).toBe(false);
    expect(shouldClearSelectedThread("all", { type: "archive" })).toBe(false);
  });

  it("chooses the next thread, then falls back to the previous thread", () => {
    const first = thread("first");
    const second = thread("second");
    const third = thread("third");

    expect(nextThreadAfterArchive([first, second, third], second)).toBe(third);
    expect(nextThreadAfterArchive([first, second, third], third)).toBe(second);
    expect(nextThreadAfterArchive([first], first)).toBeUndefined();
  });

  it("removes restored and permanently deleted threads from Trash immediately", () => {
    expect(shouldOptimisticallyRemoveFromView("trash", { type: "untrash" })).toBe(true);
    expect(shouldOptimisticallyRemoveFromView("trash", { type: "delete" })).toBe(true);
  });

  it("discards drafts without trashing their conversations", () => {
    expect(mailboxDeleteAction("drafts")).toEqual({ type: "discardDraft" });
    expect(mailboxDeleteLabel("drafts")).toBe("Discard draft");
    expect(shouldOptimisticallyRemoveFromView("drafts", { type: "discardDraft" })).toBe(true);
  });

  it("hides permanent delete unless the account supports it", () => {
    expect(mailboxMoveAction("trash")).toEqual({ type: "untrash" });
    expect(mailboxMoveAction("spam")).toEqual({ type: "move", folder: "archive" });
    expect(mailboxDeleteAction("trash")).toBeUndefined();
    expect(mailboxDeleteAction("trash", true)).toEqual({ type: "delete" });
    expect(mailboxMoveLabel("trash")).toBe("Restore");
    expect(mailboxDeleteLabel("trash")).toBe("Delete permanently");
    expect(mailboxMoveAction("inbox")).toEqual({ type: "archive" });
    expect(mailboxDeleteAction("inbox")).toEqual({ type: "trash" });
  });

  it("reruns provider searches after a mutation", () => {
    expect(shouldForceProviderSearchAfterMutation("is:starred")).toBe(true);
    expect(shouldForceProviderSearchAfterMutation("   ")).toBe(false);
  });

  it("describes permanent deletion before confirming it", () => {
    expect(permanentDeletePrompt(1)).toBe(
      "Delete this conversation permanently? This cannot be undone.",
    );
    expect(permanentDeletePrompt(3)).toBe(
      "Delete 3 conversations permanently? This cannot be undone.",
    );
  });

  it("asks before closing a window with an unsent quick reply", () => {
    const confirmDiscard = vi.fn(() => false);

    expect(canCloseQuickReply(false, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(canCloseQuickReply(true, confirmDiscard)).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });
});

describe("background page reloads", () => {
  it("reloads enough pages to preserve the loaded range", async () => {
    const first = page([thread("first")], "1", 3);
    const loadNext = vi
      .fn()
      .mockResolvedValueOnce(page([thread("second")], "2", 3))
      .mockResolvedValueOnce(page([thread("third")], undefined, 3));

    const result = await loadThreadPages(first, 3, loadNext);

    expect(result.items.map((item) => item.id).sort()).toEqual(["first", "second", "third"]);
    expect(loadNext).toHaveBeenNthCalledWith(1, "1");
    expect(loadNext).toHaveBeenNthCalledWith(2, "2");
  });

  it("keeps scheduled pages ordered from the next delivery to the latest", async () => {
    const soonest = { ...thread("soonest"), date: "2026-07-20T12:00:00Z" };
    const middle = { ...thread("middle"), date: "2026-07-21T12:00:00Z" };
    const latest = { ...thread("latest"), date: "2026-07-22T12:00:00Z" };
    const loadNext = vi.fn().mockResolvedValue(page([middle, latest], undefined, 3));

    const result = await loadThreadPages(page([soonest], "1", 3), 3, loadNext, "ascending");

    expect(result.items.map((item) => item.id)).toEqual(["soonest", "middle", "latest"]);
  });
});

describe("reply recipients", () => {
  it("waits for thread details instead of prefilling the summary sender", () => {
    expect(
      replySeed({
        id: "thread",
        accountId: "account",
        accountEmail: "me@example.com",
        subject: "Hello",
        senderName: "Me",
        senderEmail: "me@example.com",
        snippet: "Sent message",
        date: "2026-07-16T12:00:00Z",
        unread: false,
        starred: false,
        draft: false,
        hasAttachments: false,
        messageCount: 1,
        labels: [],
        folderRoles: ["sent"],
      }).to,
    ).toBeUndefined();
  });

  it("uses the sender for an incoming message", () => {
    expect(
      replyRecipient("me@example.com", {
        id: "incoming",
        threadId: "thread",
        accountId: "account",
        from: { name: "Taylor", email: "taylor@example.com" },
        to: [{ email: "me@example.com" }],
        subject: "Hello",
        date: "2026-07-16T12:00:00Z",
        flags: { read: true, starred: false, draft: false },
      }),
    ).toBe("Taylor <taylor@example.com>");
  });

  it("prefers Reply-To addresses over the sender", () => {
    expect(
      replyRecipient("me@example.com", {
        id: "incoming",
        threadId: "thread",
        accountId: "account",
        from: { name: "Automated sender", email: "noreply@example.com" },
        replyTo: [
          { name: "Taylor, Jane", email: "taylor@example.com" },
          { email: "team@example.com" },
        ],
        to: [{ email: "me@example.com" }],
        subject: "Hello",
        date: "2026-07-16T12:00:00Z",
        flags: { read: true, starred: false, draft: false },
      }),
    ).toBe('"Taylor, Jane" <taylor@example.com>, team@example.com');
  });

  it("uses the external recipient when the latest message was sent by the account", () => {
    expect(
      replyRecipient("me@example.com", {
        id: "outgoing",
        threadId: "thread",
        accountId: "account",
        from: { email: "ME@example.com" },
        to: [{ email: "me@example.com" }, { name: "Taylor", email: "taylor@example.com" }],
        subject: "Hello",
        date: "2026-07-16T12:00:00Z",
        flags: { read: true, starred: false, draft: false },
      }),
    ).toBe("Taylor <taylor@example.com>");
  });
});

describe("compose recipient parsing", () => {
  it("reports invalid entries instead of dropping them silently", () => {
    expect(parseAddressField("valid@example.com, not-an-address")).toEqual({
      addresses: [{ email: "valid@example.com" }],
      invalid: true,
    });
  });

  it("uses the same email validation as the desktop contract", () => {
    expect(parseAddressField("valid@example.com, a@b..com")).toEqual({
      addresses: [{ email: "valid@example.com" }],
      invalid: true,
    });
  });

  it("keeps quoted display names containing commas", () => {
    expect(parseAddressField('"Doe, Jane" <jane@example.com>')).toEqual({
      addresses: [{ name: "Doe, Jane", email: "jane@example.com" }],
      invalid: false,
    });
  });
});

describe("account selection", () => {
  it("clears a filter when its account was removed", () => {
    expect(reconcileAccountSelection("removed", [{ id: "remaining" }])).toBeUndefined();
    expect(reconcileAccountSelection("remaining", [{ id: "remaining" }])).toBe("remaining");
  });

  it("updates both global and per-account unread counts", () => {
    const state = {
      unreadCount: 4,
      countsByAccount: {
        primary: { unreadCount: 3, draftCount: 1 },
        secondary: { unreadCount: 1, draftCount: 0 },
      },
    } as unknown as Parameters<typeof adjustUnreadCount>[0];

    expect(adjustUnreadCount(state, "primary", -1)).toMatchObject({
      unreadCount: 3,
      countsByAccount: {
        primary: { unreadCount: 2, draftCount: 1 },
        secondary: { unreadCount: 1, draftCount: 0 },
      },
    });
  });
});

function thread(id: string): ThreadSummary {
  return {
    id,
    accountId: "account",
    accountEmail: "me@example.com",
    subject: id,
    senderName: "Sender",
    senderEmail: "sender@example.com",
    snippet: id,
    date: `2026-07-16T12:00:0${id.length}Z`,
    unread: false,
    starred: false,
    draft: false,
    hasAttachments: false,
    messageCount: 1,
    labels: [],
    folderRoles: ["inbox"],
  };
}

function page(
  items: ThreadSummary[],
  nextCursor: string | undefined,
  totalCount: number,
): ThreadPage {
  return {
    items,
    totalCount,
    syncing: false,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
