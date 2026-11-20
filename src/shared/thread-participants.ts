/**
 * Who a conversation row names, the way Gmail's list does: everyone who wrote in the thread, in the
 * order they first wrote, with the account's own messages shown as "me". One sender gets their full
 * name; several get first names, and past three the row keeps the first and the latest two with
 * ".." between. A thread only the account wrote in names who it went to instead, as "To: ...".
 */

export interface ParticipantMessage {
  from?: { name?: string; email: string };
  to: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  bcc?: Array<{ name?: string; email: string }>;
  folder?: { role?: string };
  flags: { read: boolean; draft: boolean };
}

/** One name in the row. `unread` marks a sender with an unread message, which the list bolds. */
export interface ParticipantLabel {
  label: string;
  unread: boolean;
}

export const PARTICIPANT_ELLIPSIS = "..";

export interface ThreadParticipants {
  /** The names to show, already shortened and truncated. Empty when there is no one to name. */
  labels: ParticipantLabel[];
  /** The same names as plain text, for places that show one string. */
  text: string;
  /** Email of the latest sender other than the account, or of the latest sender. */
  email: string;
  /** Every participant's full name and address, so search still finds a thread by full name. */
  search: string;
}

interface Person {
  name: string;
  email: string;
  self: boolean;
  unread: boolean;
}

const MAX_NAMES = 3;

/** `messages` must be in date order, oldest first. */
export function threadParticipants(
  messages: ParticipantMessage[],
  accountEmail: string,
): ThreadParticipants {
  // Drafts don't add the account as a sender, because the row already says Draft.
  const sent = messages.filter((message) => !message.flags.draft);
  const source = sent.length ? sent : messages;
  const own = normalize(accountEmail);
  const isSelf = (message: ParticipantMessage) =>
    message.flags.draft ||
    message.folder?.role === "sent" ||
    (Boolean(message.from?.email) && normalize(message.from!.email) === own);

  const senders: Person[] = [];
  for (const message of source) {
    const self = isSelf(message);
    const from = message.from?.email || message.from?.name ? message.from! : undefined;
    // A draft or sent message without a From line is still the account's own.
    if (!from && !self) continue;
    const key = self ? undefined : normalize(from!.email) || from!.name;
    const existing = senders.find((person) =>
      self ? person.self : !person.self && (normalize(person.email) || person.name) === key,
    );
    const unread = !message.flags.read;
    if (existing) {
      existing.unread ||= unread;
      if (!existing.name) existing.name = cleanName(from?.name);
      continue;
    }
    senders.push({ name: cleanName(from?.name), email: from?.email ?? "", self, unread });
  }

  const recipients = recipientsOf(source, own);
  // The account's own name would match nearly every thread, so search leaves it out.
  const search = [...senders.filter((person) => !person.self), ...recipients]
    .flatMap((person) => [person.name, person.email])
    .filter(Boolean)
    .join(" ");
  const latestOther = [...source]
    .reverse()
    .find((message) => message.from?.email && !isSelf(message));
  const email = latestOther?.from?.email ?? source.at(-1)?.from?.email ?? "";

  if (!senders.length) {
    return { labels: [], text: "Unknown sender", email, search };
  }

  if (senders.every((person) => person.self)) {
    if (!recipients.length) {
      const anyRecipient = source.some(
        (message) => message.to.length || message.cc?.length || message.bcc?.length,
      );
      const label = anyRecipient ? "me" : "No recipients";
      return { labels: [{ label, unread: false }], text: label, email, search };
    }
    const labels = shorten(recipients);
    return {
      labels: [{ label: "To:", unread: false }, ...labels],
      text: `To: ${joinLabels(labels)}`,
      email: recipients.at(-1)!.email,
      search,
    };
  }

  const labels = shorten(senders);
  return { labels, text: joinLabels(labels), email, search };
}

/** How the list joins labels: commas between names, spaces around the ".." and after "To:". */
export function joinLabels(labels: ParticipantLabel[]): string {
  return labels
    .map((label, index) => `${participantSeparator(labels, index)}${label.label}`)
    .join("");
}

/** The text that goes before the label at `index`. */
export function participantSeparator(labels: ParticipantLabel[], index: number): string {
  if (index === 0) return "";
  const previous = labels[index - 1].label;
  return labels[index].label === PARTICIPANT_ELLIPSIS ||
    previous === PARTICIPANT_ELLIPSIS ||
    previous === "To:"
    ? " "
    : ", ";
}

function shorten(people: Person[]): ParticipantLabel[] {
  const single = people.length === 1;
  const labels = people.map((person) => ({
    label: displayName(person, single),
    unread: person.unread,
  }));
  if (labels.length <= MAX_NAMES) return labels;
  return [labels[0], { label: PARTICIPANT_ELLIPSIS, unread: false }, ...labels.slice(-2)];
}

function recipientsOf(messages: ParticipantMessage[], own: string): Person[] {
  const people: Person[] = [];
  for (const message of messages) {
    for (const address of [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]) {
      const email = normalize(address.email);
      if (!email || email === own) continue;
      if (people.some((person) => normalize(person.email) === email)) continue;
      people.push({
        name: cleanName(address.name),
        email: address.email,
        self: false,
        unread: false,
      });
    }
  }
  return people;
}

function displayName(person: Person, single: boolean): string {
  if (person.self) return "me";
  return single ? person.name || person.email : firstName(person);
}

function firstName(person: Person): string {
  if (!person.name) return person.email.split("@")[0] || person.email;
  if (person.name.includes("@")) return person.name.split("@")[0] || person.name;
  // Exchange and Outlook often send "Last, First", where the first name follows the comma.
  const [last, first] = person.name.split(",", 2).map((part) => part.trim());
  const word = (first || last).split(/\s+/)[0];
  return word.replace(/[,;]+$/, "") || person.name;
}

function cleanName(name: string | undefined): string {
  return (name ?? "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
}

function normalize(email: string | undefined): string {
  return (email ?? "").trim().toLowerCase();
}
