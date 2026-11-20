import { describe, expect, it } from "vitest";
import {
  joinLabels,
  threadParticipants,
  type ParticipantMessage,
} from "../src/shared/thread-participants";

const me = "richard@example.com";

function msg(
  from: ParticipantMessage["from"],
  options: Partial<ParticipantMessage> & { read?: boolean; draft?: boolean } = {},
): ParticipantMessage {
  const { read = true, draft = false, ...rest } = options;
  return { from, to: [{ email: me }], flags: { read, draft }, ...rest };
}

const steven = { name: "Steven Park", email: "steven@example.net" };
const dana = { name: "Dana Whitfield", email: "dana@example.net" };
const alex = { name: "Alex Kim", email: "alex@example.net" };
const sam = { name: "Sam Lee", email: "sam@example.net" };
const self = { name: "Richard from Fluxmail", email: me };

describe("threadParticipants", () => {
  it("uses the full name when one person wrote", () => {
    expect(threadParticipants([msg(steven), msg(steven)], me)).toMatchObject({
      text: "Steven Park",
      email: steven.email,
    });
  });

  it("shows me instead of the account's name after a reply", () => {
    const result = threadParticipants(
      [msg(steven, { read: false }), msg(self, { to: [steven] })],
      me,
    );
    expect(result.text).toBe("Steven, me");
    expect(result.labels).toEqual([
      { label: "Steven", unread: true },
      { label: "me", unread: false },
    ]);
    expect(result.email).toBe(steven.email);
  });

  it("orders people by when they first wrote", () => {
    const result = threadParticipants(
      [msg(self, { to: [steven] }), msg(steven), msg(self, { to: [steven] })],
      me,
    );
    expect(result.text).toBe("me, Steven");
  });

  it("treats a message in Sent as the account's own, so aliases show as me", () => {
    const alias = { name: "Richard", email: "hello@example.com" };
    const result = threadParticipants(
      [msg(steven), msg(alias, { to: [steven], folder: { role: "sent" } })],
      me,
    );
    expect(result.text).toBe("Steven, me");
  });

  it("keeps the first and latest two names when more than three people wrote", () => {
    const result = threadParticipants([msg(steven), msg(dana), msg(alex), msg(sam)], me);
    expect(result.text).toBe("Steven .. Alex, Sam");
    expect(joinLabels(result.labels)).toBe(result.text);
  });

  it("names the recipients when only the account wrote", () => {
    expect(threadParticipants([msg(self, { to: [steven] })], me).text).toBe("To: Steven Park");
    expect(threadParticipants([msg(self, { to: [steven, dana] })], me).text).toBe(
      "To: Steven, Dana",
    );
    expect(threadParticipants([msg(self, { to: [{ email: me }] })], me).text).toBe("me");
    expect(threadParticipants([msg(self, { to: [] })], me).text).toBe("No recipients");
  });

  it("leaves drafts out when other messages are sent", () => {
    const result = threadParticipants([msg(steven), msg(self, { to: [steven], draft: true })], me);
    expect(result.text).toBe("Steven Park");
  });

  it("takes the first name from a Last, First display name", () => {
    const result = threadParticipants(
      [
        msg({ name: "Doe, John", email: "jdoe@corp.example" }),
        msg({ name: "Smith, Ann", email: "asmith@corp.example" }),
      ],
      me,
    );
    expect(result.text).toBe("John, Ann");
  });

  it("uses the address when a sender has no name", () => {
    expect(
      threadParticipants([msg({ email: "noreply@service.example" }), msg(steven)], me).text,
    ).toBe("noreply, Steven");
    expect(threadParticipants([msg({ email: "noreply@service.example" })], me).text).toBe(
      "noreply@service.example",
    );
  });

  it("counts a draft without a From line as the account's own", () => {
    expect(threadParticipants([msg(undefined, { to: [steven], draft: true })], me).text).toBe(
      "To: Steven Park",
    );
  });

  it("falls back to Unknown sender when no message has a sender", () => {
    expect(threadParticipants([msg(undefined)], me).text).toBe("Unknown sender");
  });

  it("indexes full names and addresses but not the account's own name", () => {
    const { search } = threadParticipants([msg(steven), msg(self, { to: [steven, dana] })], me);
    expect(search).toContain("Steven Park");
    expect(search).toContain("dana@example.net");
    expect(search).not.toContain("Richard from Fluxmail");
  });
});
