/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { buildDemoMessages } from "../src/main/demo-fixtures";
import { buildEmailDocument } from "../src/renderer/components/EmailHtml";
import {
  isForwardedSubject,
  isReplySubject,
  markQuotedHistory,
  QUOTED_HISTORY_ATTRIBUTE,
  splitQuotedText,
} from "../src/renderer/email/quoted-reply";

function mark(html: string): {
  marked: boolean;
  visible: string;
  hidden: string;
  document: Document;
} {
  const document = new DOMParser().parseFromString(html, "text/html");
  const marked = markQuotedHistory(document.body);
  const hidden = [...document.body.querySelectorAll(`[${QUOTED_HISTORY_ATTRIBUTE}]`)]
    .filter((element) => !element.parentElement?.closest(`[${QUOTED_HISTORY_ATTRIBUTE}]`))
    .map((element) => element.textContent)
    .filter(Boolean)
    .join("|");
  const visible = document.body.cloneNode(true) as HTMLElement;
  for (const element of visible.querySelectorAll(`[${QUOTED_HISTORY_ATTRIBUTE}]`)) element.remove();
  return { marked, visible: visible.textContent!.trim(), hidden, document };
}

describe("markQuotedHistory", () => {
  it("hides a Gmail quote and the line break before it", () => {
    const result = mark(
      '<div dir="ltr">Thursday works.</div><br><div class="gmail_quote"><div class="gmail_attr">On Tue, Nov 10, 2026 at 9:14 AM Maya &lt;maya@example.com&gt; wrote:<br></div><blockquote class="gmail_quote">Could we move it?</blockquote></div>',
    );
    expect(result.marked).toBe(true);
    expect(result.visible).toBe("Thursday works.");
    expect(result.hidden).toContain("Could we move it?");
  });

  it("keeps a signature or list footer after the quote visible", () => {
    const result = mark(
      '<div>Thursday works.</div><div class="gmail_quote"><blockquote>Could we move it?</blockquote></div><span class="gmail_signature_prefix">-- </span><div class="gmail_signature">Sam Lee</div><p>You received this because you joined the list.</p>',
    );
    expect(result.marked).toBe(true);
    expect(result.hidden).toBe("Could we move it?");
    expect(result.visible).toBe(
      "Thursday works.-- Sam LeeYou received this because you joined the list.",
    );
  });

  it("keeps a bottom-posted answer visible", () => {
    const result = mark(
      '<div>Hi Maya,</div><div class="yahoo_quoted"><div>On Tuesday, November 10, 2026, Maya wrote:</div><div>Does Thursday work?</div></div><div>Yes, Thursday works.</div>',
    );
    expect(result.marked).toBe(true);
    expect(result.visible).toBe("Hi Maya,Yes, Thursday works.");
    const quoteFirst = mark(
      '<blockquote type="cite"><div>On Nov 10, 2026, at 9:14 AM, Maya wrote:</div><div>Does Thursday work?</div></blockquote><div>Yes, Thursday works.</div>',
    );
    expect(quoteFirst.marked).toBe(true);
    expect(quoteFirst.visible).toBe("Yes, Thursday works.");
  });

  it("hides an Outlook reply header, its separator, and everything after it", () => {
    const result = mark(
      '<div>Sounds good.<div><br></div><hr><div id="divRplyFwdMsg"><b>From:</b> John</div>loose quoted text</div><div>Thursday works.</div>',
    );
    expect(result.marked).toBe(true);
    expect(result.visible).toBe("Sounds good.");
    expect(result.hidden).toBe("From: John|loose quoted text|Thursday works.");
  });

  it("hides a Thunderbird quote with its attribution", () => {
    const result = mark(
      '<p>Reply</p><div class="moz-cite-prefix">On 11/9/26 4:02 PM, Sam wrote:<br></div><blockquote type="cite">Earlier</blockquote>',
    );
    expect(result.marked).toBe(true);
    expect(result.visible).toBe("Reply");
    expect(result.hidden).toBe("On 11/9/26 4:02 PM, Sam wrote:|Earlier");
  });

  it("hides an unmarked blockquote that a dated attribution introduces", () => {
    const result = mark(
      "<p>Reply</p><p>On Mon, Nov 9, 2026, Sam wrote:</p><blockquote>Earlier</blockquote>",
    );
    expect(result.marked).toBe(true);
    expect(result.visible).toBe("Reply");
    expect(result.hidden).toBe("On Mon, Nov 9, 2026, Sam wrote:|Earlier");
  });

  it("keeps prose that reads like an attribution", () => {
    expect(
      mark(
        "<p>Welcome to the weekly digest.</p><p>On the future of work, Paul Graham wrote:</p><p><i>Do things that do not scale.</i></p><p>Now the rest of the newsletter.</p>",
      ).marked,
    ).toBe(false);
    expect(
      mark(
        "<div><div>On Monday I spoke with John.</div><div>He later wrote:</div></div><p>Please review the contract by Friday.</p>",
      ).marked,
    ).toBe(false);
    expect(
      mark(
        "<p>On pricing, Paul Graham wrote:</p><blockquote>Charge more.</blockquote><p>More below.</p>",
      ).marked,
    ).toBe(false);
  });

  it("keeps blockquotes the sender wrote without an attribution", () => {
    expect(mark("<p>As the docs say:</p><blockquote>Read the manual.</blockquote>").marked).toBe(
      false,
    );
  });

  it("leaves a message that is only a quote alone", () => {
    expect(
      mark('<div class="gmail_quote"><blockquote>Only the quote</blockquote></div>').marked,
    ).toBe(false);
  });

  it("collapses a quote after an image-only reply", () => {
    const result = mark(
      '<img src="data:image/png;base64,AA=="><div class="gmail_quote"><blockquote>Earlier</blockquote></div>',
    );
    expect(result.marked).toBe(true);
  });

  it("leaves forwarded messages open", () => {
    expect(
      mark(
        '<div>FYI</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Maya</div><div>Details</div></div>',
      ).marked,
    ).toBe(false);
    expect(
      mark(
        '<div>Begin forwarded message:</div><br><blockquote type="cite"><div>From: Maya</div><div>Details</div></blockquote>',
      ).marked,
    ).toBe(false);
  });

  it("leaves inline answers between quoted passages open", () => {
    expect(
      mark(
        '<div>See below.</div><div class="gmail_quote"><blockquote>Question one?</blockquote><div>Answer one.</div><blockquote>Question two?</blockquote></div>',
      ).marked,
    ).toBe(false);
  });

  it("keeps an answer written inside the quote container", () => {
    const result = mark(
      '<div>Hi Maya,</div><div class="gmail_quote"><div class="gmail_attr">On Tue, Nov 10, 2026, Maya wrote:</div><blockquote>Does Thursday work?</blockquote><div>Yes, Thursday works for me.</div></div><div>-- You received this from the list.</div>',
    );
    expect(result.marked).toBe(true);
    expect(result.hidden).toBe("On Tue, Nov 10, 2026, Maya wrote:|Does Thursday work?");
    expect(result.visible).toBe(
      "Hi Maya,Yes, Thursday works for me.-- You received this from the list.",
    );
  });

  it("ends a quote without text at its marker", () => {
    const result = mark(
      '<div>Nice!</div><div>On Nov 9, 2026, at 4:02 PM, Sam wrote:</div><blockquote type="cite"><img src="cid:a"></blockquote><div>Where was this taken?</div>',
    );
    expect(result.marked).toBe(true);
    expect(result.visible).toBe("Nice!Where was this taken?");
  });

  it("hides media after the quote's last line with it", () => {
    const result = mark(
      '<p>Thanks</p><div class="gmail_quote"><div class="gmail_attr">On Tue, Nov 10, 2026, Sam wrote:</div><blockquote><div>Hi</div><div>Sam</div><img src="cid:logo"></blockquote></div>',
    );
    expect(result.marked).toBe(true);
    expect(result.visible).toBe("Thanks");
    expect(
      result.document.querySelector("img")!.closest(`[${QUOTED_HISTORY_ATTRIBUTE}]`),
    ).not.toBeNull();
  });

  it("keeps a passage quoted with quote formatting and no attribution", () => {
    for (const quote of ['<blockquote class="gmail_quote">', '<blockquote type="cite">'])
      expect(
        mark(`<div>Look:</div>${quote}The spec says X.</blockquote><div>My thoughts follow.</div>`)
          .marked,
      ).toBe(false);
    expect(
      mark(
        '<div>Danke!</div><blockquote type="cite"><div>Am 10.11.2026 um 09:14 schrieb Maya &lt;maya@example.com&gt;:</div><div>Passt Donnerstag?</div></blockquote>',
      ).marked,
    ).toBe(true);
  });

  it("keeps a mid-sentence attribution and its quote", () => {
    expect(
      mark(
        "<p>Hello team,</p><p>Based on the Q3 numbers, here is what Dana wrote:</p><blockquote>Revenue is up 12%.</blockquote><p>So we should celebrate.</p>",
      ).marked,
    ).toBe(false);
  });

  it("finds an attribution separated from its quote by padding", () => {
    expect(
      mark(
        `<p>Reply</p><p>On Mon, Nov 9, 2026, Sam wrote:</p>${" ".repeat(1200)}<blockquote>Earlier</blockquote>`,
      ).marked,
    ).toBe(true);
  });

  it("leaves a quote with only a spacer image before it alone", () => {
    expect(
      mark(
        '<img src="https://x.example/spacer.gif" width="1" height="1"><div class="gmail_quote"><blockquote>Only the quote</blockquote></div>',
      ).marked,
    ).toBe(false);
  });

  // The sizes make a quadratic search take minutes, so the generous limit only catches that.
  it("stays fast on a long run of dashes", () => {
    const started = performance.now();
    mark(
      `<p>Reply ${"-".repeat(200_000)}</p><div class="gmail_quote"><blockquote>Q</blockquote></div>`,
    );
    mark(`<p>${"-".repeat(200_000)}</p>${"<blockquote>Q</blockquote>".repeat(200)}`);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("finds the quote in a long message with many blockquotes quickly", () => {
    const paragraphs = Array.from(
      { length: 5000 },
      (_, index) => `<p>On item ${index} the team said</p><blockquote>Point ${index}</blockquote>`,
    ).join("");
    const started = performance.now();
    expect(mark(`<p>Reply</p>${paragraphs}`).marked).toBe(false);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("buildEmailDocument quote markers", () => {
  it("strips quote markers a sender put in the message", () => {
    for (const collapse of [true, false]) {
      const document = buildEmailDocument(
        `<p>Hello</p><p ${QUOTED_HISTORY_ATTRIBUTE}>Hidden by sender</p>`,
        {},
        false,
        false,
        undefined,
        collapse,
      );
      expect(document).not.toContain(`${QUOTED_HISTORY_ATTRIBUTE}=`);
    }
  });
});

describe("splitQuotedText", () => {
  it("splits a Gmail plain-text reply at the attribution", () => {
    expect(
      splitQuotedText(
        "Booked room 4B.\r\n\r\nOn Tue, Nov 10, 2026 at 10:30 AM Sam <sam@example.com> wrote:\r\n> Sounds good.\r\n>\r\n",
      ),
    ).toEqual({
      body: "Booked room 4B.",
      quoted: "On Tue, Nov 10, 2026 at 10:30 AM Sam <sam@example.com> wrote:\n> Sounds good.\n>",
      after: "",
    });
  });

  it("keeps a sentence of the sender's above a one-line attribution", () => {
    expect(
      splitQuotedText("On Monday the team met.\nOn Tue, Nov 10, 2026, Sam wrote:\n> Notes?")?.body,
    ).toBe("On Monday the team met.");
  });

  it("keeps a bottom-posted answer and its indentation", () => {
    expect(
      splitQuotedText("On Tue, Nov 10, 2026 Sam wrote:\n> Does Thursday work?\n\n  Yes.\n"),
    ).toEqual({
      body: "",
      quoted: "On Tue, Nov 10, 2026 Sam wrote:\n> Does Thursday work?",
      after: "  Yes.",
    });
  });

  it("keeps a signature after the quote", () => {
    expect(
      splitQuotedText("Thanks!\n\nOn Tue, Nov 10, 2026, Sam wrote:\n> Sounds good.\n\n-- \nMaya"),
    ).toEqual({
      body: "Thanks!",
      quoted: "On Tue, Nov 10, 2026, Sam wrote:\n> Sounds good.",
      after: "-- \nMaya",
    });
  });

  it("joins an attribution wrapped across two lines", () => {
    expect(
      splitQuotedText(
        "Thanks!\n\nOn Tue, Nov 10, 2026 at 10:30 AM Sam Lee <\nsam@example.com> wrote:\n\n> Sounds good.",
      )?.body,
    ).toBe("Thanks!");
  });

  it("splits at an Outlook separator", () => {
    expect(
      splitQuotedText("Done.\n\n-----Original Message-----\nFrom: Sam\nSent: Tuesday\n\nHello")
        ?.body,
    ).toBe("Done.");
    expect(
      splitQuotedText("Done.\n\n________________________________\nFrom: Sam\nSent: Tuesday")?.body,
    ).toBe("Done.");
  });

  it("splits a run of quoted lines without an attribution only in a reply", () => {
    const text = "Agreed.\n\n> We should ship.\n> \n> Today?\n";
    expect(splitQuotedText(text, { reply: true })).toEqual({
      body: "Agreed.",
      quoted: "> We should ship.\n> \n> Today?",
      after: "",
    });
    expect(splitQuotedText("Run this to fix it:\n\n> npm install\n> npm test\n")).toBeUndefined();
    expect(
      splitQuotedText("Run this to fix it:\n\n> npm install\n> npm test\n\nThen restart.", {
        reply: true,
      }),
    ).toBeUndefined();
    expect(
      splitQuotedText("Sounds good.\n\n> On Nov 10, 2026, at 8:47 AM, John wrote:\n>\n> Hi Sam")
        ?.body,
    ).toBe("Sounds good.");
  });

  it("keeps text the sender wrote between quoted lines", () => {
    expect(
      splitQuotedText("On Tue, Sam wrote:\n> Question one?\nAnswer one.\n> Question two?"),
    ).toBeUndefined();
    expect(
      splitQuotedText("Hi\n> Question one?\nAnswer one.\n> Question two?", { reply: true }),
    ).toBeUndefined();
  });

  it("does not split a message that is only a quote, or has none", () => {
    expect(splitQuotedText("> Only quoted", { reply: true })).toBeUndefined();
    expect(splitQuotedText("On Monday we wrote: the plan.\nSee you.")).toBeUndefined();
    expect(
      splitQuotedText("On pricing, Paul wrote:\n> Charge more.\n\nI agree with him."),
    ).toBeUndefined();
  });
});

describe("subject prefixes", () => {
  it("recognizes forwarded subjects", () => {
    expect(isForwardedSubject("Fwd: Plans")).toBe(true);
    expect(isForwardedSubject("FW: Plans")).toBe(true);
    expect(isForwardedSubject("WG: Pläne")).toBe(true);
    expect(isForwardedSubject("[EXT] FW: Plans")).toBe(true);
    expect(isForwardedSubject("VB: Planer")).toBe(true);
    expect(isForwardedSubject("转发：计划")).toBe(true);
    expect(isForwardedSubject("Re: Fwd: Plans")).toBe(false);
    expect(isForwardedSubject(undefined)).toBe(false);
  });

  it("recognizes reply subjects", () => {
    expect(isReplySubject("Re: Plans")).toBe(true);
    expect(isReplySubject("AW: Pläne")).toBe(true);
    expect(isReplySubject("[EXT] RE: Plans")).toBe(true);
    expect(isReplySubject("Regarding plans")).toBe(false);
  });
});

describe("demo fixture replies", () => {
  const messages = buildDemoMessages(new Date(2026, 6, 20, 12, 0, 0));
  const replies = messages.filter((message) => message.headers?.["In-Reply-To"]);

  it("quote the message they answer in every client format", () => {
    expect(replies.length).toBeGreaterThan(20);
    const formats = new Set(
      replies.map((reply) =>
        reply.body!.html!.includes('id="divRplyFwdMsg"')
          ? "outlook"
          : reply.body!.html!.includes('type="cite"')
            ? "apple"
            : "gmail",
      ),
    );
    expect(formats).toEqual(new Set(["gmail", "outlook", "apple"]));
    for (const reply of replies) {
      const index = messages.indexOf(reply);
      const previous = messages[index - 1];
      expect(reply.snippet).not.toContain(previous.snippet!.slice(0, 40));
      expect(reply.body!.text).toContain(previous.snippet!.slice(0, 40));
    }
  });

  it("collapse in the message view", () => {
    for (const reply of replies) {
      const document = new DOMParser().parseFromString(reply.body!.html!, "text/html");
      expect(markQuotedHistory(document.body), reply.id).toBe(true);
      expect(splitQuotedText(reply.body!.text!), reply.id).toBeDefined();
    }
  });
});
