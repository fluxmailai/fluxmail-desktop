export interface MailtoFields {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

/** Parses an RFC 6068 mailto URL. A literal "+" stays a plus sign, unlike form encoding. */
export function parseMailtoUrl(rawUrl: string): MailtoFields | undefined {
  const match = /^\s*mailto:([^?#]*)(?:\?([^#]*))?/i.exec(rawUrl);
  if (!match) return undefined;
  const recipients = { to: [decode(match[1])], cc: [] as string[], bcc: [] as string[] };
  let subject = "";
  let body = "";
  for (const pair of (match[2] ?? "").split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const name = decode(separator < 0 ? pair : pair.slice(0, separator)).toLowerCase();
    const value = separator < 0 ? "" : decode(pair.slice(separator + 1));
    if (name === "to" || name === "cc" || name === "bcc") recipients[name].push(value);
    else if (name === "subject" && !subject) subject = value;
    else if (name === "body" && !body) body = value.replace(/\r\n?/g, "\n");
  }
  return {
    to: joinAddresses(recipients.to),
    cc: joinAddresses(recipients.cc),
    bcc: joinAddresses(recipients.bcc),
    subject,
    body,
  };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function joinAddresses(values: string[]): string {
  return values
    .flatMap((value) => value.split(","))
    .map((address) => address.trim())
    .filter(Boolean)
    .join(", ");
}
