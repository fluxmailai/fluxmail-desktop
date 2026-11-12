/** @vitest-environment jsdom */
import type { Message } from "@fluxmail/core";
import { describe, expect, it } from "vitest";
import { buildQuotedReplyBody, containsQuotedReply } from "../src/main/quoted-reply";
import {
  attachmentsWithoutQuotedInline,
  quotedReplyTarget,
  replyWithoutQuotedHtml,
} from "../src/renderer/email/quoted-reply";
import { replyWithoutQuotedText } from "../src/shared/quoted-reply";
import type { ComposeAttachment, MailMessage } from "../src/shared/contracts";

const original: Message = {
  id: "original",
  threadId: "thread-1",
  accountId: "account-1",
  from: { name: "PayPal", email: "service@paypal.com" },
  to: [{ email: "me@example.com" }],
  subject: "Receipt",
  date: "2026-08-17T18:03:00Z",
  snippet: "Payment details are inside.",
  body: {
    text: "Payment details are inside.",
    html:
      '<table style="width:100%"><tr><td><b>Hello, Richard Chu</b></td></tr>' +
      '<tr><td><img src="cid:logo@paypal"></td></tr></table>',
  },
  flags: { read: true, starred: false, draft: false },
};

describe("reopening a saved reply", () => {
  it("removes the quoted history the composer cannot round-trip", () => {
    const draft = buildQuotedReplyBody({ html: "<p>test</p>", text: "test" }, original);

    const html = replyWithoutQuotedHtml(draft.html!);

    expect(html.quoted).toBe(true);
    expect(html.html).toBe("<p>test</p>");
    expect(replyWithoutQuotedText(draft.text!)).toEqual({ text: "test", quoted: true });
    expect(
      containsQuotedReply({ html: html.html, text: replyWithoutQuotedText(draft.text!).text }),
    ).toBe(false);
  });

  it("restores the original formatting when the reply is sent again", () => {
    const draft = buildQuotedReplyBody({ html: "<p>test</p>" }, original);
    const reopened = replyWithoutQuotedHtml(draft.html!);

    expect(buildQuotedReplyBody({ html: reopened.html }, original).html).toBe(draft.html);
  });

  it("keeps replies that carry no quoted history untouched", () => {
    const html = "<p>test</p><blockquote>Something <b>I</b> quoted myself</blockquote>";

    expect(replyWithoutQuotedHtml(html)).toEqual({ html, quoted: false });
    expect(replyWithoutQuotedText("test\n\nSomething I quoted myself")).toEqual({
      text: "test\n\nSomething I quoted myself",
      quoted: false,
    });
  });

  it("removes an attribution line left in front of a bare quote", () => {
    const html =
      "<div>test</div><div>On Mon, Aug 17, 2026 at 11:03 AM PayPal &lt;service@paypal.com&gt; wrote:</div>" +
      "<blockquote><p>Payment details are inside.</p></blockquote>";

    expect(replyWithoutQuotedHtml(html)).toEqual({ html: "<div>test</div>", quoted: true });
  });

  it("removes quoted history that lost its markup in an earlier editor round trip", () => {
    const html =
      "<p>test</p><p>On Mon, Aug 17, 2026 at 11:03 AM PayPal &lt;service@paypal.com&gt; wrote:</p>" +
      "<p>Payment details are inside.</p><p><strong>Hello, Richard Chu</strong></p>";

    expect(replyWithoutQuotedHtml(html)).toEqual({ html: "<p>test</p>", quoted: true });
    expect(
      replyWithoutQuotedText(
        "test\nOn Mon, Aug 17, 2026 at 11:03 AM PayPal wrote:\nPayment details are inside.",
      ).text,
    ).toBe("test");
  });

  it("keeps a trailing attribution that introduces nothing", () => {
    const html = "<p>test</p><p>On Monday Sam wrote:</p>";

    expect(replyWithoutQuotedHtml(html)).toEqual({ html, quoted: false });
  });

  it("removes quoted history nested beside the reply", () => {
    const html =
      '<div dir="ltr"><div>test</div><div class="gmail_quote"><blockquote>Quoted</blockquote></div>' +
      "</div><div>Trailing</div>";

    expect(replyWithoutQuotedHtml(html).html).toBe('<div dir="ltr"><div>test</div></div>');
  });

  it("cuts plain-text replies at the quoted history", () => {
    const text = "test\n\nOn Mon, Aug 17, 2026 PayPal wrote:\n> Payment details are inside.\n>";

    expect(replyWithoutQuotedText(text).text).toBe("test");
    expect(
      replyWithoutQuotedText("test\n\n----- Original Message -----\nPayment details").text,
    ).toBe("test");
  });

  it("finds the message a draft quotes, ignoring newer replies", () => {
    const newer: MailMessage = {
      ...(original as unknown as MailMessage),
      id: "newer",
      from: { name: "Valve", email: "support@valve.test" },
      date: "2026-08-18T09:00:00Z",
    };
    const draft = buildQuotedReplyBody({ html: "<p>test</p>", text: "test" }, original);

    expect(quotedReplyTarget(draft, [newer, original as unknown as MailMessage])?.id).toBe(
      "original",
    );
    expect(quotedReplyTarget(draft, [newer])).toBeUndefined();
    expect(quotedReplyTarget({ html: "<p>test</p>" }, [newer])).toBeUndefined();
  });

  it("drops inline attachments that only the quoted history referenced", () => {
    const attachments: ComposeAttachment[] = [
      {
        token: "quoted-logo",
        filename: "logo.png",
        mimeType: "image/png",
        sizeBytes: 100,
        contentId: "<logo@paypal>",
        disposition: "inline",
      },
      {
        token: "my-image",
        filename: "chart.png",
        mimeType: "image/png",
        sizeBytes: 200,
        contentId: "chart@fluxmail",
        disposition: "inline",
      },
      { token: "file", filename: "notes.pdf", mimeType: "application/pdf", sizeBytes: 300 },
    ];

    const kept = attachmentsWithoutQuotedInline(
      attachments,
      '<p>test <img src="cid:chart@fluxmail"></p>',
    );

    expect(kept.map((attachment) => attachment.token)).toEqual(["my-image", "file"]);
  });
});

describe("replyWithoutQuotedHtml separators", () => {
  it("drops a blockquote introduced by an Original Message separator", () => {
    expect(
      replyWithoutQuotedHtml(
        "<p>Reply</p><p>-----Original Message-----</p><blockquote>Earlier</blockquote>",
      ),
    ).toEqual({ html: "<p>Reply</p>", quoted: true });
  });
});
