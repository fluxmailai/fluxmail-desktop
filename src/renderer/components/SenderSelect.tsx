import { useEffect, useState } from "react";
import type { AccountInfo, MailMessage, SendAsIdentity } from "../../shared/contracts";

export interface SenderChoice {
  accountId: string;
  email: string;
}

/**
 * Loads the send-as identities of each account. Accounts that fail to load are left out until a
 * later load succeeds. A new `refreshKey`, such as the open conversation, loads them again so a
 * failed or outdated list does not stick. The main process caches the list, so this is cheap.
 */
export function useSendAsIdentities(
  accountIds: string[],
  refreshKey?: string,
): Record<string, SendAsIdentity[]> {
  const [identities, setIdentities] = useState<Record<string, SendAsIdentity[]>>({});
  const key = accountIds.join("\n");
  useEffect(() => {
    let canceled = false;
    for (const accountId of key ? key.split("\n") : []) {
      void window.fluxmail.accounts
        .sendAs(accountId)
        .then((list) => {
          if (!canceled) setIdentities((current) => ({ ...current, [accountId]: list }));
        })
        .catch(() => undefined);
    }
    return () => {
      canceled = true;
    };
  }, [key, refreshKey]);
  return identities;
}

/**
 * The address the engine sends from when the composer names none: a reply goes out from the
 * identity the original was sent to, and anything else from the primary address.
 */
export function defaultSender(
  identities: SendAsIdentity[] | undefined,
  replyTo?: MailMessage,
): SendAsIdentity | undefined {
  if (!identities?.length) return undefined;
  if (replyTo) {
    const byEmail = new Map(
      identities.map((identity) => [identity.email.toLowerCase(), identity] as const),
    );
    for (const address of [
      ...(replyTo.from ? [replyTo.from] : []),
      ...replyTo.to,
      ...(replyTo.cc ?? []),
    ]) {
      const match = byEmail.get(address.email.toLowerCase());
      if (match) return match;
    }
  }
  return identities.find((identity) => identity.isPrimary) ?? identities[0];
}

interface Props {
  accounts: Array<Pick<AccountInfo, "id" | "email" | "displayName">>;
  identities: Record<string, SendAsIdentity[]>;
  value: SenderChoice;
  /** Accounts other than the selected one cannot be chosen, such as once a draft exists. */
  lockAccount?: boolean;
  onChange(choice: SenderChoice): void;
}

/** Picks the account and address to send from. Renders nothing when there is only one choice. */
export function SenderSelect({ accounts, identities, value, lockAccount, onChange }: Props) {
  const options = accounts.flatMap((account) => {
    const list: SendAsIdentity[] =
      identities[account.id] ??
      (account.email ? [{ email: account.email, name: account.displayName, isPrimary: true }] : []);
    const missingSelection =
      account.id === value.accountId &&
      value.email &&
      !list.some((identity) => identity.email.toLowerCase() === value.email.toLowerCase());
    return [
      ...list.map((identity) => ({ accountId: account.id, ...identity })),
      // A saved draft can name an address the account no longer lists. Keep it visible.
      ...(missingSelection
        ? [{ accountId: account.id, email: value.email, isPrimary: false }]
        : []),
    ];
  });
  if (options.length < 2) return null;
  const optionKey = (choice: SenderChoice) => `${choice.accountId}:${choice.email.toLowerCase()}`;
  return (
    <label>
      <span>From</span>
      <select
        aria-label="From"
        value={optionKey(value)}
        onChange={(event) => {
          const option = options.find((candidate) => optionKey(candidate) === event.target.value);
          if (option) onChange({ accountId: option.accountId, email: option.email });
        }}
      >
        {options.map((option) => (
          <option
            key={optionKey(option)}
            value={optionKey(option)}
            disabled={lockAccount && option.accountId !== value.accountId}
          >
            {option.name ? `${option.name} <${option.email}>` : option.email}
          </option>
        ))}
      </select>
    </label>
  );
}
