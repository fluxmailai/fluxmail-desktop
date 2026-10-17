import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message, Thread } from "@fluxmail/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailCache } from "../src/main/cache";
import type { AccountInfo } from "../src/shared/contracts";

const directories: string[] = [];
const primary: AccountInfo = {
  id: "account-a",
  email: "alex@example.com",
  provider: "gmail",
  status: "active",
};
const secondary: AccountInfo = {
  id: "account-b",
  email: "sam@example.com",
  provider: "gmail",
  status: "active",
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("MailCache", () => {
  it("merges accounts by date, deduplicates threads, and paginates", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({ id: "m1", threadId: "thread-a", date: "2026-07-15T10:00:00Z" }),
    ]);
    cache.putMessages(primary, [
      message({
        id: "m2",
        threadId: "thread-a",
        date: "2026-07-15T12:00:00Z",
        subject: "Updated",
      }),
    ]);
    cache.putMessages(secondary, [
      message({ id: "m3", threadId: "thread-b", date: "2026-07-15T11:00:00Z" }),
    ]);

    const first = cache.listThreads({ view: "inbox", offset: 0, limit: 1 });
    const second = cache.listThreads({ view: "inbox", offset: 1, limit: 1 });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: "thread-a",
      subject: "Updated",
      messageCount: 2,
    });
    expect(second[0]).toMatchObject({ id: "thread-b", accountId: "account-b" });
    cache.close();
  });

  it("counts unread inbox threads and drafts", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({ id: "unread-one", threadId: "unread-thread" }),
      message({
        id: "unread-two",
        threadId: "unread-thread",
        date: "2026-07-15T10:00:00Z",
      }),
      message({
        id: "read",
        threadId: "read-thread",
        flags: { read: true, starred: false, draft: false },
      }),
      message({
        id: "draft",
        threadId: "draft-thread",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
    ]);

    expect(cache.unreadCount()).toBe(1);
    expect(cache.draftCount()).toBe(1);
    expect(cache.unreadCount([secondary.id])).toBe(0);
    expect(cache.draftCount([secondary.id])).toBe(0);
    cache.close();
  });

  it("lists scheduled drafts by send time and shows their recipients", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({
        id: "later-message",
        threadId: "later-thread",
        draftId: "later-draft",
        to: [{ name: "Jamie", email: "jamie@example.com" }],
        subject: "Later",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
      message({
        id: "sooner-message",
        threadId: "sooner-thread",
        draftId: "sooner-draft",
        to: [{ email: "sam@example.com" }],
        subject: "Sooner",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
    ]);

    expect(
      cache.listScheduledThreads([
        {
          scheduleId: "later-schedule",
          accountId: primary.id,
          draftId: "later-draft",
          sendAt: "2026-07-25T12:00:00Z",
        },
        {
          scheduleId: "sooner-schedule",
          accountId: primary.id,
          draftId: "sooner-draft",
          sendAt: "2026-07-24T12:00:00Z",
        },
      ]),
    ).toMatchObject([
      {
        id: "sooner-thread",
        senderName: "sam@example.com",
        date: "2026-07-24T12:00:00Z",
      },
      {
        id: "later-thread",
        senderName: "Jamie",
        date: "2026-07-25T12:00:00Z",
      },
    ]);
    cache.close();
  });

  it("shows Cc and Bcc recipients for scheduled drafts without To recipients", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({
        id: "recipient-message",
        threadId: "recipient-thread",
        draftId: "recipient-draft",
        to: [],
        cc: [{ email: "cc@example.com" }],
        bcc: [{ name: "Private", email: "bcc@example.com" }],
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
    ]);

    expect(
      cache.listScheduledThreads([
        {
          scheduleId: "recipient-schedule",
          accountId: primary.id,
          draftId: "recipient-draft",
          sendAt: "2026-07-24T12:00:00Z",
        },
      ]),
    ).toMatchObject([
      {
        senderName: "cc@example.com, Private",
        senderEmail: "cc@example.com",
      },
    ]);
    cache.close();
  });

  it("excludes active schedules from the Drafts mailbox and count", () => {
    const cache = createCache();
    const scheduled = {
      scheduleId: "scheduled",
      accountId: primary.id,
      draftId: "scheduled-draft",
      sendAt: "2026-07-24T12:00:00Z",
    };
    cache.putMessages(primary, [
      message({
        id: "scheduled-message",
        threadId: "scheduled-thread",
        draftId: scheduled.draftId,
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
      message({
        id: "ordinary-message",
        threadId: "ordinary-thread",
        draftId: "ordinary-draft",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
    ]);

    expect(
      cache
        .listThreads({
          view: "drafts",
          scheduledDrafts: [scheduled],
          offset: 0,
          limit: 20,
        })
        .map((thread) => thread.id),
    ).toEqual(["ordinary-thread"]);
    expect(cache.draftCount(undefined, [scheduled])).toBe(1);
    cache.close();
  });

  it("opens the ordinary draft when a newer scheduled draft shares its conversation", () => {
    const cache = createCache();
    const scheduled = {
      scheduleId: "scheduled",
      accountId: primary.id,
      draftId: "scheduled-draft",
      sendAt: "2026-07-24T12:00:00Z",
    };
    cache.putMessages(primary, [
      message({
        id: "ordinary-message",
        threadId: "shared-thread",
        draftId: "ordinary-draft",
        date: "2026-07-23T10:00:00Z",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
      message({
        id: "scheduled-message",
        threadId: "shared-thread",
        draftId: scheduled.draftId,
        date: "2026-07-23T11:00:00Z",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
    ]);

    const [draft] = cache.listThreads({
      view: "drafts",
      scheduledDrafts: [scheduled],
      offset: 0,
      limit: 20,
    });

    expect(draft).toMatchObject({
      id: "shared-thread",
      draftId: "ordinary-draft",
    });
    expect(draft).not.toHaveProperty("scheduleId");
    cache.close();
  });

  it("identifies the scheduled draft a generic mailbox would open", () => {
    const cache = createCache();
    const scheduled = {
      scheduleId: "scheduled",
      accountId: primary.id,
      draftId: "scheduled-draft",
      sendAt: "2026-07-24T12:00:00Z",
    };
    cache.putMessages(primary, [
      message({
        id: "original-message",
        threadId: "shared-thread",
        date: "2026-07-23T10:00:00Z",
      }),
      message({
        id: "scheduled-message",
        threadId: "shared-thread",
        draftId: scheduled.draftId,
        date: "2026-07-23T11:00:00Z",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
    ]);

    expect(
      cache.listThreads({
        view: "all",
        scheduledDrafts: [scheduled],
        offset: 0,
        limit: 20,
      }),
    ).toMatchObject([
      {
        id: "shared-thread",
        scheduleId: scheduled.scheduleId,
        draftId: scheduled.draftId,
      },
    ]);
    cache.close();
  });

  it("keeps an undo send preview available in Sent", () => {
    const cache = createCache();
    const original = message({
      id: "original-message",
      threadId: "shared-thread",
      body: { text: "Original body" },
    });
    cache.putThread(primary, {
      id: "shared-thread",
      subject: "Project update",
      messages: [original],
    });
    const optimistic = message({
      id: "pending-message",
      threadId: "shared-thread",
      draftId: "pending-draft",
      from: { email: primary.email },
      to: [{ email: "friend@example.com" }],
      date: "2026-07-15T10:00:00Z",
      body: { text: "Pending body" },
      folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
      flags: { read: true, starred: false, draft: true },
    });
    cache.putOptimisticDraft(primary, optimistic);
    const pendingSend = {
      scheduleId: "pending-schedule",
      accountId: primary.id,
      draftId: "pending-draft",
      sendAt: "2026-07-15T10:00:10Z",
      pendingSend: true,
    };
    cache.recordResultPage(primary.id, "sent::", [], true);

    expect(
      cache.listThreads({
        view: "sent",
        resultSetKey: "sent::",
        scheduledDrafts: [pendingSend],
        offset: 0,
        limit: 20,
      }),
    ).toMatchObject([
      {
        id: "shared-thread",
        scheduleId: "pending-schedule",
        draftId: "pending-draft",
        pendingSend: true,
      },
    ]);
    expect(cache.getThread(primary.id, "shared-thread")?.messages).toMatchObject([
      { id: "original-message", body: { text: "Original body" } },
      { id: "pending-message", body: { text: "Pending body" } },
    ]);
    expect(
      cache.countThreads({
        view: "sent",
        resultSetKey: "sent::",
        scheduledDrafts: [pendingSend],
      }),
    ).toBe(1);
    cache.close();
  });

  it("keeps scheduled drafts in the same conversation distinct", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({
        id: "first-message",
        threadId: "shared-thread",
        draftId: "first-draft",
        to: [{ email: "first@example.com" }],
        subject: "First scheduled reply",
        snippet: "First body",
        date: "2026-07-23T10:00:00Z",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
      message({
        id: "second-message",
        threadId: "shared-thread",
        draftId: "second-draft",
        to: [{ email: "second@example.com" }],
        subject: "Second scheduled reply",
        snippet: "Second body",
        date: "2026-07-23T11:00:00Z",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
    ]);

    expect(
      cache.listScheduledThreads([
        {
          scheduleId: "first-schedule",
          accountId: primary.id,
          draftId: "first-draft",
          sendAt: "2026-07-24T12:00:00Z",
        },
        {
          scheduleId: "second-schedule",
          accountId: primary.id,
          draftId: "second-draft",
          sendAt: "2026-07-25T12:00:00Z",
        },
      ]),
    ).toMatchObject([
      {
        id: "shared-thread",
        scheduleId: "first-schedule",
        draftId: "first-draft",
        subject: "First scheduled reply",
        senderName: "first@example.com",
      },
      {
        id: "shared-thread",
        scheduleId: "second-schedule",
        draftId: "second-draft",
        subject: "Second scheduled reply",
        senderName: "second@example.com",
      },
    ]);
    cache.close();
  });

  it("enumerates and removes all cached state for a disconnected account", () => {
    const cache = createCache();
    cache.putMessages(primary, [message({ id: "primary", threadId: "primary-thread" })]);
    cache.putMessages(secondary, [message({ id: "secondary", threadId: "secondary-thread" })]);
    cache.claimMutation("pending", [{ accountId: primary.id, threadId: "primary-thread" }]);

    expect(cache.accountIds().sort()).toEqual([primary.id, secondary.id]);
    cache.deleteAccount(primary.id);
    expect(cache.accountIds()).toEqual([secondary.id]);
    expect(cache.ownsMutation(primary.id, "primary-thread", "pending")).toBe(false);
    expect(cache.unreadCount()).toBe(1);
    cache.close();
  });

  it("replaces the cached message when a draft keeps its ID across updates", () => {
    const cache = createCache();
    const draft = {
      draftId: "draft-1",
      folder: { id: "DRAFT", name: "Drafts", role: "drafts" as const },
      flags: { read: true, starred: false, draft: true },
    };
    cache.putMessages(primary, [message({ ...draft, id: "old-message", threadId: "old-thread" })]);
    cache.putMessages(primary, [message({ ...draft, id: "new-message", threadId: "new-thread" })]);

    expect(cache.draftCount()).toBe(1);
    expect(cache.messageIds(primary.id, "old-thread")).toEqual([]);
    expect(cache.messageIds(primary.id, "new-thread")).toEqual(["new-message"]);
    cache.close();
  });

  it("preserves raw draft recipient fields until the draft is deleted", () => {
    const cache = createCache();
    const draft = message({
      id: "draft-message",
      threadId: "draft-thread",
      draftId: "draft-1",
      to: [{ email: "valid@example.com" }],
      folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
      flags: { read: true, starred: false, draft: true },
    });
    cache.putMessages(primary, [draft]);
    cache.putDraftRecipientFields(
      primary.id,
      "draft-1",
      {
        to: "valid@example.com, unfinished@",
        cc: "",
        bcc: "",
      },
      draft,
    );

    expect(cache.getDraftRecipientFields(primary.id, "draft-1")).toEqual({
      to: "valid@example.com, unfinished@",
      cc: "",
      bcc: "",
    });
    expect(cache.hasDraft(primary.id, "draft-1")).toBe(true);

    cache.deleteDraft(primary, "draft-1");
    expect(cache.getDraftRecipientFields(primary.id, "draft-1")).toBeUndefined();
    expect(cache.hasDraft(primary.id, "draft-1")).toBe(false);
    cache.close();
  });

  it("drops raw recipient text after the provider recipients change", () => {
    const cache = createCache();
    const localDraft = message({
      id: "draft-message",
      threadId: "draft-thread",
      draftId: "draft-1",
      to: [{ email: "original@example.com" }],
      folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
      flags: { read: true, starred: false, draft: true },
    });
    cache.putMessages(primary, [localDraft]);
    cache.putDraftRecipientFields(
      primary.id,
      "draft-1",
      { to: "original@example.com", cc: "", bcc: "" },
      localDraft,
    );

    cache.putMessages(primary, [
      {
        ...localDraft,
        to: [{ email: "updated@example.com" }],
      },
    ]);

    expect(cache.getDraftRecipientFields(primary.id, "draft-1")).toBeUndefined();
    cache.close();
  });

  it("excludes cached spam and trash from All Mail", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({ id: "inbox", threadId: "thread-inbox" }),
      message({
        id: "spam",
        threadId: "thread-spam",
        folder: { id: "SPAM", name: "Spam", role: "spam" },
      }),
      message({
        id: "trash",
        threadId: "thread-trash",
        folder: { id: "TRASH", name: "Trash", role: "trash" },
      }),
    ]);

    expect(
      cache.listThreads({ view: "all", offset: 0, limit: 20 }).map((thread) => thread.id),
    ).toEqual(["thread-inbox"]);
    expect(cache.listThreads({ view: "spam", offset: 0, limit: 20 })).toHaveLength(1);
    expect(cache.listThreads({ view: "trash", offset: 0, limit: 20 })).toHaveLength(1);

    cache.close();
  });

  it("keeps a mixed conversation in All Mail when it has a regular message", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({
        id: "mixed-spam",
        threadId: "thread-mixed",
        folder: { id: "SPAM", name: "Spam", role: "spam" },
      }),
      message({
        id: "mixed-inbox",
        threadId: "thread-mixed",
        date: "2026-07-15T10:00:00Z",
      }),
    ]);

    expect(
      cache.listThreads({ view: "all", offset: 0, limit: 20 }).map((thread) => thread.id),
    ).toEqual(["thread-mixed"]);

    cache.close();
  });

  it("searches cached summaries without storing opened bodies in plaintext", () => {
    const { cache, directory } = createCacheWithDirectory();
    const opened: Thread = {
      id: "thread-secret",
      subject: "Quarterly planning",
      messages: [
        message({
          id: "opened",
          threadId: "thread-secret",
          subject: "Quarterly planning",
          body: { html: "<p>private-body-marker</p>" },
        }),
      ],
    };
    cache.putThread(primary, opened);

    expect(
      cache.listThreads({
        view: "search",
        query: "quarterly",
        offset: 0,
        limit: 20,
      }),
    ).toHaveLength(1);
    expect(cache.getThread(primary.id, opened.id)?.messages[0]?.body?.html).toContain(
      "private-body-marker",
    );
    const databaseBytes = ["mail-cache.db", "mail-cache.db-wal"]
      .flatMap((file) => {
        try {
          return [readFileSync(path.join(directory, file))];
        } catch {
          return [];
        }
      })
      .map((buffer) => buffer.toString("utf8"))
      .join("");
    expect(databaseBytes).not.toContain("private-body-marker");
    cache.close();
  });

  it("returns opened messages without caching their bodies when encryption is unavailable", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fluxmail-cache-"));
    directories.push(directory);
    const cache = new MailCache(directory, {
      encrypt: () => undefined,
      decrypt: () => {
        throw new Error("Encryption is unavailable");
      },
    });
    const opened: Thread = {
      id: "thread-without-keychain",
      subject: "Available without caching",
      messages: [
        message({
          id: "opened-without-keychain",
          threadId: "thread-without-keychain",
          body: { html: "<p>view this without storing it</p>" },
        }),
      ],
    };

    const result = cache.putThread(primary, opened);

    expect(result.messages[0]?.body?.html).toContain("view this without storing it");
    expect(cache.hasThreadBody(primary.id, opened.id)).toBe(false);
    expect(cache.getThread(primary.id, opened.id)).toBeUndefined();
    expect(cache.listThreads({ view: "inbox", offset: 0, limit: 20 })).toHaveLength(1);
    const databaseBytes = ["mail-cache.db", "mail-cache.db-wal"]
      .flatMap((file) => {
        try {
          return [readFileSync(path.join(directory, file))];
        } catch {
          return [];
        }
      })
      .map((buffer) => buffer.toString("utf8"))
      .join("");
    expect(databaseBytes).not.toContain("view this without storing it");
    cache.close();
  });

  it("keeps provider search results that do not match summary text", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({
        id: "attachment",
        threadId: "attachment-thread",
        subject: "Quarterly report",
      }),
    ]);
    cache.recordResultPage(primary.id, "search::has:attachment", ["attachment-thread"], true);

    expect(
      cache.listThreads({
        view: "search",
        query: "has:attachment",
        resultSetKey: "search::has:attachment",
        offset: 0,
        limit: 20,
      }),
    ).toHaveLength(1);
    expect(
      cache.countThreads({
        view: "search",
        query: "has:attachment",
        resultSetKey: "search::has:attachment",
      }),
    ).toBe(1);
    cache.close();
  });

  it("discards page tokens created before the Fluxmail 0.7 cursor format", () => {
    const { cache, directory } = createCacheWithDirectory();
    cache.setPageToken(primary.id, "inbox", "legacy-page-token");
    cache.close();

    const database = new Database(path.join(directory, "mail-cache.db"));
    database.prepare("UPDATE cache_meta SET value = '4' WHERE key = 'schema_version'").run();
    database.close();

    const upgraded = new MailCache(directory, {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    });
    expect(upgraded.getPageState(primary.id, "inbox")).toEqual({ initialized: false });
    upgraded.close();
  });

  it("drops Keychain-encrypted bodies when upgrading without losing thread summaries", () => {
    const { cache, directory } = createCacheWithDirectory();
    cache.putThread(primary, {
      id: "thread-a",
      subject: "Project update",
      messages: [message({ id: "message-a", threadId: "thread-a", body: { text: "Private" } })],
    });
    expect(cache.hasThreadBody(primary.id, "thread-a")).toBe(true);
    cache.close();

    const database = new Database(path.join(directory, "mail-cache.db"));
    database.prepare("UPDATE cache_meta SET value = '5' WHERE key = 'schema_version'").run();
    database.close();

    const upgraded = new MailCache(directory, {
      encrypt: (value) => Buffer.from(value),
      decrypt: () => {
        throw new Error("Legacy Keychain decryption should not be attempted");
      },
    });
    expect(upgraded.hasThreadBody(primary.id, "thread-a")).toBe(false);
    expect(upgraded.getThread(primary.id, "thread-a")).toBeUndefined();
    expect(upgraded.listThreads({ view: "inbox", offset: 0, limit: 20 })).toMatchObject([
      { id: "thread-a", subject: "Project update" },
    ]);
    upgraded.close();
  });

  it("matches labels exactly", () => {
    const cache = createCache();
    cache.putMessages(primary, [
      message({ id: "work", threadId: "work-thread", labels: ["Work"] }),
      message({
        id: "archive",
        threadId: "archive-thread",
        labels: ["Work Archive"],
      }),
      message({
        id: "wildcard",
        threadId: "wildcard-thread",
        labels: ["Work_2026"],
      }),
    ]);

    expect(
      cache
        .listThreads({ view: "label", label: "Work", offset: 0, limit: 20 })
        .map((item) => item.id),
    ).toEqual(["work-thread"]);
    cache.close();
  });

  it("replaces folders removed by the provider", () => {
    const cache = createCache();
    cache.putFolders(primary.id, [
      { id: "INBOX", name: "Inbox", role: "inbox" },
      { id: "OLD", name: "Old label" },
    ]);
    cache.putFolders(primary.id, [{ id: "INBOX", name: "Inbox", role: "inbox" }]);

    expect(cache.listFolders()).toEqual([
      expect.objectContaining({ accountId: primary.id, id: "INBOX" }),
    ]);
    cache.close();
  });

  it("invalidates a hydrated thread when new message metadata arrives", () => {
    const cache = createCache();
    const first = message({
      id: "first",
      threadId: "thread-a",
      body: { text: "old body" },
    });
    cache.putThread(primary, {
      id: "thread-a",
      subject: first.subject,
      messages: [first],
    });
    expect(cache.getThread(primary.id, "thread-a")?.messages).toHaveLength(1);

    cache.putMessages(primary, [
      message({
        id: "second",
        threadId: "thread-a",
        date: "2026-07-15T12:00:00Z",
        body: { text: "new body" },
      }),
    ]);

    expect(cache.getThread(primary.id, "thread-a")).toBeUndefined();
    expect(cache.listThreads({ view: "inbox", offset: 0, limit: 20 })[0]?.messageCount).toBe(2);
    cache.close();
  });

  it("keeps a hydrated thread when a listing omits attachment metadata", () => {
    const cache = createCache();
    const attachment = {
      id: "attachment-1",
      filename: "plan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1200,
    };
    const opened = message({
      id: "opened",
      threadId: "thread-a",
      attachments: [attachment],
      body: { text: "body" },
    });
    cache.putThread(primary, { id: "thread-a", subject: opened.subject, messages: [opened] });

    const { attachments: _attachments, body: _body, ...listed } = opened;
    cache.putMessages(primary, [listed]);

    expect(cache.getThread(primary.id, "thread-a")?.messages[0]?.body?.text).toBe("body");
    expect(cache.listThreads({ view: "inbox", offset: 0, limit: 20 })[0]?.hasAttachments).toBe(
      true,
    );

    cache.putMessages(primary, [{ ...listed, flags: { ...listed.flags, read: true } }]);
    expect(cache.getThread(primary.id, "thread-a")).toBeUndefined();
    cache.close();
  });

  it("removes a deleted draft from summaries and hydrated bodies", () => {
    const cache = createCache();
    const draft = message({
      id: "draft-message",
      threadId: "draft-thread",
      draftId: "draft-1",
      folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
      flags: { read: true, starred: false, draft: true },
      body: { text: "draft body" },
    });
    cache.putThread(primary, {
      id: draft.threadId,
      subject: draft.subject,
      messages: [draft],
    });

    cache.deleteDraft(primary, "draft-1");

    expect(cache.listThreads({ view: "drafts", offset: 0, limit: 20 })).toEqual([]);
    expect(cache.getThread(primary.id, draft.threadId)).toBeUndefined();
    cache.close();
  });

  it("reconciles cached folder membership against a fresh provider page", () => {
    const cache = createCache();
    const current = message({
      id: "current",
      threadId: "current-thread",
      date: "2026-07-15T12:00:00Z",
    });
    const boundary = message({
      id: "boundary",
      threadId: "boundary-thread",
      date: "2026-07-15T10:00:00Z",
    });
    cache.putMessages(primary, [
      current,
      boundary,
      message({
        id: "stale",
        threadId: "stale-thread",
        date: "2026-07-15T11:00:00Z",
      }),
      message({
        id: "older",
        threadId: "older-thread",
        date: "2026-07-15T09:00:00Z",
      }),
    ]);

    expect(cache.reconcileFolderPage(primary, "inbox", [current, boundary], false)).toBe(1);
    expect(
      cache.listThreads({ view: "inbox", offset: 0, limit: 20 }).map((thread) => thread.id),
    ).toEqual(["current-thread", "boundary-thread", "older-thread"]);

    expect(cache.reconcileFolderPage(primary, "inbox", [current, boundary], true)).toBe(1);
    expect(
      cache.listThreads({ view: "inbox", offset: 0, limit: 20 }).map((thread) => thread.id),
    ).toEqual(["current-thread", "boundary-thread"]);
    cache.close();
  });

  it("rolls back an optimistic change and keeps message IDs available for permanent delete", () => {
    const cache = createCache();
    cache.putMessages(primary, [message({ id: "m1", threadId: "thread-a" })]);
    const snapshot = cache.snapshotThread(primary.id, "thread-a")!;

    cache.applyAction(primary.id, "thread-a", { type: "delete" });
    expect(cache.listThreads({ view: "all", offset: 0, limit: 20 })).toHaveLength(0);
    expect(cache.messageIds(primary.id, "thread-a")).toEqual(["m1"]);
    cache.restoreThread(snapshot);
    expect(cache.listThreads({ view: "all", offset: 0, limit: 20 })).toHaveLength(1);
    cache.close();
  });

  it("allows only the latest mutation owner to change or restore a thread", () => {
    const cache = createCache();
    cache.putMessages(primary, [message({ id: "m1", threadId: "thread-a" })]);
    const original = cache.snapshotThread(primary.id, "thread-a")!;
    const target = { accountId: primary.id, threadId: "thread-a" };

    cache.claimMutation("older", [target]);
    expect(cache.applyActionIfOwned(primary.id, "thread-a", { type: "markRead" }, "older")).toBe(
      true,
    );
    cache.claimMutation("newer", [target]);

    expect(cache.restoreThreadIfOwned(original, "older")).toBe(false);
    expect(cache.applyActionIfOwned(primary.id, "thread-a", { type: "star" }, "older")).toBe(false);
    expect(cache.applyActionIfOwned(primary.id, "thread-a", { type: "star" }, "newer")).toBe(true);
    cache.releaseMutation("older", [target]);

    expect(cache.ownsMutation(primary.id, "thread-a", "newer")).toBe(true);
    expect(cache.snapshotThread(primary.id, "thread-a")).toMatchObject({
      unread: 0,
      starred: 1,
    });
    cache.close();
  });

  it("preserves optimistic summaries while ordinary thread hydration is stale", () => {
    const cache = createCache();
    const unread = message({ id: "read-message", threadId: "read-thread" });
    const inbox = message({ id: "archive-message", threadId: "archive-thread" });
    cache.putMessages(primary, [unread, inbox]);
    const readTarget = { accountId: primary.id, threadId: unread.threadId };
    const archiveTarget = { accountId: primary.id, threadId: inbox.threadId };

    cache.claimMutation("read-mutation", [readTarget]);
    cache.applyActionIfOwned(primary.id, unread.threadId, { type: "markRead" }, "read-mutation");
    cache.claimMutation("archive-mutation", [archiveTarget]);
    cache.applyActionIfOwned(primary.id, inbox.threadId, { type: "archive" }, "archive-mutation");

    cache.putThread(primary, {
      id: unread.threadId,
      subject: unread.subject,
      messages: [unread],
    });
    cache.putThread(primary, {
      id: inbox.threadId,
      subject: inbox.subject,
      messages: [inbox],
    });

    expect(cache.snapshotThread(primary.id, unread.threadId)?.unread).toBe(0);
    expect(
      cache.listThreads({ view: "inbox", offset: 0, limit: 20 }).map((thread) => thread.id),
    ).not.toContain(inbox.threadId);

    cache.putThreadIfOwned(
      primary,
      {
        id: unread.threadId,
        subject: unread.subject,
        messages: [unread],
      },
      "read-mutation",
    );
    expect(cache.snapshotThread(primary.id, unread.threadId)?.unread).toBe(1);
    cache.close();
  });

  it("removes cached messages missing from an authoritative thread response", () => {
    const cache = createCache();
    const first = message({ id: "m1", threadId: "thread-a" });
    const second = message({ id: "m2", threadId: "thread-a" });
    cache.putThread(primary, {
      id: "thread-a",
      subject: "Thread",
      messages: [first, second],
    });

    cache.putThread(primary, {
      id: "thread-a",
      subject: "Thread",
      messages: [second],
    });

    expect(cache.messageIds(primary.id, "thread-a")).toEqual(["m2"]);
    expect(cache.snapshotThread(primary.id, "thread-a")?.message_count).toBe(1);
    cache.close();
  });

  it("notifies only after the initial inbox watermark", () => {
    const cache = createCache();
    const first = message({ id: "initial", threadId: "thread-a" });
    const next = message({
      id: "new",
      threadId: "thread-b",
      date: "2026-07-15T12:00:00Z",
    });

    expect(cache.recordInboxPage(primary.id, [first]).newMessages).toEqual([]);
    expect(
      cache.recordInboxPage(primary.id, [first, next]).newMessages.map((item) => item.id),
    ).toEqual(["new"]);
    expect(cache.recordInboxPage(primary.id, [first, next]).newMessages).toEqual([]);
    cache.close();
  });

  it("initializes notifications even when the first inbox page is empty", () => {
    const cache = createCache();
    const first = message({ id: "first", threadId: "thread-a" });

    expect(cache.recordInboxPage(primary.id, [])).toMatchObject({
      initialized: false,
      newMessages: [],
    });
    expect(cache.recordInboxPage(primary.id, [first]).newMessages).toEqual([first]);
    cache.close();
  });

  it("does not forget messages that remain on the Inbox page after 30 days", () => {
    vi.useFakeTimers();
    const cache = createCache();
    const first = message({ id: "first", threadId: "thread-a" });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      cache.recordInboxPage(primary.id, [first]);
      vi.setSystemTime(new Date("2026-02-02T00:00:00Z"));

      expect(cache.recordInboxPage(primary.id, [first]).newMessages).toEqual([]);
      expect(cache.recordInboxPage(primary.id, [first]).newMessages).toEqual([]);
    } finally {
      cache.close();
      vi.useRealTimers();
    }
  });

  it("does not notify for older messages sliding into view after archiving", () => {
    const cache = createCache();
    const newest = message({
      id: "newest",
      threadId: "thread-newest",
      date: "2026-07-15T12:00:00Z",
    });
    const middle = message({
      id: "middle",
      threadId: "thread-middle",
      date: "2026-07-15T11:00:00Z",
    });
    const older = message({
      id: "older",
      threadId: "thread-older",
      date: "2026-07-15T09:00:00Z",
    });
    const brandNew = message({
      id: "brand-new",
      threadId: "thread-brand-new",
      date: "2026-07-15T13:00:00Z",
    });

    // Initial page establishes the watermark; nothing notifies.
    expect(cache.recordInboxPage(primary.id, [newest, middle]).newMessages).toEqual([]);
    // Archiving `newest` pulls `older` (previously paged out) into the first
    // page. It was never seen, but its date predates the watermark.
    expect(
      cache.recordInboxPage(primary.id, [middle, older]).newMessages.map((item) => item.id),
    ).toEqual([]);
    // A genuinely new message still notifies.
    expect(
      cache
        .recordInboxPage(primary.id, [brandNew, middle, older])
        .newMessages.map((item) => item.id),
    ).toEqual(["brand-new"]);
    cache.close();
  });
});

function createCache(): MailCache {
  return createCacheWithDirectory().cache;
}

function createCacheWithDirectory(): { cache: MailCache; directory: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "fluxmail-cache-"));
  directories.push(directory);
  const cache = new MailCache(directory, {
    encrypt: (value) => Buffer.from(`cipher:${Buffer.from(value).toString("base64")}`),
    decrypt: (value) => Buffer.from(value.toString().slice(7), "base64").toString("utf8"),
  });
  cache.putFolders(primary.id, [{ id: "INBOX", name: "Inbox", role: "inbox", unreadCount: 3 }]);
  return { cache, directory };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "message",
    threadId: "thread",
    accountId: primary.id,
    folder: { id: "INBOX", name: "Inbox", role: "inbox" },
    from: { name: "Taylor", email: "taylor@example.net" },
    to: [{ email: primary.email }],
    subject: "Project update",
    date: "2026-07-15T09:00:00Z",
    snippet: "The latest project notes",
    flags: { read: false, starred: false, draft: false },
    ...overrides,
  };
}
