import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import type {
  AccountInfo,
  ImapConnectInput,
  ImapServerSettings,
  ImapSettings,
  OutlookSetup,
} from "../../shared/contracts";
import {
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  securityForPort,
  suggestImapHosts,
} from "../imap-presets";
import { IconButton } from "./Controls";

export type AccountSetupProvider = "outlook" | "imap";

interface Props {
  provider: AccountSetupProvider;
  /** Set when reconnecting an existing mailbox instead of adding one. */
  reconnectAccountId?: string;
  onConnected(account: AccountInfo): void | Promise<void>;
  onClose(): void;
}

const ENTRA_APP_REGISTRATIONS_URL =
  "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
const OUTLOOK_SETUP_GUIDE_URL = "https://fluxmail.ai/docs/connect-outlook-to-mcp";

export function AccountSetupDialog({ provider, reconnectAccountId, onConnected, onClose }: Props) {
  const title =
    provider === "outlook"
      ? reconnectAccountId
        ? "Reconnect Outlook"
        : "Connect Outlook"
      : reconnectAccountId
        ? "Reconnect IMAP account"
        : "Connect IMAP account";
  return (
    <div
      className="modal-backdrop account-setup-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="settings-dialog account-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h1>{title}</h1>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="settings-content">
          {provider === "outlook" ? (
            <OutlookSetupStep reconnectAccountId={reconnectAccountId} onConnected={onConnected} />
          ) : (
            <ImapSetupStep reconnectAccountId={reconnectAccountId} onConnected={onConnected} />
          )}
        </div>
      </section>
    </div>
  );
}

