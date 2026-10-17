/** @vitest-environment jsdom */
import { createRef, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeDialog, type ComposeDialogHandle } from "../src/renderer/components/ComposeDialog";
import type { FluxmailDesktopApi, MailThread } from "../src/shared/contracts";

vi.mock("../src/renderer/components/EmailHtml", () => ({
  EmailHtml: ({ message }: { message: { id: string } }) => (
    <div data-message-id={message.id}>Email body</div>
  ),
}));

describe("ComposeDialog draft coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-20T18:00:00.000Z");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("saves edits made while an earlier autosave is running", async () => {
    const first = deferred<{ draftId: string; messageId: string }>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ draftId: "draft-1", messageId: "message-1" });
    installApi({ save });
    renderDialog();

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "First edit" },
    });
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(save).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Second edit" },
    });
    await act(async () => first.resolve({ draftId: "draft-1", messageId: "message-1" }));
    await act(async () => vi.advanceTimersByTime(1_500));

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toMatchObject({
      draftId: "draft-1",
      subject: "Second edit",
    });
  });

  it("waits for a new draft before discarding it", async () => {
    const pending = deferred<{ draftId: string; messageId: string }>();
    const save = vi.fn(() => pending.promise);
    const deleteDraft = vi.fn(async () => undefined);
    const onClose = vi.fn();
    installApi({ save, deleteDraft });
    renderDialog(onClose);

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Discard me" },
    });
    await act(async () => vi.advanceTimersByTime(1_500));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => pending.resolve({ draftId: "draft-new", messageId: "message-new" }));

    expect(deleteDraft).toHaveBeenCalledWith({
      accountId: "account-1",
      draftId: "draft-new",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("releases prepared attachment buffers when compose closes", async () => {
    const release = vi.fn(async () => undefined);
    installApi({ save: vi.fn(), release });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          initialHtml: "<p>Initial body</p>",
          initialText: "Initial body",
          initialAttachments: [
            {
              token: "attachment-token",
              filename: "notes.pdf",
              mimeType: "application/pdf",
              sizeBytes: 128,
            },
          ],
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));
    await act(async () => Promise.resolve());

    expect(release).toHaveBeenCalledWith(["attachment-token"]);
  });

  it("saves a subject-only draft before closing", async () => {
    const save = vi.fn(async () => ({
      draftId: "draft-1",
      messageId: "message-1",
    }));
    const onClose = vi.fn();
    installApi({ save });
    renderEmptyDialog({ onClose });

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Remember this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));
    await act(async () => Promise.resolve());

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Remember this", text: "" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("persists an existing draft after all of its content is cleared", async () => {
    const save = vi.fn(async () => ({
      draftId: "draft-1",
      messageId: "message-1",
    }));
    const onClose = vi.fn();
    installApi({ save });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          draftId: "draft-1",
          subject: "Remove this subject",
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={onClose}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));
    await act(async () => Promise.resolve());

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: "draft-1",
        subject: "",
        text: "",
        to: [],
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("flushes the latest draft before an external window close", async () => {
    const save = vi.fn(async () => ({
      draftId: "draft-1",
      messageId: "message-1",
    }));
    const onClose = vi.fn();
    const ref = createRef<ComposeDialogHandle>();
    installApi({ save });
    render(
      <ComposeDialog
        ref={ref}
        seed={{ accountId: "account-1" }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={onClose}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Save before closing" },
    });
    let closed = false;
    await act(async () => {
      closed = (await ref.current?.close()) ?? false;
    });

    expect(closed).toBe(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ subject: "Save before closing" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves inline draft edits through coordinated navigation", async () => {
    const save = vi.fn(async () => ({
      draftId: "draft-1",
      messageId: "message-1",
    }));
    const ref = createRef<ComposeDialogHandle>();
    const onClose = vi.fn();
    installApi({ save });
    render(
      <ComposeDialog
        ref={ref}
        inline
        seed={{ accountId: "account-1", draftId: "draft-1", subject: "Original subject" }}
        accounts={[]}
        onClose={onClose}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Updated subject" },
    });
    let closed = false;
    await act(async () => {
      closed = (await ref.current?.close()) ?? false;
    });

    expect(closed).toBe(true);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: "draft-1", subject: "Updated subject" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps inline draft attachments available through the Strict Mode effect cycle", async () => {
    const release = vi.fn(async () => undefined);
    installApi({ save: vi.fn(), release });
    const rendered = render(
      <StrictMode>
        <ComposeDialog
          inline
          seed={{
            accountId: "account-1",
            draftId: "draft-1",
            initialAttachments: [
              {
                token: "attachment-token",
                filename: "notes.pdf",
                mimeType: "application/pdf",
                sizeBytes: 128,
              },
            ],
          }}
          accounts={[]}
          onClose={vi.fn()}
          onSent={vi.fn()}
          onError={vi.fn()}
        />
      </StrictMode>,
    );

    await act(async () => vi.runOnlyPendingTimers());
    expect(release).not.toHaveBeenCalled();

    rendered.unmount();
    await act(async () => vi.runOnlyPendingTimers());
    expect(release).toHaveBeenCalledWith(["attachment-token"]);
  });

  it("saves the raw recipient text when closing with an incomplete address", async () => {
    const save = vi.fn(async () => ({
      draftId: "draft-1",
      messageId: "message-1",
    }));
    const onClose = vi.fn();
    const onError = vi.fn();
    installApi({ save });
    renderEmptyDialog({ onClose, onError });

    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "unfinished@" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));
    await act(async () => Promise.resolve());

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [],
        recipientFields: { to: "unfinished@", cc: "", bcc: "" },
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("restores a plain-text draft in the editor", () => {
    installApi({ save: vi.fn() });
    render(
      <ComposeDialog
        seed={{ accountId: "account-1", initialText: "First line\nSecond line" }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(document.querySelector(".tiptap")?.textContent).toBe("First lineSecond line");
  });

  it("sends a message with only a Bcc recipient", async () => {
    const schedule = vi.fn(async () => ({
      scheduleId: "schedule-1",
      draftId: "draft-1",
      sendAt: "2026-07-20T18:00:10.000Z",
    }));
    const onSent = vi.fn();
    const onError = vi.fn();
    installApi({ save: vi.fn(), schedule });
    render(
      <ComposeDialog
        seed={{ accountId: "account-1", initialText: "Private update" }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={onSent}
        onError={onError}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Bcc" }));
    fireEvent.change(screen.getByLabelText("Bcc"), {
      target: { value: "archive@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => Promise.resolve());

    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [],
        bcc: [{ email: "archive@example.com" }],
        text: "Private update",
        delaySeconds: 10,
      }),
    );
    expect(onSent).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("sends immediately when undo send is off", async () => {
    const send = vi.fn(async () => ({ id: "sent", threadId: "thread" }));
    const schedule = vi.fn(async () => scheduledResult());
    const onSent = vi.fn();
    installApi({ save: vi.fn(), send, schedule });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          to: "sam@example.com",
          initialText: "Hello",
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={onSent}
        onError={vi.fn()}
        undoSendDelaySeconds={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => Promise.resolve());

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello" }));
    expect(schedule).not.toHaveBeenCalled();
    expect(onSent).toHaveBeenCalledWith({ kind: "sent" });
  });

  it("sends from the send-as address chosen in the From field", async () => {
    const send = vi.fn(async () => ({ id: "sent", threadId: "thread" }));
    const sendAs = vi.fn(async () => [
      { email: "me@example.com", name: "Me", isPrimary: true },
      { email: "team@example.com", name: "Team", isPrimary: false },
    ]);
    installApi({ save: vi.fn(), send, sendAs });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          to: "sam@example.com",
          initialHtml: "<p>Hello</p>",
          initialText: "Hello",
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={vi.fn()}
        onError={vi.fn()}
        undoSendDelaySeconds={0}
      />,
    );
    await act(async () => Promise.resolve());

    const from = screen.getByLabelText("From") as HTMLSelectElement;
    expect(sendAs).toHaveBeenCalledWith("account-1");
    expect(from.selectedOptions[0]?.textContent).toBe("Me <me@example.com>");

    fireEvent.change(from, { target: { value: "account-1:team@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => Promise.resolve());

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-1", from: "team@example.com" }),
    );
  });

  it("hides the From field when the only account has one address", async () => {
    installApi({
      save: vi.fn(),
      sendAs: vi.fn(async () => [{ email: "me@example.com", isPrimary: true }]),
    });
    renderDialog();
    await act(async () => Promise.resolve());

    expect(screen.queryByLabelText("From")).toBeNull();
  });

  it("keeps line breaks in a reopened draft sent without edits", async () => {
    const send = vi.fn(async () => ({ id: "sent", threadId: "thread" }));
    installApi({ save: vi.fn(), send });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          draftId: "draft-1",
          to: "sam@example.com",
          initialHtml: "<p>Best,</p><p></p><p>Richard</p>",
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={vi.fn()}
        onError={vi.fn()}
        undoSendDelaySeconds={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => Promise.resolve());

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        html: '<p style="margin: 0px;">Best,</p><p style="margin: 0px;"><br></p><p style="margin: 0px;">Richard</p>',
      }),
    );
  });

  it("uses the selected date for scheduled send", async () => {
    const schedule = vi.fn(async (input) => ({
      ...scheduledResult(),
      sendAt: input.sendAt,
    }));
    const onSent = vi.fn();
    installApi({ save: vi.fn(), schedule });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          to: "friend@example.com",
          initialText: "Later today",
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={onSent}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    fireEvent.change(screen.getByLabelText("Send at"), {
      target: { value: "2026-07-21T09:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await act(async () => Promise.resolve());

    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        sendAt: new Date("2026-07-21T09:30").toISOString(),
      }),
    );
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ kind: "scheduled" }));
  });

  it("saves reply metadata that arrives after an earlier autosave", async () => {
    const pendingThread = deferred<MailThread>();
    const save = vi.fn(async () => ({
      draftId: "draft-1",
      messageId: "draft-message-1",
    }));
    const onClose = vi.fn();
    installApi({ save, getThread: vi.fn(() => pendingThread.promise) });
    render(
      <ComposeDialog
        seed={{ accountId: "account-1", threadId: "thread-1", subject: "Re: Hello" }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={onClose}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Edited reply" },
    });
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ replyToMessageId: undefined, to: [] }),
    );

    await act(async () => pendingThread.resolve(replyThread()));
    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));
    await act(async () => Promise.resolve());

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        draftId: "draft-1",
        replyToMessageId: "message-1",
        to: [{ email: "sender@example.com" }],
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the outbound citation and quoted body when expanding a reply", async () => {
    installApi({ save: vi.fn(), getThread: vi.fn(async () => replyThread()) });
    const { container } = render(
      <ComposeDialog
        seed={{ accountId: "account-1", threadId: "thread-1", subject: "Re: Hello" }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByRole("button", { name: "Show quoted message" }));

    expect(screen.getByText(/^On .+ sender@example\.com wrote:$/)).toBeTruthy();
    expect(container.querySelector(".compose-quoted .quoted-reply-body")?.textContent).toBe(
      "Email body",
    );
  });

  it("quotes the original message instead of the draft when reopening a saved reply", async () => {
    const thread = replyThread();
    thread.messages.push({
      ...thread.messages[0]!,
      id: "draft-message",
      draftId: "draft-1",
      from: { email: "me@example.com" },
      to: [{ email: "sender@example.com" }],
      flags: { read: true, starred: false, draft: true },
    });
    installApi({ save: vi.fn(), getThread: vi.fn(async () => thread) });
    const { container } = render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          draftId: "draft-1",
          threadId: "thread-1",
          replyToMessageId: "message-1",
          subject: "Re: Hello",
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByRole("button", { name: "Show quoted message" }));

    expect(container.querySelector('.compose-quoted [data-message-id="message-1"]')).toBeTruthy();
    expect(container.querySelector('.compose-quoted [data-message-id="draft-message"]')).toBeNull();
  });

  it("confirms before closing an edited forward", () => {
    const onClose = vi.fn();
    const confirmDiscard = vi.spyOn(window, "confirm").mockReturnValue(false);
    installApi({ save: vi.fn() });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          forwardMessageId: "message-1",
          to: "friend@example.com",
          subject: "Fwd: Hello",
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={onClose}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Fwd: Edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));

    expect(confirmDiscard).toHaveBeenCalledWith("Discard this unsent forward?");
    expect(onClose).not.toHaveBeenCalled();

    confirmDiscard.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("forwards a message without requiring a comment", async () => {
    const forward = vi.fn(async () => scheduledResult());
    const onSent = vi.fn();
    installApi({ save: vi.fn(), forward });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          forwardMessageId: "message-1",
          to: "friend@example.com",
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={onSent}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => Promise.resolve());

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-1",
        to: [{ email: "friend@example.com" }],
        text: "",
      }),
    );
    expect(onSent).toHaveBeenCalledOnce();
  });

  it("passes every editable forward field to the desktop bridge", async () => {
    const forward = vi.fn(async () => scheduledResult());
    installApi({ save: vi.fn(), forward });
    render(
      <ComposeDialog
        seed={{
          accountId: "account-1",
          forwardMessageId: "message-1",
          to: "friend@example.com",
          bcc: "archive@example.com",
          subject: "Custom subject",
          initialText: "Formatted note",
          initialHtml: "<p><strong>Formatted note</strong></p>",
          initialAttachments: [
            {
              token: "attachment-token",
              filename: "notes.pdf",
              mimeType: "application/pdf",
              sizeBytes: 128,
            },
          ],
        }}
        accounts={[
          {
            id: "account-1",
            email: "me@example.com",
            provider: "gmail",
            status: "active",
          },
        ]}
        onClose={vi.fn()}
        onSent={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => Promise.resolve());

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        bcc: [{ email: "archive@example.com" }],
        subject: "Custom subject",
        text: "Formatted note",
        html: '<p style="margin: 0px;"><strong>Formatted note</strong></p>',
        attachments: [expect.objectContaining({ token: "attachment-token" })],
        includeAttachments: false,
      }),
    );
  });
});

