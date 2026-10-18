import type { ImapServerSettings } from "../shared/contracts";

/** Hosts for providers whose server names do not follow imap.<domain> and smtp.<domain>. */
const KNOWN_HOSTS: Record<string, { imap: string; smtp: string }> = {
  "icloud.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
  "me.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
  "mac.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
  "yahoo.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  "ymail.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  "aol.com": { imap: "imap.aol.com", smtp: "smtp.aol.com" },
  "fastmail.com": { imap: "imap.fastmail.com", smtp: "smtp.fastmail.com" },
  "gmx.com": { imap: "imap.gmx.com", smtp: "mail.gmx.com" },
  "zoho.com": { imap: "imap.zoho.com", smtp: "smtp.zoho.com" },
};

export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_SMTP_PORT = 587;

/** Suggested server hosts for a mailbox address, or undefined until it has a domain. */
export function suggestImapHosts(email: string): { imap: string; smtp: string } | undefined {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return undefined;
  return KNOWN_HOSTS[domain] ?? { imap: `imap.${domain}`, smtp: `smtp.${domain}` };
}

/** Ports 993 and 465 use TLS from the start. Other ports upgrade with STARTTLS. */
export function securityForPort(port: number): ImapServerSettings["security"] {
  return port === 993 || port === 465 ? "tls" : "starttls";
}
