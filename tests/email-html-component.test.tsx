/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailHtml } from "../src/renderer/components/EmailHtml";
import type { FluxmailDesktopApi, MailMessage } from "../src/shared/contracts";

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EmailHtml remote image consent", () => {
  it("blocks images again when the component is reused for another message", () => {
    installApi(vi.fn(async () => ({})));
    const { container, rerender } = render(
      <EmailHtml message={message("first")} imageRelay={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load remote images" }));
    expect(frameSource(container)).toContain('src="https://images.example/first.png"');

    rerender(<EmailHtml message={message("second")} imageRelay={false} />);

    expect(frameSource(container)).toContain('data-remote-src="https://images.example/second.png"');
    expect(frameDocument(container).querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(frameSource(container)).toContain("img-src data: blob:;");
  });

  it("ignores a relay response that belongs to the previous message", async () => {
    let resolveProxy!: (urls: Record<string, string>) => void;
    const proxy = vi.fn(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveProxy = resolve;
        }),
    );
    installApi(proxy);
    const onError = vi.fn();
    const { container, rerender } = render(
      <EmailHtml message={message("first")} imageRelay onError={onError} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load remote images" }));

    rerender(<EmailHtml message={message("second")} imageRelay onError={onError} />);
    await act(async () => {
      resolveProxy({
        "https://images.example/first.png":
          "https://cdn.fluxmail.workers.dev/?url=first&exp=2000000000&sig=test",
      });
      await Promise.resolve();
    });

    expect(
      (screen.getByRole("button", { name: "Load remote images" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(frameSource(container)).toContain('data-remote-src="https://images.example/second.png"');
    expect(frameSource(container)).not.toContain("cdn.fluxmail.workers.dev");
    expect(onError).not.toHaveBeenCalled();
  });

  it("uses the relay when automatic image loading is enabled", async () => {
    const proxied = "https://cdn.fluxmail.workers.dev/?url=first&exp=2000000000&sig=test";
    const proxy = vi.fn(async () => ({ "https://images.example/first.png": proxied }));
    installApi(proxy);
    const { container } = render(
      <EmailHtml message={message("first")} blockRemoteImages={false} imageRelay />,
    );

    await waitFor(() =>
      expect(frameDocument(container).querySelector("img")?.getAttribute("src")).toBe(proxied),
    );
    expect(frameSource(container)).not.toContain("images.example");
    expect(proxy).toHaveBeenCalledWith(["https://images.example/first.png"]);
  });

  it("does not request tracking pixels or image tracking parameters through the relay", async () => {
    const image = "https://images.example/photo.png?size=large";
    const proxied = "https://cdn.fluxmail.workers.dev/?url=photo&exp=2000000000&sig=test";
    const proxy = vi.fn(async () => ({ [image]: proxied }));
    installApi(proxy);
    const { container } = render(
      <EmailHtml
        message={{
          ...message("tracked"),
          body: {
            html: `<img src="https://t.yesware.com/t/open.gif">
              <img src="${image}&utm_source=email&mc_eid=recipient" width="600" height="400">`,
          },
        }}
        blockRemoteImages={false}
        imageRelay
      />,
    );

    await waitFor(() => expect(proxy).toHaveBeenCalledWith([image]));
    expect(frameDocument(container).querySelector("img")?.getAttribute("src")).toBe(proxied);
    expect(frameSource(container)).not.toContain("t.yesware.com");
    expect(frameSource(container)).not.toContain("utm_source");
    expect(frameSource(container)).not.toContain("mc_eid");
  });

  it("splits large image sets into valid relay requests", async () => {
    const urls = Array.from({ length: 201 }, (_, index) => `https://images.example/${index}.png`);
    const proxy = vi.fn(async (batch: string[]) =>
      Object.fromEntries(
        batch.map((url, index) => [
          url,
          `https://cdn.fluxmail.workers.dev/${encodeURIComponent(url)}-${index}.png`,
        ]),
      ),
    );
    installApi(proxy);
    const { container } = render(
      <EmailHtml
        message={{
          ...message("large"),
          body: { html: urls.map((url) => `<img src="${url}">`).join("") },
        }}
        blockRemoteImages={false}
        imageRelay
      />,
    );

    await waitFor(() => expect(proxy).toHaveBeenCalledTimes(2));
    expect(proxy.mock.calls.map(([batch]) => batch.length)).toEqual([200, 1]);
    await waitFor(() =>
      expect(frameDocument(container).querySelectorAll("img[src]")).toHaveLength(201),
    );
  });

  it("does not fall back to direct loading when the relay is unavailable", () => {
    const proxy = vi.fn(async () => ({}));
    installApi(proxy);
    const { container } = render(
      <EmailHtml
        message={message("first")}
        blockRemoteImages={false}
        imageRelay
        imageRelayAvailable={false}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Image relay unavailable" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(frameDocument(container).querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(frameSource(container)).toContain('data-remote-src="https://images.example/first.png"');
    expect(proxy).not.toHaveBeenCalled();
  });

  it("skips the relay for messages without remote images", async () => {
    const proxy = vi.fn(async () => ({}));
    installApi(proxy);
    const onError = vi.fn();
    render(
      <EmailHtml
        message={{ ...message("plain"), body: { text: "No remote images" } }}
        blockRemoteImages={false}
        imageRelay
        onError={onError}
      />,
    );

    await waitFor(() => expect(onError).not.toHaveBeenCalled());
    expect(proxy).not.toHaveBeenCalled();
  });
});

describe("EmailHtml links", () => {
  it("hands mailto links to Fluxmail and opens web links externally", () => {
    installApi(vi.fn(async () => ({})));
    const onMailto = vi.fn();
    const { container } = render(
      <EmailHtml
        message={{
          ...message("links"),
          body: {
            html: '<a href="mailto:sales@example.com?subject=Hi">Mail</a><a href="https://example.com/">Web</a>',
          },
        }}
        onMailto={onMailto}
      />,
    );
    const frame = container.querySelector("iframe")!;
    frame.contentDocument!.body.innerHTML = frameDocument(container).body.innerHTML;
    fireEvent.load(frame);
    const [mailLink, webLink] = frame.contentDocument!.querySelectorAll("a");

    fireEvent.click(mailLink);
    expect(onMailto).toHaveBeenCalledWith(
      expect.objectContaining({ to: "sales@example.com", subject: "Hi" }),
    );
    expect(window.fluxmail.system.openExternal).not.toHaveBeenCalled();

    fireEvent.click(webLink);
    expect(window.fluxmail.system.openExternal).toHaveBeenCalledWith("https://example.com/");
  });
});

describe("EmailHtml quoted history", () => {
  const reply = {
    html: '<p>Thursday works.</p><div class="gmail_quote"><div class="gmail_attr">On Tue, Nov 10, 2026, Maya wrote:</div><blockquote>Can we move it?</blockquote></div>',
  };

  function Collapsing(props: Parameters<typeof EmailHtml>[0]) {
    return <EmailHtml collapseQuotedHistory {...props} />;
  }

  function loadFrame(container: HTMLElement): Document {
    const frame = container.querySelector("iframe")!;
    frame.contentDocument!.body.innerHTML = frameDocument(container).body.innerHTML;
    fireEvent.load(frame);
    return frame.contentDocument!;
  }

  it("collapses the quote until it is shown, then keeps it open", () => {
    installApi(vi.fn(async () => ({})));
    const { container } = render(<Collapsing message={{ ...message("reply"), body: reply }} />);
    const document = loadFrame(container);
    const root = document.getElementById("email-root")!;
    expect(frameSource(container)).toContain(
      "#email-root:not([data-fluxmail-show-quoted]) [data-fluxmail-quoted]{display:none!important}",
    );
    expect(document.querySelector(".gmail_quote")!.hasAttribute("data-fluxmail-quoted")).toBe(true);
    expect(root.hasAttribute("data-fluxmail-show-quoted")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Show quoted text" }));
    expect(root.hasAttribute("data-fluxmail-show-quoted")).toBe(true);
    expect(screen.queryByRole("button", { name: /quoted text/ })).toBeNull();
    expect(window.document.activeElement).toBe(container.querySelector("iframe"));
  });

  it("collapses the quote again for another message", () => {
    installApi(vi.fn(async () => ({})));
    const { rerender } = render(<Collapsing message={{ ...message("reply"), body: reply }} />);
    fireEvent.click(screen.getByRole("button", { name: "Show quoted text" }));

    rerender(<Collapsing message={{ ...message("reply-2"), body: reply }} />);
    expect(screen.getByRole("button", { name: "Show quoted text" })).toBeTruthy();
  });

  it("shows the quote while finding in the conversation", () => {
    installApi(vi.fn(async () => ({})));
    const { container, rerender } = render(
      <Collapsing message={{ ...message("reply"), body: reply }} />,
    );
    const root = loadFrame(container).getElementById("email-root")!;

    rerender(<Collapsing message={{ ...message("reply"), body: reply }} findQuery="works" />);
    expect(root.hasAttribute("data-fluxmail-show-quoted")).toBe(true);
    expect(screen.queryByRole("button", { name: /quoted text/ })).toBeNull();

    rerender(<Collapsing message={{ ...message("reply"), body: reply }} />);
    expect(root.hasAttribute("data-fluxmail-show-quoted")).toBe(false);
    expect(screen.getByRole("button", { name: "Show quoted text" })).toBeTruthy();
  });

  it("keeps a quote open after find steps to a match inside it", () => {
    installApi(vi.fn(async () => ({})));
    const { container, rerender } = render(
      <Collapsing message={{ ...message("reply"), body: reply }} />,
    );
    const root = loadFrame(container).getElementById("email-root")!;

    rerender(
      <Collapsing
        message={{ ...message("reply"), body: reply }}
        findQuery="move"
        activeFindMatch={0}
      />,
    );
    rerender(<Collapsing message={{ ...message("reply"), body: reply }} />);

    expect(root.hasAttribute("data-fluxmail-show-quoted")).toBe(true);
    expect(screen.queryByRole("button", { name: /quoted text/ })).toBeNull();
  });

  it("collapses the quote in a plain-text reply", () => {
    installApi(vi.fn(async () => ({})));
    const { container } = render(
      <Collapsing
        message={{
          ...message("plain"),
          body: { text: "Booked.\n\nOn Tue, Nov 10, 2026, Sam wrote:\n> Sounds good.\n\nSam" },
        }}
      />,
    );
    const document = frameDocument(container);
    expect(document.querySelector("[data-fluxmail-quoted]")?.textContent).toBe(
      "\nOn Tue, Nov 10, 2026, Sam wrote:\n> Sounds good.",
    );
    expect(document.getElementById("email-root")!.lastElementChild!.textContent).toBe("\nSam");
    expect(screen.getByRole("button", { name: "Show quoted text" })).toBeTruthy();
  });

  it("starts a bottom-posted plain-text reply with the answer", () => {
    installApi(vi.fn(async () => ({})));
    const { container } = render(
      <Collapsing
        message={{
          ...message("plain"),
          body: { text: "On Tue, Nov 10, 2026 Sam wrote:\n> Does Thursday work?\n\nYes." },
        }}
      />,
    );
    const root = frameDocument(container).getElementById("email-root")!;
    expect(root.children).toHaveLength(2);
    expect(root.lastElementChild!.textContent).toBe("Yes.");
  });

  it("leaves forwarded messages, messages without a quote, and previews open", () => {
    installApi(vi.fn(async () => ({})));
    const { container, rerender } = render(
      <Collapsing message={{ ...message("Fwd: Plans"), body: reply }} />,
    );
    expect(frameSource(container)).not.toContain("data-fluxmail-quoted=");
    expect(screen.queryByRole("button", { name: "Show quoted text" })).toBeNull();

    rerender(<Collapsing message={{ ...message("plain"), body: { text: "Just a note." } }} />);
    expect(screen.queryByRole("button", { name: "Show quoted text" })).toBeNull();

    // The composer previews the message being answered in full.
    rerender(<EmailHtml message={{ ...message("reply"), body: reply }} />);
    expect(frameSource(container)).not.toContain("data-fluxmail-quoted=");
    expect(screen.queryByRole("button", { name: "Show quoted text" })).toBeNull();
  });
});

function installApi(proxy: FluxmailDesktopApi["images"]["proxy"]): void {
  Object.defineProperty(window, "fluxmail", {
    configurable: true,
    value: {
      attachments: { inlineData: vi.fn() },
      images: { proxy },
      system: { openExternal: vi.fn(async () => undefined) },
    } as unknown as FluxmailDesktopApi,
  });
}

function message(id: string): MailMessage {
  return {
    id,
    threadId: "thread-1",
    accountId: "account-1",
    to: [{ email: "me@example.com" }],
    subject: id,
    date: "2026-07-18T12:00:00Z",
    body: { html: `<img src="https://images.example/${id}.png">` },
    flags: { read: true, starred: false, draft: false },
  };
}

function frameSource(container: HTMLElement): string {
  return container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

function frameDocument(container: HTMLElement): Document {
  return new DOMParser().parseFromString(frameSource(container), "text/html");
}
