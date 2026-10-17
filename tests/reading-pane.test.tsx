/** @vitest-environment jsdom */
import { createRef, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadingPane, type ReadingPaneHandle } from "../src/renderer/components/ReadingPane";
import { quotedReplyCitation } from "../src/shared/quoted-reply";
import type {
  FluxmailDesktopApi,
  MailMessage,
  MailThread,
  ModifyActionInput,
  ThreadSummary,
} from "../src/shared/contracts";

vi.mock("../src/renderer/components/EmailHtml", () => ({
  EmailHtml: () => <div>Email body</div>,
}));

globalThis.ResizeObserver = class ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

// The editor measures its selection when its content changes, which jsdom cannot do.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReadingPane", () => {
  it("announces when a conversation is opening", () => {
    const getThread = vi.fn(() => new Promise<MailThread>(() => undefined));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });

    renderPane(summary());

    expect(screen.getByRole("status").textContent).toBe("Opening conversation...");
  });

  it("opens and closes the conversation find bar through its imperative handle", async () => {
    const getThread = vi.fn(async () => detail("Searchable subject", "message-1"));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    const ref = createRef<ReadingPaneHandle>();
    render(
      <ReadingPane
        ref={ref}
        view="inbox"
        thread={summary()}
        labels={[]}
        allowPermanentDelete={false}
        onModify={vi.fn(async () => undefined)}
        onError={vi.fn()}
        onQuickReplyDirtyChange={vi.fn()}
      />,
    );
    await screen.findByText("Searchable subject");

    act(() => ref.current?.openFind());

    const input = screen.getByRole("textbox", { name: "Find in conversation" });
    expect(input.getAttribute("aria-keyshortcuts")).toBe("Meta+F Control+F");
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByRole("status").textContent).toBe("No matches");

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Find in conversation" })).toBeNull();
  });

  it("keeps collapsed messages searchable and restores their collapsed state", async () => {
    const getThread = vi.fn(async () => detail("Searchable subject", "message-1"));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    const ref = createRef<ReadingPaneHandle>();
    render(
      <ReadingPane
        ref={ref}
        view="inbox"
        thread={summary()}
        labels={[]}
        allowPermanentDelete={false}
        onModify={vi.fn(async () => undefined)}
        onError={vi.fn()}
        onQuickReplyDirtyChange={vi.fn()}
      />,
    );
    await screen.findByText("Searchable subject");

    fireEvent.click(screen.getByRole("button", { name: "Collapse message" }));
    expect(screen.queryByText("Email body")).toBeNull();

    act(() => ref.current?.openFind());
    fireEvent.change(screen.getByRole("textbox", { name: "Find in conversation" }), {
      target: { value: "Email" },
    });

    expect(screen.getByText("Email body")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Collapse message" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find in conversation" }), {
      key: "Escape",
    });

    expect(screen.queryByText("Email body")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand message" })).toBeTruthy();
  });

  it("shows full To, CC, and BCC recipient addresses", async () => {
    const thread = detail("Recipient details", "message-1");
    thread.messages[0]!.to = [
      { name: "Richard Chu", email: "richard@example.com" },
      { email: "second@example.com" },
    ];
    thread.messages[0]!.cc = [{ name: "Jamie Park", email: "jamie@example.com" }];
    thread.messages[0]!.bcc = [{ name: "Hidden Person", email: "hidden@example.com" }];
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary());

    await screen.findByText("Recipient details");

    const toRecipients = screen.getByText(
      "to Richard Chu <richard@example.com>, second@example.com",
    );
    expect(toRecipients.getAttribute("title")).toBe(
      "to Richard Chu <richard@example.com>, second@example.com",
    );
    expect(screen.getByText("cc Jamie Park <jamie@example.com>")).toBeTruthy();
    expect(screen.getByText("bcc Hidden Person <hidden@example.com>")).toBeTruthy();

    fireEvent.click(toRecipients);

    expect(screen.queryByText("Email body")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand message" })).toBeTruthy();
  });

  it("reloads an open conversation when its message count changes", async () => {
    const getThread = vi
      .fn<() => Promise<MailThread>>()
      .mockResolvedValueOnce(detail("First subject", "message-1"))
      .mockResolvedValueOnce(detail("Updated subject", "message-2"));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    const initial = summary({ messageCount: 1, date: "2026-07-16T12:00:00Z" });
    const { rerender } = renderPane(initial);
    await screen.findByText("First subject");

    rerender(
      <ReadingPane
        view="inbox"
        thread={summary({ messageCount: 2, date: "2026-07-16T13:00:00Z" })}
        labels={[]}
        allowPermanentDelete={false}
        onModify={vi.fn(async () => undefined)}
        onError={vi.fn()}
        onQuickReplyDirtyChange={vi.fn()}
      />,
    );

    await screen.findByText("Updated subject");
    await waitFor(() => expect(getThread).toHaveBeenCalledTimes(2));
  });

  it("offers restore without permanent delete for Gmail Trash", async () => {
    const getThread = vi.fn(async () => detail("Deleted subject", "message-1"));
    const onModify = vi.fn<(action: ModifyActionInput) => Promise<void>>(async () => undefined);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary({ folderRoles: ["trash"] }), { view: "trash", onModify });
    await screen.findByText("Deleted subject");

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect(onModify).toHaveBeenNthCalledWith(1, { type: "untrash" });
    expect(screen.queryByRole("button", { name: "Delete permanently" })).toBeNull();
  });

  it("offers permanent delete when the account grants full Gmail access", async () => {
    const getThread = vi.fn(async () => detail("Deleted subject", "message-1"));
    const onModify = vi.fn<(action: ModifyActionInput) => Promise<void>>(async () => undefined);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary({ folderRoles: ["trash"] }), {
      view: "trash",
      onModify,
      allowPermanentDelete: true,
    });
    await screen.findByText("Deleted subject");

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(onModify).toHaveBeenCalledWith({ type: "delete" });
  });

  it("hides Reply all when it would have the same recipients as Reply", async () => {
    const getThread = vi.fn(async () => detail("Direct message", "message-1"));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary());

    await screen.findByText("Direct message");

    expect(screen.queryByRole("button", { name: "Reply all" })).toBeNull();
  });

  it("offers Reply all when the message has another recipient", async () => {
    const thread = detail("Group message", "message-1");
    thread.messages[0]!.to.push({ email: "teammate@example.com" });
    const getThread = vi.fn(async () => thread);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary());

    await screen.findByText("Group message");
    fireEvent.click(screen.getByRole("button", { name: "Reply all" }));

    expect(screen.getByText("Reply to everyone")).toBeTruthy();
  });

  it("scrolls to the inline composer and offers scheduled send", async () => {
    const thread = detail("Reply subject", "message-1");
    thread.messages[0]!.to.push({ email: "teammate@example.com" });
    const getThread = vi.fn(async () => thread);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
        attachments: {
          prepare: vi.fn(async () => []),
          pick: vi.fn(async () => []),
          release: vi.fn(async () => undefined),
        },
      } as unknown as FluxmailDesktopApi,
    });
    const { container } = renderPane(summary());
    await screen.findByText("Reply subject");
    const scroller = container.querySelector<HTMLElement>(".conversation-scroll")!;
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(scrollTop).toBe(1_200);
    expect(container.querySelector(".quick-reply .send-button .lucide-send")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "More send options" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    scrollTop = 0;
    fireEvent.click(screen.getByRole("button", { name: "Reply all" }));
    expect(scrollTop).toBe(1_200);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    scrollTop = 0;
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await screen.findByRole("textbox", { name: "To" });
    expect(scrollTop).toBe(1_200);
    fireEvent.change(screen.getByRole("textbox", { name: "To" }), {
      target: { value: "friend@example.com" },
    });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole("button", { name: "More send options" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("restores a saved reply draft inline with its reply target", async () => {
    const thread = detail("Saved reply", "original-message");
    thread.messages.push({
      ...thread.messages[0]!,
      id: "draft-message",
      draftId: "draft-1",
      from: { email: "me@example.com" },
      to: [{ email: "sender@example.com" }],
      body: { html: "<p>Saved answer</p>", text: "Saved answer" },
      flags: { read: true, starred: false, draft: true },
    });
    const send = vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" }));
    const onDraftFinished = vi.fn();
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
        drafts: {
          recipientFields: vi.fn(async () => undefined),
          save: vi.fn(async () => ({ draftId: "draft-1", messageId: "draft-message" })),
          delete: vi.fn(async () => undefined),
          send,
        },
        attachments: {
          prepare: vi.fn(async () => []),
          release: vi.fn(async () => undefined),
          pick: vi.fn(async () => []),
        },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary({ draft: true, messageCount: 2 }), { onDraftFinished });

    expect(await screen.findByRole("region", { name: "Draft" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New message" })).toBeNull();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Saved reply");
    expect(document.querySelector(".inline-draft-composer .tiptap")?.textContent).toBe(
      "Saved answer",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          draftId: "draft-1",
          replyToMessageId: "original-message",
        }),
      ),
    );
    expect(onDraftFinished).toHaveBeenCalledOnce();
  });

  it("leaves the quoted message out of a reply draft reopened after undo", async () => {
    const thread = detail("Saved reply", "original-message");
    thread.messages.push({
      ...thread.messages[0]!,
      id: "draft-message",
      draftId: "draft-1",
      from: { email: "me@example.com" },
      to: [{ email: "sender@example.com" }],
      body: quotedDraftBody("Saved answer", thread.messages[0]!),
      attachments: [
        {
          id: "logo",
          filename: "logo.png",
          mimeType: "image/png",
          sizeBytes: 10,
          contentId: "<logo@example.com>",
          disposition: "inline",
        },
      ],
      flags: { read: true, starred: false, draft: true },
    });
    const send = vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" }));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
        drafts: {
          recipientFields: vi.fn(async () => undefined),
          save: vi.fn(async () => ({ draftId: "draft-1", messageId: "draft-message" })),
          delete: vi.fn(async () => undefined),
          send,
        },
        attachments: {
          prepare: vi.fn(async () => [
            {
              token: "logo-token",
              filename: "logo.png",
              mimeType: "image/png",
              sizeBytes: 10,
              contentId: "<logo@example.com>",
              disposition: "inline",
            },
          ]),
          release: vi.fn(async () => undefined),
          pick: vi.fn(async () => []),
        },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary({ draft: true, messageCount: 2 }));

    expect(await screen.findByRole("region", { name: "Draft" })).toBeTruthy();
    expect(document.querySelector(".inline-draft-composer .tiptap")?.textContent).toBe(
      "Saved answer",
    );
    expect(screen.queryByText("logo.png")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: "draft-1",
        replyToMessageId: "original-message",
        html: '<p style="margin: 0px;">Saved answer</p>',
        text: "Saved answer",
        attachments: [],
      }),
    );
  });

  it("answers the message a reply draft quotes instead of the newest one", async () => {
    const thread = detail("Saved reply", "original-message");
    const quotedBody = quotedDraftBody("Saved answer", thread.messages[0]!);
    thread.messages.push(
      {
        ...thread.messages[0]!,
        id: "later-message",
        from: { email: "someone@example.com" },
        date: "2026-07-18T12:00:00Z",
      },
      {
        ...thread.messages[0]!,
        id: "draft-message",
        draftId: "draft-1",
        from: { email: "me@example.com" },
        to: [{ email: "sender@example.com" }],
        body: quotedBody,
        flags: { read: true, starred: false, draft: true },
      },
    );
    const send = vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" }));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
        drafts: {
          recipientFields: vi.fn(async () => undefined),
          save: vi.fn(async () => ({ draftId: "draft-1", messageId: "draft-message" })),
          delete: vi.fn(async () => undefined),
          send,
        },
        attachments: {
          prepare: vi.fn(async () => []),
          release: vi.fn(async () => undefined),
          pick: vi.fn(async () => []),
        },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary({ draft: true, messageCount: 3 }));

    expect(await screen.findByRole("region", { name: "Draft" })).toBeTruthy();
    expect(document.querySelector(".inline-draft-composer .tiptap")?.textContent).toBe(
      "Saved answer",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: "draft-1",
        replyToMessageId: "original-message",
        html: '<p style="margin: 0px;">Saved answer</p>',
      }),
    );
  });

  it("keeps a quote it cannot attribute to a message in the conversation", async () => {
    const thread = detail("Saved reply", "original-message");
    const foreignQuote =
      "<p>Saved answer</p><p>Le 16 juillet 2026, sender@example.com a ecrit:</p>" +
      "<blockquote><p>Receipt</p></blockquote>";
    thread.messages.push(
      {
        ...thread.messages[0]!,
        id: "later-message",
        from: { email: "someone@example.com" },
        date: "2026-07-18T12:00:00Z",
      },
      {
        ...thread.messages[0]!,
        id: "draft-message",
        draftId: "draft-1",
        from: { email: "me@example.com" },
        to: [{ email: "sender@example.com" }],
        body: { html: foreignQuote, text: "Saved answer" },
        flags: { read: true, starred: false, draft: true },
      },
    );
    const send = vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" }));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
        drafts: {
          recipientFields: vi.fn(async () => undefined),
          save: vi.fn(async () => ({ draftId: "draft-1", messageId: "draft-message" })),
          delete: vi.fn(async () => undefined),
          send,
        },
        attachments: {
          prepare: vi.fn(async () => []),
          release: vi.fn(async () => undefined),
          pick: vi.fn(async () => []),
        },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary({ draft: true, messageCount: 3 }));

    expect(await screen.findByRole("region", { name: "Draft" })).toBeTruthy();
    expect(document.querySelector(".inline-draft-composer .tiptap")?.textContent).toContain(
      "Receipt",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: "draft-1",
        replyToMessageId: "later-message",
        html: foreignQuote.replaceAll("<p>", '<p style="margin: 0px;">'),
      }),
    );
  });

  it("opens the scheduled draft selected within a shared conversation", async () => {
    const thread = detail("Original subject", "original-message");
    thread.messages.push(
      {
        ...thread.messages[0]!,
        id: "first-draft-message",
        draftId: "first-draft",
        subject: "First scheduled reply",
        body: { text: "First body" },
        flags: { read: true, starred: false, draft: true },
      },
      {
        ...thread.messages[0]!,
        id: "second-draft-message",
        draftId: "second-draft",
        subject: "Second scheduled reply",
        body: { text: "Second body" },
        flags: { read: true, starred: false, draft: true },
      },
    );
    const getThread = vi.fn(async () => thread);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
        drafts: {
          recipientFields: vi.fn(async () => undefined),
        },
        attachments: {
          prepare: vi.fn(async () => []),
          release: vi.fn(async () => undefined),
        },
      } as unknown as FluxmailDesktopApi,
    });
    const onError = vi.fn();
    const onQuickReplyDirtyChange = vi.fn();
    const scheduledPane = (selected: ThreadSummary) => (
      <ReadingPane
        view="scheduled"
        thread={selected}
        labels={[]}
        allowPermanentDelete={false}
        onModify={vi.fn(async () => undefined)}
        onError={onError}
        onQuickReplyDirtyChange={onQuickReplyDirtyChange}
        undoSendDelaySeconds={0}
      />
    );
    const { rerender } = render(
      scheduledPane(
        summary({
          draft: true,
          draftId: "first-draft",
          scheduleId: "first-schedule",
          messageCount: 3,
        }),
      ),
    );

    expect(((await screen.findByLabelText("Subject")) as HTMLInputElement).value).toBe(
      "First scheduled reply",
    );
    expect(document.querySelector(".inline-draft-composer .tiptap")?.textContent).toBe(
      "First body",
    );

    rerender(
      scheduledPane(
        summary({
          draft: true,
          draftId: "second-draft",
          scheduleId: "second-schedule",
          messageCount: 3,
        }),
      ),
    );

    await waitFor(() =>
      expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe(
        "Second scheduled reply",
      ),
    );
    expect(document.querySelector(".inline-draft-composer .tiptap")?.textContent).toBe(
      "Second body",
    );
    await act(async () => {
      cleanup();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("shows an undo-pending draft as a message preview", async () => {
    const thread = detail("Pending reply", "original-message");
    thread.messages.push({
      ...thread.messages[0]!,
      id: "pending-message",
      draftId: "pending-draft",
      from: { email: "me@example.com" },
      to: [{ email: "sender@example.com" }],
      body: { text: "Pending answer" },
      flags: { read: true, starred: false, draft: true },
    });
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
      } as unknown as FluxmailDesktopApi,
    });

    renderPane(
      summary({
        draft: true,
        draftId: "pending-draft",
        scheduleId: "pending-schedule",
        pendingSend: true,
        messageCount: 2,
      }),
    );

    await screen.findByText("Pending reply");
    expect(screen.getAllByRole("button", { name: "Collapse message" })).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Draft" })).toBeNull();
    expect(screen.queryByLabelText("Subject")).toBeNull();
  });

  it("hides reply actions when an undo-pending draft is the only message", async () => {
    const thread = detail("Pending message", "pending-message");
    thread.messages[0] = {
      ...thread.messages[0]!,
      draftId: "pending-draft",
      from: { email: "me@example.com" },
      to: [{ email: "friend@example.com" }],
      body: { text: "Pending body" },
      flags: { read: true, starred: false, draft: true },
    };
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
      } as unknown as FluxmailDesktopApi,
    });

    renderPane(
      summary({
        draft: true,
        draftId: "pending-draft",
        scheduleId: "pending-schedule",
        pendingSend: true,
      }),
    );

    await screen.findByText("Pending message");
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forward" })).toBeNull();
  });

  it("keeps an edited draft mounted when its refreshed summary date changes", async () => {
    const thread = detail("Saved reply", "original-message");
    thread.messages.push({
      ...thread.messages[0]!,
      id: "draft-message",
      draftId: "draft-1",
      to: [{ email: "sender@example.com" }],
      body: { html: "<p>Saved answer</p>", text: "Saved answer" },
      flags: { read: true, starred: false, draft: true },
    });
    const getThread = vi.fn(async () => thread);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
        drafts: {
          recipientFields: vi.fn(async () => undefined),
          save: vi.fn(async () => ({ draftId: "draft-1", messageId: "draft-message" })),
          delete: vi.fn(async () => undefined),
          send: vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" })),
        },
        attachments: {
          prepare: vi.fn(async () => []),
          release: vi.fn(async () => undefined),
          pick: vi.fn(async () => []),
        },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    const onModify = vi.fn(async () => undefined);
    const onError = vi.fn();
    const onQuickReplyDirtyChange = vi.fn();
    const rendered = render(
      <ReadingPane
        view="inbox"
        thread={summary({ draft: true, messageCount: 2 })}
        labels={[]}
        allowPermanentDelete={false}
        onModify={onModify}
        onError={onError}
        onQuickReplyDirtyChange={onQuickReplyDirtyChange}
      />,
    );
    const subject = (await screen.findByLabelText("Subject")) as HTMLInputElement;
    fireEvent.change(subject, { target: { value: "Edited subject" } });

    rendered.rerender(
      <ReadingPane
        view="inbox"
        thread={summary({
          draft: true,
          messageCount: 2,
          date: "2026-07-16T13:00:00Z",
        })}
        labels={[]}
        allowPermanentDelete={false}
        onModify={onModify}
        onError={onError}
        onQuickReplyDirtyChange={onQuickReplyDirtyChange}
      />,
    );

    expect(screen.getByLabelText("Subject")).toBe(subject);
    expect(subject.value).toBe("Edited subject");
    expect(getThread).toHaveBeenCalledTimes(2);
  });

  it("keeps the inline draft open when coordinated navigation cannot save it", async () => {
    const thread = detail("Saved reply", "original-message");
    thread.messages.push({
      ...thread.messages[0]!,
      id: "draft-message",
      draftId: "draft-1",
      to: [{ email: "sender@example.com" }],
      body: { text: "Saved answer" },
      flags: { read: true, starred: false, draft: true },
    });
    const save = vi.fn(async () => {
      throw new Error("Save failed");
    });
    const onError = vi.fn();
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
        drafts: {
          recipientFields: vi.fn(async () => undefined),
          save,
          delete: vi.fn(async () => undefined),
          send: vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" })),
        },
        attachments: {
          prepare: vi.fn(async () => []),
          release: vi.fn(async () => undefined),
          pick: vi.fn(async () => []),
        },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    const ref = createRef<ReadingPaneHandle>();
    render(
      <ReadingPane
        ref={ref}
        view="inbox"
        thread={summary({ draft: true, messageCount: 2 })}
        labels={[]}
        allowPermanentDelete={false}
        onModify={vi.fn(async () => undefined)}
        onError={onError}
        onQuickReplyDirtyChange={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Subject"), {
      target: { value: "Unsaved edit" },
    });

    let closed = true;
    await act(async () => {
      closed = (await ref.current?.closeDraft()) ?? true;
    });

    expect(closed).toBe(false);
    expect(screen.getByRole("region", { name: "Draft" })).toBeTruthy();
    expect(onError).toHaveBeenCalledWith("Save failed");
  });

  it("shows the inline forward composer with the original attachments", async () => {
    const message = detail("Forward subject", "message-1").messages[0]!;
    message.attachments = [
      {
        id: "attachment-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 128,
      },
    ];
    const getThread = vi.fn(async () => ({
      ...detail("Forward subject", "message-1"),
      messages: [message],
    }));
    const prepared = {
      token: "prepared-attachment",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 128,
    };
    const prepare = vi.fn(async () => [prepared]);
    const release = vi.fn(async () => undefined);
    const forward = vi.fn(async () => undefined);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread, forward },
        attachments: {
          prepare,
          release,
          pick: vi.fn(async () => []),
        },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary(), { strict: true });
    await screen.findByText("Forward subject");

    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    expect(await screen.findByRole("textbox", { name: "To" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove report.pdf" })).toBeTruthy();
    expect(prepare).toHaveBeenCalledWith({
      accountId: "account-1",
      messageId: "message-1",
      attachments: message.attachments,
    });
    expect(release).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "To" }), {
      target: { value: "friend@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { accountId: "account-1", threadId: "thread-1" },
          messageId: "message-1",
          to: [{ email: "friend@example.com" }],
          attachments: [prepared],
          includeAttachments: false,
        }),
      ),
    );
    expect(release).toHaveBeenCalledWith([prepared.token]);
  });

  it("confirms before replacing a dirty inline composer", async () => {
    const getThread = vi.fn(async () => detail("Reply subject", "message-1"));
    const attachment = {
      token: "reply-attachment",
      filename: "draft.txt",
      mimeType: "text/plain",
      sizeBytes: 32,
    };
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
        attachments: {
          pick: vi.fn(async () => [attachment]),
          release: vi.fn(async () => undefined),
        },
      } as unknown as FluxmailDesktopApi,
    });
    const confirmDiscard = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPane(summary());
    await screen.findByText("Reply subject");

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await screen.findByRole("button", { name: "Remove draft.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    expect(confirmDiscard).toHaveBeenCalledWith("Discard this unsent message?");
    expect(screen.getByRole("button", { name: "Remove draft.txt" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "To" })).toBeNull();

    confirmDiscard.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    const to = await screen.findByRole("textbox", { name: "To" });
    fireEvent.change(to, { target: { value: "friend@example.com" } });
    confirmDiscard.mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect((screen.getByRole("textbox", { name: "To" }) as HTMLInputElement).value).toBe(
      "friend@example.com",
    );

    confirmDiscard.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByText("Write a reply")).toBeTruthy();
  });

  it("closes the quick-reply editor after its contents are discarded", async () => {
    const getThread = vi.fn(async () => detail("Reply subject", "message-1"));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    const rendered = renderPane(summary(), { quickReplyDiscardVersion: 0 });
    await screen.findByText("Reply subject");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByText("Write a reply")).toBeTruthy();

    rendered.rerender(
      <ReadingPane
        view="inbox"
        thread={summary()}
        labels={[]}
        allowPermanentDelete={false}
        onModify={vi.fn(async () => undefined)}
        onError={vi.fn()}
        onQuickReplyDirtyChange={vi.fn()}
        quickReplyDiscardVersion={1}
      />,
    );

    expect(screen.queryByText("Write a reply")).toBeNull();
  });

  it("shows the outbound citation and quoted body when expanding a quick reply", async () => {
    const getThread = vi.fn(async () => detail("Reply subject", "message-1"));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread },
      } as unknown as FluxmailDesktopApi,
    });
    const { container } = renderPane(summary());
    await screen.findByText("Reply subject");

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.click(screen.getByRole("button", { name: "Show quoted message" }));

    expect(screen.getByText(/^On .+ sender@example\.com wrote:$/)).toBeTruthy();
    expect(container.querySelector(".quick-reply .quoted-reply-body")?.textContent).toBe(
      "Email body",
    );
  });

  it("leaves reply recipients to the engine when the headers are sendable", async () => {
    const send = vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" }));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => detail("Reply subject", "message-1")) },
        drafts: { send },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary());
    await screen.findByText("Reply subject");

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(screen.queryByRole("textbox", { name: "To" })).toBeNull();

    await writeReply("Thanks");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ to: [], replyToMessageId: "message-1" }),
      ),
    );
  });

  it("replies from the send-as address the message was sent to", async () => {
    const thread = detail("Alias subject", "message-1");
    thread.messages[0]!.to = [{ email: "team@example.com" }];
    const send = vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" }));
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: {
          sendAs: vi.fn(async () => [
            { email: "me@example.com", isPrimary: true },
            { email: "team@example.com", isPrimary: false },
          ]),
        },
        mail: { getThread: vi.fn(async () => thread) },
        drafts: { send },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    renderPane(summary());
    await screen.findByText("Alias subject");

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const from = (await screen.findByLabelText("From")) as HTMLSelectElement;
    expect(from.selectedOptions[0]?.textContent).toBe("team@example.com");

    fireEvent.change(from, { target: { value: "account-1:me@example.com" } });
    await writeReply("Thanks");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ from: "me@example.com", replyToMessageId: "message-1" }),
      ),
    );
  });

  it("names the recipients when a reply address is one Fluxmail cannot send to", async () => {
    const thread = detail("Payment receipt", "message-1");
    thread.messages[0]!.from = { name: "PayPal", email: "service@paypal.example" };
    thread.messages[0]!.replyTo = [{ name: "Richard Chu", email: "someone@gmail.c..." }];
    const send = vi.fn(async () => ({ id: "sent-message", threadId: "thread-1" }));
    const onError = vi.fn();
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: {
        accounts: { sendAs: async () => [] },
        mail: { getThread: vi.fn(async () => thread) },
        drafts: { send },
        analytics: { trackFeature: vi.fn(async () => undefined) },
      } as unknown as FluxmailDesktopApi,
    });
    render(
      <ReadingPane
        view="inbox"
        thread={summary()}
        labels={[]}
        allowPermanentDelete={false}
        onModify={vi.fn(async () => undefined)}
        onError={onError}
        onQuickReplyDirtyChange={vi.fn()}
        undoSendDelaySeconds={0}
      />,
    );
    await screen.findByText("Payment receipt");

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const to = (await screen.findByRole("textbox", { name: "To" })) as HTMLInputElement;

    expect(to.value).toBe("Richard Chu <someone@gmail.c...>");

    await writeReply("Thanks");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onError).toHaveBeenCalledWith(
      "Fluxmail cannot send to the reply address on this message. Correct it and try again.",
    );
    expect(send).not.toHaveBeenCalled();

    fireEvent.change(to, { target: { value: "" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(to, { target: { value: "Richard Chu <someone@gmail.com>" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [{ name: "Richard Chu", email: "someone@gmail.com" }],
          replyToMessageId: "message-1",
        }),
      ),
    );
  });
});