function OutlookSetupStep({
  reconnectAccountId,
  onConnected,
}: Pick<Props, "reconnectAccountId" | "onConnected">) {
  const [setup, setSetup] = useState<OutlookSetup>();
  const [editing, setEditing] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string>();
  const [clientId, setClientId] = useState("");
  const [tenantId, setTenantId] = useState("common");
  const started = useRef(false);

  const signIn = async () => {
    setSigningIn(true);
    setError(undefined);
    try {
      const account = reconnectAccountId
        ? await window.fluxmail.accounts.reconnect(reconnectAccountId)
        : await window.fluxmail.accounts.connect("outlook");
      await onConnected(account);
    } catch (caught) {
      setError(errorMessage(caught, "Fluxmail could not connect Outlook."));
    } finally {
      setSigningIn(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void window.fluxmail.accounts
      .outlookSetup()
      .then((value) => {
        setSetup(value);
        if (value.configured) void signIn();
      })
      .catch((caught) => setError(errorMessage(caught, "Fluxmail could not load Outlook setup.")));
    // Sign-in starts once, when the dialog opens with a Microsoft app already set up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveApp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    try {
      setSetup(
        await window.fluxmail.accounts.configureOutlook({
          clientId: clientId.trim(),
          tenantId: tenantId.trim() || "common",
        }),
      );
      setEditing(false);
    } catch (caught) {
      setError(errorMessage(caught, "Fluxmail could not save the Microsoft app."));
      return;
    }
    await signIn();
  };

  if (!setup) {
    return (
      <section>
        {error ? <ErrorText message={error} /> : <p className="settings-help">Loading...</p>}
      </section>
    );
  }

  if (!setup.configured || editing) {
    return (
      <section>
        <p className="settings-help">
          Outlook sign-in uses a Microsoft Entra app that you register once. Fluxmail stores it with
          your other Fluxmail settings, so the CLI and MCP server use it too.
        </p>
        <ol className="account-setup-steps">
          <li>
            <ExternalButton url={ENTRA_APP_REGISTRATIONS_URL}>
              Register an app in Microsoft Entra
            </ExternalButton>
            . Under Supported account types, choose who can sign in.
          </li>
          <li>
            Under Authentication, add the <strong>Mobile and desktop applications</strong> platform
            with this redirect URI:
            <code className="account-setup-code">{setup.redirectUri}</code>
          </li>
          <li>
            Turn on <strong>Allow public client flows</strong>. No client secret is needed.
          </li>
          <li>Paste the app&apos;s Application (client) ID below.</li>
        </ol>
        <form className="account-setup-form" onSubmit={(event) => void saveApp(event)}>
          <Field label="Application (client) ID" htmlFor="outlook-client-id">
            <input
              id="outlook-client-id"
              value={clientId}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              disabled={signingIn}
              onChange={(event) => setClientId(event.target.value)}
            />
          </Field>
          <Field
            label="Directory (tenant) ID"
            htmlFor="outlook-tenant-id"
            help="Use common for both personal and work accounts, or enter your organization's tenant ID."
          >
            <input
              id="outlook-tenant-id"
              value={tenantId}
              autoComplete="off"
              spellCheck={false}
              disabled={signingIn}
              onChange={(event) => setTenantId(event.target.value)}
            />
          </Field>
          {error ? <ErrorText message={error} /> : null}
          <div className="account-setup-actions">
            <ExternalButton url={OUTLOOK_SETUP_GUIDE_URL}>Setup guide</ExternalButton>
            {setup.configured ? (
              <button type="button" className="text-button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            ) : null}
            <button
              type="submit"
              className="primary-button"
              disabled={signingIn || !clientId.trim()}
            >
              {signingIn ? "Waiting for Microsoft..." : "Save and sign in"}
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section>
      <p className="settings-help">
        {signingIn
          ? "Finish signing in to Microsoft in your browser, then return to Fluxmail."
          : "Sign in to Microsoft in your browser to connect your mailbox."}
      </p>
      {error ? <ErrorText message={error} /> : null}
      <div className="account-setup-actions">
        {setup.editable && !signingIn ? (
          <button type="button" className="text-button" onClick={() => setEditing(true)}>
            Change Microsoft app
          </button>
        ) : null}
        <button
          type="button"
          className="primary-button"
          disabled={signingIn}
          onClick={() => void signIn()}
        >
          {signingIn ? "Waiting for Microsoft..." : "Try again"}
        </button>
      </div>
    </section>
  );
}

type Security = ImapServerSettings["security"];

interface ImapForm {
  email: string;
  displayName: string;
  password: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: Security;
  imapUser: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: Security;
  smtpUser: string;
  separateSmtpPassword: boolean;
  smtpPassword: string;
  saveSent: boolean;
}

const EMPTY_IMAP_FORM: ImapForm = {
  email: "",
  displayName: "",
  password: "",
  imapHost: "",
  imapPort: String(DEFAULT_IMAP_PORT),
  imapSecurity: securityForPort(DEFAULT_IMAP_PORT),
  imapUser: "",
  smtpHost: "",
  smtpPort: String(DEFAULT_SMTP_PORT),
  smtpSecurity: securityForPort(DEFAULT_SMTP_PORT),
  smtpUser: "",
  separateSmtpPassword: false,
  smtpPassword: "",
  saveSent: true,
};

function ImapSetupStep({
  reconnectAccountId,
  onConnected,
}: Pick<Props, "reconnectAccountId" | "onConnected">) {
  const [form, setForm] = useState<ImapForm>(EMPTY_IMAP_FORM);
  const [saved, setSaved] = useState<ImapSettings>();
  const [loading, setLoading] = useState(Boolean(reconnectAccountId));
  const [hostsEdited, setHostsEdited] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState<{ account: AccountInfo; warnings: string[] }>();

  useEffect(() => {
    if (!reconnectAccountId) return;
    let active = true;
    void window.fluxmail.accounts
      .imapSettings(reconnectAccountId)
      .then((settings) => {
        if (!active) return;
        setSaved(settings);
        setHostsEdited(true);
        setShowAdvanced(
          settings.imap.user.toLowerCase() !== settings.email.toLowerCase() ||
            settings.smtp.user !== settings.imap.user ||
            settings.separateSmtpPassword,
        );
        setForm({
          ...EMPTY_IMAP_FORM,
          email: settings.email,
          displayName: settings.displayName ?? "",
          imapHost: settings.imap.host,
          imapPort: String(settings.imap.port),
          imapSecurity: settings.imap.security,
          imapUser: settings.imap.user,
          smtpHost: settings.smtp.host,
          smtpPort: String(settings.smtp.port),
          smtpSecurity: settings.smtp.security,
          smtpUser: settings.smtp.user,
          separateSmtpPassword: settings.separateSmtpPassword,
          saveSent: settings.saveSent,
        });
      })
      .catch((caught) => active && setError(errorMessage(caught, "Could not load the account.")))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [reconnectAccountId]);

  const update = (patch: Partial<ImapForm>) => {
    setError(undefined);
    setForm((current) => ({ ...current, ...patch }));
  };

  const updateEmail = (email: string) => {
    const hosts = hostsEdited ? undefined : suggestImapHosts(email);
    update({
      email,
      ...(hosts ? { imapHost: hosts.imap, smtpHost: hosts.smtp } : {}),
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const email = form.email.trim();
    const imapPort = Number(form.imapPort);
    const smtpPort = Number(form.smtpPort);
    if (!isPort(imapPort) || !isPort(smtpPort)) {
      setError("Enter a port number between 1 and 65535.");
      return;
    }
    const imapUser = form.imapUser.trim() || email;
    const input: ImapConnectInput = {
      email,
      ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
      imap: {
        host: form.imapHost.trim(),
        port: imapPort,
        security: form.imapSecurity,
        user: imapUser,
        ...(form.password ? { password: form.password } : {}),
      },
      smtp: {
        host: form.smtpHost.trim(),
        port: smtpPort,
        security: form.smtpSecurity,
        user: form.smtpUser.trim() || imapUser,
        ...(form.separateSmtpPassword && form.smtpPassword ? { password: form.smtpPassword } : {}),
      },
      separateSmtpPassword: form.separateSmtpPassword,
      saveSent: form.saveSent,
      ...(reconnectAccountId ? { reconnectAccountId } : {}),
    };
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.fluxmail.accounts.connectImap(input);
      if (result.warnings.length) setConnected(result);
      else await onConnected(result.account);
    } catch (caught) {
      setError(errorMessage(caught, "Fluxmail could not connect this account."));
    } finally {
      setBusy(false);
    }
  };

  if (connected) {
    return (
      <section>
        <p className="form-success" role="status">
          Connected {connected.account.email}.
        </p>
        <p className="settings-help">Fluxmail found some folders that need attention:</p>
        <ul className="account-setup-warnings">
          {connected.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
        <div className="account-setup-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => void onConnected(connected.account)}
          >
            Done
          </button>
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <section>
        <p className="settings-help">Loading...</p>
      </section>
    );
  }

  const keepPasswordHint = reconnectAccountId ? "Leave blank to keep the saved password." : "";
  return (
    <section>
      <p className="settings-help">
        Connect any mailbox that supports IMAP and SMTP. Many providers, including iCloud, Yahoo,
        and Gmail, need an app-specific password instead of your normal password.
      </p>
      <form className="account-setup-form" onSubmit={(event) => void submit(event)}>
        <Field label="Email address" htmlFor="imap-email">
          <input
            id="imap-email"
            type="email"
            value={form.email}
            placeholder="you@example.com"
            autoComplete="off"
            autoFocus={!reconnectAccountId}
            spellCheck={false}
            required
            readOnly={Boolean(reconnectAccountId)}
            disabled={busy}
            onChange={(event) => updateEmail(event.target.value)}
          />
        </Field>
        <Field label="Name" htmlFor="imap-name" help="Shown to people you send mail to.">
          <input
            id="imap-name"
            value={form.displayName}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => update({ displayName: event.target.value })}
          />
        </Field>
        <Field label="Password" htmlFor="imap-password" help={keepPasswordHint || undefined}>
          <input
            id="imap-password"
            type="password"
            value={form.password}
            autoComplete="off"
            autoFocus={Boolean(reconnectAccountId)}
            required={!reconnectAccountId}
            disabled={busy}
            onChange={(event) => update({ password: event.target.value })}
          />
        </Field>
        <div className="account-setup-server">
          <Field label="IMAP server" htmlFor="imap-host">
            <input
              id="imap-host"
              value={form.imapHost}
              placeholder="imap.example.com"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={busy}
              onChange={(event) => {
                setHostsEdited(true);
                update({ imapHost: event.target.value });
              }}
            />
          </Field>
          <Field label="Port" htmlFor="imap-port">
            <input
              id="imap-port"
              inputMode="numeric"
              value={form.imapPort}
              required
              disabled={busy}
              onChange={(event) =>
                update({
                  imapPort: event.target.value,
                  imapSecurity: portSecurity(event.target.value, form.imapSecurity),
                })
              }
            />
          </Field>
          <SecurityField
            id="imap-security"
            label="IMAP security"
            value={form.imapSecurity}
            disabled={busy}
            onChange={(imapSecurity) => update({ imapSecurity })}
          />
        </div>
        <div className="account-setup-server">
          <Field label="SMTP server" htmlFor="smtp-host">
            <input
              id="smtp-host"
              value={form.smtpHost}
              placeholder="smtp.example.com"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={busy}
              onChange={(event) => {
                setHostsEdited(true);
                update({ smtpHost: event.target.value });
              }}
            />
          </Field>
          <Field label="Port" htmlFor="smtp-port">
            <input
              id="smtp-port"
              inputMode="numeric"
              value={form.smtpPort}
              required
              disabled={busy}
              onChange={(event) =>
                update({
                  smtpPort: event.target.value,
                  smtpSecurity: portSecurity(event.target.value, form.smtpSecurity),
                })
              }
            />
          </Field>
          <SecurityField
            id="smtp-security"
            label="SMTP security"
            value={form.smtpSecurity}
            disabled={busy}
            onChange={(smtpSecurity) => update({ smtpSecurity })}
          />
        </div>
        <p className="settings-help account-setup-note">
          Security changes to match the port: 993 and 465 use TLS, other ports use STARTTLS.
        </p>
        <label className="account-setup-checkbox">
          <input
            type="checkbox"
            checked={form.saveSent}
            disabled={busy}
            onChange={(event) => update({ saveSent: event.target.checked })}
          />
          Save a copy of sent mail in the Sent folder
        </label>
        <p className="settings-help account-setup-note">
          Turn this off if your provider already saves the mail you send, or you will see each
          message twice.
        </p>
        {showAdvanced ? (
          <>
            <Field
              label="IMAP username"
              htmlFor="imap-user"
              help="Leave blank to use the email address."
            >
              <input
                id="imap-user"
                value={form.imapUser}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => update({ imapUser: event.target.value })}
              />
            </Field>
            <Field
              label="SMTP username"
              htmlFor="smtp-user"
              help="Leave blank to use the IMAP username."
            >
              <input
                id="smtp-user"
                value={form.smtpUser}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => update({ smtpUser: event.target.value })}
              />
            </Field>
            <label className="account-setup-checkbox">
              <input
                type="checkbox"
                checked={form.separateSmtpPassword}
                disabled={busy}
                onChange={(event) => update({ separateSmtpPassword: event.target.checked })}
              />
              Use a different password for SMTP
            </label>
            {form.separateSmtpPassword ? (
              <Field
                label="SMTP password"
                htmlFor="smtp-password"
                help={
                  reconnectAccountId && saved?.separateSmtpPassword ? keepPasswordHint : undefined
                }
              >
                <input
                  id="smtp-password"
                  type="password"
                  value={form.smtpPassword}
                  autoComplete="off"
                  required={!(reconnectAccountId && saved?.separateSmtpPassword)}
                  disabled={busy}
                  onChange={(event) => update({ smtpPassword: event.target.value })}
                />
              </Field>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            className="text-button account-setup-advanced"
            onClick={() => setShowAdvanced(true)}
          >
            Use different usernames or passwords
          </button>
        )}
        {error ? <ErrorText message={error} /> : null}
        <div className="account-setup-actions">
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Checking connection..." : reconnectAccountId ? "Reconnect" : "Connect"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="account-setup-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help ? <small>{help}</small> : null}
    </div>
  );
}

function SecurityField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: Security;
  disabled: boolean;
  onChange(value: Security): void;
}) {
  return (
    <div className="account-setup-field account-setup-security">
      <label htmlFor={id}>Security</label>
      <select
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as Security)}
      >
        <option value="tls">TLS</option>
        <option value="starttls">STARTTLS</option>
      </select>
    </div>
  );
}

function ExternalButton({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="text-button account-setup-link"
      onClick={() => void window.fluxmail.system.openExternal(url).catch(() => undefined)}
    >
      {children}
      <ExternalLink size={12} />
    </button>
  );
}

function ErrorText({ message }: { message: string }) {
  return (
    <p className="form-error account-setup-error" role="alert">
      {message}
    </p>
  );
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/** Editing a port resets security to that port's usual mode, which the user can still change. */
function portSecurity(port: string, current: Security): Security {
  const value = Number(port);
  return isPort(value) ? securityForPort(value) : current;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