function renderEmptyDialog({
  onClose = vi.fn(),
  onError = vi.fn(),
}: {
  onClose?: () => void;
  onError?: (message: string) => void;
} = {}): void {
  render(
    <ComposeDialog
      seed={{ accountId: "account-1" }}
      accounts={[
        {
          id: "account-1",
          email: "me@example.com",
          provider: "gmail",
          status: "active",
        },
      ]}
      onClose={onClose}
      onSent={vi.fn()}
      onError={onError}
    />,
  );
}

function renderDialog(onClose = vi.fn()): void {
  render(
    <ComposeDialog
      seed={{
        accountId: "account-1",
        initialHtml: "<p>Initial body</p>",
        initialText: "Initial body",
      }}
      accounts={[
        {
          id: "account-1",
          email: "me@example.com",
          provider: "gmail",
          status: "active",
        },
      ]}
      onClose={onClose}
      onSent={vi.fn()}
      onError={vi.fn()}
    />,
  );
}

function installApi(input: {
  save: ReturnType<typeof vi.fn>;
  send?: ReturnType<typeof vi.fn>;
  schedule?: ReturnType<typeof vi.fn>;
  deleteDraft?: ReturnType<typeof vi.fn>;
  release?: ReturnType<typeof vi.fn>;
  forward?: ReturnType<typeof vi.fn>;
  getThread?: ReturnType<typeof vi.fn>;
  sendAs?: ReturnType<typeof vi.fn>;
}): void {
  const api = {
    accounts: { sendAs: input.sendAs ?? vi.fn(async () => []) },
    drafts: {
      save: input.save,
      delete: input.deleteDraft ?? vi.fn(async () => undefined),
      send: input.send ?? vi.fn(async () => ({ id: "sent", threadId: "thread" })),
      schedule: input.schedule ?? vi.fn(async () => scheduledResult()),
    },
    attachments: { release: input.release ?? vi.fn(async () => undefined) },
    mail: {
      forward: input.forward ?? vi.fn(async () => scheduledResult()),
      getThread: input.getThread ?? vi.fn(),
    },
    analytics: { trackFeature: vi.fn(async () => undefined) },
  } as unknown as FluxmailDesktopApi;
  Object.defineProperty(window, "fluxmail", { configurable: true, value: api });
}

function scheduledResult() {
  return {
    scheduleId: "schedule-1",
    draftId: "draft-1",
    sendAt: "2026-07-20T18:00:10.000Z",
  };
}

function replyThread(): MailThread {
  return {
    id: "thread-1",
    accountId: "account-1",
    accountEmail: "me@example.com",
    subject: "Hello",
    messages: [
      {
        id: "message-1",
        threadId: "thread-1",
        accountId: "account-1",
        from: { email: "sender@example.com" },
        to: [{ email: "me@example.com" }],
        subject: "Hello",
        date: "2026-07-16T12:00:00Z",
        flags: { read: true, starred: false, draft: false },
      },
    ],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
