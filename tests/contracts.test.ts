import { describe, expect, it } from "vitest";
import {
  appearancePreferenceSchema,
  composeInputSchema,
  featureEventSchema,
  imapConnectInputSchema,
  licenseActivationResultSchema,
  licenseKeySchema,
  mailForwardInputSchema,
  messageSchema,
  outlookAppInputSchema,
  sendInputSchema,
  threadListInputSchema,
} from "../src/shared/contracts";
import {
  CUSTOM_GMAIL_SCOPES,
  GMAIL_FULL_ACCESS_SCOPE,
  GMAIL_SCOPES,
  googleCredentialsAllowPermanentDelete,
  googleCredentialsWithGrantedScopes,
  googleOAuthRedirectUri,
  googleOAuthScopes,
  googleOAuthSourceAllowsPermanentDelete,
  isOAuthStateValid,
} from "../src/main/oauth";
import { toEmailQuery } from "../src/main/mail-mapping";
import { isAllowedFrameUrl } from "../src/main/ipc-security";

describe("desktop contracts", () => {
  it("allows bodyless drafts but requires text before sending", () => {
    const subjectOnly = {
      accountId: "account-1",
      to: [],
      subject: "Remember this",
      text: "",
      html: "<p></p>",
    };
    expect(composeInputSchema.parse(subjectOnly)).toEqual(subjectOnly);
    expect(() => sendInputSchema.parse(subjectOnly)).toThrow();
  });

  it("preserves all editable fields when validating a forward", () => {
    const input = {
      target: { accountId: "account-1", threadId: "thread-1" },
      messageId: "message-1",
      to: [{ email: "friend@example.com" }],
      bcc: [{ email: "archive@example.com" }],
      subject: "Custom subject",
      text: "Formatted note",
      html: "<p><strong>Formatted note</strong></p>",
      attachments: [
        {
          token: "attachment-token",
          filename: "notes.pdf",
          mimeType: "application/pdf",
          sizeBytes: 128,
        },
      ],
      includeAttachments: true,
    };
    expect(mailForwardInputSchema.parse(input)).toEqual(input);
  });

  it("allows a forward with only a Cc or Bcc recipient", () => {
    const base = {
      target: { accountId: "account-1", threadId: "thread-1" },
      messageId: "message-1",
      to: [],
      subject: "Private update",
    };

    expect(
      mailForwardInputSchema.parse({
        ...base,
        bcc: [{ email: "archive@example.com" }],
      }),
    ).toMatchObject({ to: [], bcc: [{ email: "archive@example.com" }] });
    expect(
      mailForwardInputSchema.parse({
        ...base,
        cc: [{ email: "team@example.com" }],
      }),
    ).toMatchObject({ to: [], cc: [{ email: "team@example.com" }] });
    expect(() => mailForwardInputSchema.parse(base)).toThrow();
  });

  it("maps mailbox views to provider-neutral Fluxmail queries", () => {
    expect(toEmailQuery(threadListInputSchema.parse({ view: "inbox" }))).toEqual({
      folder: "inbox",
    });
    expect(toEmailQuery(threadListInputSchema.parse({ view: "starred" }))).toEqual({
      starred: true,
    });
    expect(
      toEmailQuery(threadListInputSchema.parse({ view: "search", query: "from:team" })),
    ).toEqual({ from: "team" });
    expect(toEmailQuery(threadListInputSchema.parse({ view: "label", label: "Projects" }))).toEqual(
      { folder: "Projects" },
    );
  });

  it("maps typed search operators while preserving literal text", () => {
    expect(
      toEmailQuery(
        threadListInputSchema.parse({
          view: "search",
          query: "from:amy@example.com is:unread -has:attachment after:2026-07-01 quarterly report",
        }),
      ),
    ).toEqual({
      from: "amy@example.com",
      read: false,
      hasAttachment: false,
      after: "2026-07-01",
      text: "quarterly report",
    });
    expect(
      toEmailQuery(
        threadListInputSchema.parse({ view: "search", query: '"from:amy@example.com"' }),
      ),
    ).toEqual({ text: "from:amy@example.com" });
  });

  it("rejects invalid typed searches before contacting a provider", () => {
    expect(() =>
      toEmailQuery(
        threadListInputSchema.parse({
          view: "search",
          query: "after:2026-07-31 before:2026-07-01",
        }),
      ),
    ).toThrow("after must be earlier than before");
  });

  it("accepts cache-first mailbox refresh requests", () => {
    expect(threadListInputSchema.parse({ view: "sent", backgroundRefresh: true })).toMatchObject({
      view: "sent",
      backgroundRefresh: true,
    });
  });

  it("accepts only allowlisted renderer analytics fields", () => {
    const parsed = featureEventSchema.parse({
      feature: "search",
      action: "submitted",
      source: "toolbar",
      query: "private search",
      email: "person@example.com",
    });
    expect(parsed).toEqual({
      feature: "search",
      action: "submitted",
      source: "toolbar",
    });
    expect(() =>
      featureEventSchema.parse({
        feature: "unknown",
        action: "submitted",
        source: "toolbar",
      }),
    ).toThrow();
  });

  it("validates Microsoft app settings", () => {
    expect(
      outlookAppInputSchema.parse({
        clientId: " 11111111-2222-3333-4444-555555555555 ",
        tenantId: "contoso.onmicrosoft.com",
      }),
    ).toEqual({
      clientId: "11111111-2222-3333-4444-555555555555",
      tenantId: "contoso.onmicrosoft.com",
    });
    expect(() =>
      outlookAppInputSchema.parse({ clientId: "not-a-client-id", tenantId: "common" }),
    ).toThrow("Application (client) ID");
    expect(() =>
      outlookAppInputSchema.parse({
        clientId: "11111111-2222-3333-4444-555555555555",
        tenantId: "common/../evil",
      }),
    ).toThrow();
  });

  it("validates IMAP connection settings", () => {
    const input = {
      email: "me@example.org",
      imap: { host: "imap.example.org", port: 993, security: "tls", user: "me", password: "p" },
      smtp: { host: "smtp.example.org", port: 587, security: "starttls", user: "me" },
    };
    expect(imapConnectInputSchema.parse(input)).toEqual(input);
    expect(() => imapConnectInputSchema.parse({ ...input, email: "not-an-email" })).toThrow();
    expect(() =>
      imapConnectInputSchema.parse({ ...input, imap: { ...input.imap, port: 70_000 } }),
    ).toThrow();
    expect(() =>
      imapConnectInputSchema.parse({ ...input, smtp: { ...input.smtp, host: "smtp host" } }),
    ).toThrow();
  });

  it("requires an exact, high-entropy OAuth state", () => {
    const state = "a".repeat(48);
    expect(isOAuthStateValid(state, state)).toBe(true);
    expect(isOAuthStateValid(state, `${state}0`)).toBe(false);
    expect(isOAuthStateValid("short", "short")).toBe(false);
    expect(isOAuthStateValid(state, null)).toBe(false);
  });

  it("uses a literal loopback address for the OAuth redirect", () => {
    expect(googleOAuthRedirectUri(8976)).toBe("http://127.0.0.1:8976/oauth/callback");
  });

  it("requests Gmail modification access without permanent deletion access", () => {
    expect(GMAIL_SCOPES).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(GMAIL_SCOPES).not.toContain(GMAIL_FULL_ACCESS_SCOPE);
  });

  it("requests and detects permanent deletion access for custom OAuth clients", () => {
    expect(googleOAuthSourceAllowsPermanentDelete("built-in")).toBe(false);
    expect(googleOAuthSourceAllowsPermanentDelete("stored")).toBe(true);
    expect(googleOAuthScopes(true)).toEqual(CUSTOM_GMAIL_SCOPES);
    expect(
      googleCredentialsAllowPermanentDelete(
        { scope: `openid ${GMAIL_FULL_ACCESS_SCOPE} email` },
        GMAIL_SCOPES,
      ),
    ).toBe(true);
    expect(
      googleCredentialsAllowPermanentDelete(
        { scope: "openid https://www.googleapis.com/auth/gmail.modify email" },
        CUSTOM_GMAIL_SCOPES,
      ),
    ).toBe(false);
    expect(googleCredentialsAllowPermanentDelete({}, CUSTOM_GMAIL_SCOPES)).toBe(true);
    expect(googleCredentialsWithGrantedScopes({}, CUSTOM_GMAIL_SCOPES).scope).toBe(
      CUSTOM_GMAIL_SCOPES.join(" "),
    );
  });

  it("accepts only the app origin or the exact development origin", () => {
    expect(isAllowedFrameUrl("app://fluxmail/index.html")).toBe(true);
    expect(isAllowedFrameUrl("app://other/index.html")).toBe(false);
    expect(isAllowedFrameUrl("https://attacker.example")).toBe(false);
    expect(isAllowedFrameUrl("http://localhost:5173/thread", "http://localhost:5173")).toBe(true);
    expect(isAllowedFrameUrl("http://localhost:51730/thread", "http://localhost:5173")).toBe(false);
  });

  it("accepts only supported appearance preferences", () => {
    expect(appearancePreferenceSchema.parse("system")).toBe("system");
    expect(appearancePreferenceSchema.parse("light")).toBe("light");
    expect(appearancePreferenceSchema.parse("dark")).toBe("dark");
    expect(() => appearancePreferenceSchema.parse("midnight")).toThrow();
  });

  it("trims license keys and validates activation results", () => {
    expect(licenseKeySchema.parse("  fluxmail_lic_key  ")).toBe("fluxmail_lic_key");
    expect(() => licenseKeySchema.parse(" ")).toThrow();
    expect(() => licenseKeySchema.parse("x".repeat(201))).toThrow();
    expect(
      licenseActivationResultSchema.parse({
        outcome: "activated",
        license: {
          plan: "pro",
          maxMembers: 1,
          maxAccounts: 5,
          canUsePrivateImageRelay: true,
        },
      }),
    ).toEqual({
      outcome: "activated",
      license: {
        plan: "pro",
        maxMembers: 1,
        maxAccounts: 5,
        canUsePrivateImageRelay: true,
      },
    });
  });

  it("preserves Reply-To addresses in renderer messages", () => {
    expect(
      messageSchema.parse({
        id: "message-1",
        threadId: "thread-1",
        accountId: "account-1",
        from: { email: "sender@example.com" },
        replyTo: [{ name: "Support", email: "support@example.com" }],
        to: [{ email: "me@example.com" }],
        subject: "Hello",
        date: "2026-07-16T12:00:00Z",
        flags: { read: true, starred: false, draft: false },
      }).replyTo,
    ).toEqual([{ name: "Support", email: "support@example.com" }]);
  });

  // PayPal sends receipts with a truncated Reply-To such as "Richard Chu <someone@gmail.c...>".
  it("opens messages whose headers carry addresses that are not valid email", () => {
    const message = messageSchema.parse({
      id: "message-1",
      threadId: "thread-1",
      accountId: "account-1",
      from: { name: "Sender", email: "sender@localhost" },
      replyTo: [{ name: "Richard Chu", email: "someone@gmail.c..." }],
      to: [{ email: "me@example.com" }],
      subject: "Hello",
      date: "2026-07-16T12:00:00Z",
      flags: { read: true, starred: false, draft: false },
    });
    expect(message.replyTo).toEqual([{ name: "Richard Chu", email: "someone@gmail.c..." }]);
    expect(message.from?.email).toBe("sender@localhost");
  });

  it("still rejects invalid recipients when composing", () => {
    expect(() =>
      composeInputSchema.parse({
        accountId: "account-1",
        to: [{ email: "noreply" }],
        subject: "Hello",
        text: "Hi",
      }),
    ).toThrow();
  });
});
