import { describe, expect, it } from "vitest";
import { defaultSender } from "../src/renderer/components/SenderSelect";
import type { MailMessage } from "../src/shared/contracts";

const identities = [
  { email: "me@example.com", isPrimary: true },
  { email: "team@example.com", name: "Team", isPrimary: false },
];

describe("defaultSender", () => {
  it("uses the primary address for new messages", () => {
    expect(defaultSender(identities)?.email).toBe("me@example.com");
  });

  it("replies from the address the original was sent to", () => {
    expect(defaultSender(identities, message({ to: [{ email: "Team@Example.com" }] }))?.email).toBe(
      "team@example.com",
    );
  });

  it("replies from the address that sent the original", () => {
    expect(
      defaultSender(
        identities,
        message({ from: { email: "team@example.com" }, to: [{ email: "sam@example.com" }] }),
      )?.email,
    ).toBe("team@example.com");
  });

  it("falls back to the primary address when no identity received the original", () => {
    expect(defaultSender(identities, message({ to: [{ email: "list@example.com" }] }))?.email).toBe(
      "me@example.com",
    );
  });

  it("returns nothing before identities load", () => {
    expect(defaultSender(undefined, message({}))).toBeUndefined();
  });
});

function message(overrides: Partial<MailMessage>): MailMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    accountId: "account-1",
    from: { email: "sender@example.com" },
    to: [],
    subject: "Subject",
    date: "2026-07-16T12:00:00Z",
    flags: { read: true, starred: false, draft: false },
    ...overrides,
  };
}