async function writeReply(text: string): Promise<void> {
  const paragraph = document.querySelector(".quick-reply .tiptap p")!;
  paragraph.textContent = text;
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
}

function renderPane(
  thread: ThreadSummary,
  options: {
    view?: "inbox" | "trash" | "scheduled";
    onModify?: (action: ModifyActionInput) => Promise<void>;
    quickReplyDiscardVersion?: number;
    allowPermanentDelete?: boolean;
    strict?: boolean;
    onDraftFinished?: () => void;
  } = {},
) {
  const pane = (
    <ReadingPane
      view={options.view ?? "inbox"}
      thread={thread}
      labels={[]}
      allowPermanentDelete={options.allowPermanentDelete ?? false}
      onModify={options.onModify ?? vi.fn(async () => undefined)}
      onError={vi.fn()}
      onQuickReplyDirtyChange={vi.fn()}
      undoSendDelaySeconds={0}
      quickReplyDiscardVersion={options.quickReplyDiscardVersion}
      onDraftFinished={options.onDraftFinished}
    />
  );
  return render(options.strict ? <StrictMode>{pane}</StrictMode> : pane);
}

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    accountId: "account-1",
    accountEmail: "me@example.com",
    subject: "First subject",
    senderName: "Sender",
    senderEmail: "sender@example.com",
    snippet: "Message",
    date: "2026-07-16T12:00:00Z",
    unread: false,
    starred: false,
    draft: false,
    hasAttachments: false,
    messageCount: 1,
    labels: [],
    folderRoles: ["inbox"],
    ...overrides,
  };
}

/** A saved reply body shaped like the one the send path writes back to the provider. */
function quotedDraftBody(reply: string, quoted: MailMessage): { html: string; text: string } {
  const citation = quotedReplyCitation(quoted);
  return {
    html:
      `<p>${reply}</p><div class="gmail_quote gmail_quote_container">` +
      `<div dir="ltr" class="gmail_attr">${citation}<br></div>` +
      '<blockquote class="gmail_quote"><table><tr><td><b>Receipt</b></td></tr></table>' +
      "</blockquote></div>",
    text: `${reply}\n\n${citation}\n> Receipt`,
  };
}

function detail(subject: string, messageId: string): MailThread {
  return {
    id: "thread-1",
    accountId: "account-1",
    accountEmail: "me@example.com",
    subject,
    messages: [
      {
        id: messageId,
        threadId: "thread-1",
        accountId: "account-1",
        from: { email: "sender@example.com" },
        to: [{ email: "me@example.com" }],
        subject,
        date: "2026-07-16T12:00:00Z",
        flags: { read: true, starred: false, draft: false },
      },
    ],
  };
}
