import { describe, expect, it } from "vitest";
import { securityForPort, suggestImapHosts } from "../src/renderer/imap-presets";

describe("IMAP server suggestions", () => {
  it("uses known hosts for providers with nonstandard server names", () => {
    expect(suggestImapHosts("me@icloud.com")).toEqual({
      imap: "imap.mail.me.com",
      smtp: "smtp.mail.me.com",
    });
    expect(suggestImapHosts(" Me@Yahoo.com ")).toEqual({
      imap: "imap.mail.yahoo.com",
      smtp: "smtp.mail.yahoo.com",
    });
  });

  it("guesses imap and smtp subdomains for other domains", () => {
    expect(suggestImapHosts("me@example.co.uk")).toEqual({
      imap: "imap.example.co.uk",
      smtp: "smtp.example.co.uk",
    });
  });

  it("waits for a complete domain", () => {
    expect(suggestImapHosts("me")).toBeUndefined();
    expect(suggestImapHosts("me@")).toBeUndefined();
    expect(suggestImapHosts("me@example")).toBeUndefined();
  });

  it("matches the CLI's security defaults for each port", () => {
    expect(securityForPort(993)).toBe("tls");
    expect(securityForPort(465)).toBe("tls");
    expect(securityForPort(143)).toBe("starttls");
    expect(securityForPort(587)).toBe("starttls");
  });
});
