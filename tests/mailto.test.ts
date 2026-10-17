import { describe, expect, it } from "vitest";
import { parseMailtoUrl } from "../src/shared/mailto";

describe("mailto URLs", () => {
  it("reads a plain address", () => {
    expect(parseMailtoUrl("mailto:person@example.com")).toEqual({
      to: "person@example.com",
      cc: "",
      bcc: "",
      subject: "",
      body: "",
    });
  });

  it("reads recipients, subject, and body from header fields", () => {
    expect(
      parseMailtoUrl(
        "MAILTO:a@example.com,b@example.com?To=c@example.com&cc=d%40example.com&bcc=e@example.com&subject=Hello%20there&body=Line%201%0D%0ALine%202",
      ),
    ).toEqual({
      to: "a@example.com, b@example.com, c@example.com",
      cc: "d@example.com",
      bcc: "e@example.com",
      subject: "Hello there",
      body: "Line 1\nLine 2",
    });
  });

  it("keeps encoded commas inside an address", () => {
    expect(
      parseMailtoUrl(
        "mailto:%22last%2Cfirst%22@example.com,b@example.com?cc=%22x%2Cy%22@example.com",
      ),
    ).toMatchObject({
      to: '"last,first"@example.com, b@example.com',
      cc: '"x,y"@example.com',
    });
  });

  it("keeps plus signs literal", () => {
    expect(parseMailtoUrl("mailto:me+tag@example.com?subject=1+1")).toMatchObject({
      to: "me+tag@example.com",
      subject: "1+1",
    });
  });

  it("tolerates malformed escapes and empty addresses", () => {
    expect(parseMailtoUrl("mailto:?subject=100%")).toMatchObject({ to: "", subject: "100%" });
  });

  it.each(["https://example.com", "person@example.com", "javascript:alert(1)"])(
    "ignores %s",
    (url) => {
      expect(parseMailtoUrl(url)).toBeUndefined();
    },
  );
});
