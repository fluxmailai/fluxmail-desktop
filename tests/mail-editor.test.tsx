/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailHtmlFromEditor, useMailEditor } from "../src/renderer/components/MailEditor";

const signOff =
  '<p style="margin: 0px;">Best,</p><p style="margin: 0px;"><br></p><p style="margin: 0px;">Richard</p>';

describe("emailHtmlFromEditor", () => {
  it("keeps editor lines together and blank lines visible in mail clients", () => {
    expect(emailHtmlFromEditor("<p>Best,</p><p></p><p>Richard</p>")).toBe(signOff);
  });

  it("leaves formatting and hard breaks alone", () => {
    expect(emailHtmlFromEditor("<p><strong>Hi</strong><br>there</p>")).toBe(
      '<p style="margin: 0px;"><strong>Hi</strong><br>there</p>',
    );
  });
});

describe("useMailEditor", () => {
  afterEach(cleanup);

  it("round-trips sent HTML and reports single line breaks in the text", async () => {
    const onChange = vi.fn();
    let editor: Editor | null = null;
    function Harness() {
      editor = useMailEditor({ initialHtml: signOff, onChange });
      return null;
    }
    render(<Harness />);
    await waitFor(() => expect(editor).not.toBeNull());

    expect(editor!.getHTML()).toBe("<p>Best,</p><p></p><p>Richard</p>");
    act(() => {
      editor!.chain().focus("end").insertContent("!").run();
    });
    expect(onChange).toHaveBeenLastCalledWith({
      html: signOff.replace("Richard", "Richard!"),
      text: "Best,\n\nRichard!",
    });
  });
});
