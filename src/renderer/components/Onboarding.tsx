import { useState } from "react";
import fluxmailBrandIcon from "../../../build/icon.png";
import { AccountSetupDialog, type AccountSetupProvider } from "./AccountSetupDialog";

export function Onboarding({
  onConnected,
  onSetupOpenChange,
}: {
  onConnected(): Promise<void>;
  /** Lets the app keep onboarding mounted while the setup dialog is open. */
  onSetupOpenChange?(open: boolean): void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [setupProvider, setSetupProviderState] = useState<AccountSetupProvider>();
  const [error, setError] = useState<string>();
  const setSetupProvider = (provider: AccountSetupProvider | undefined) => {
    setSetupProviderState(provider);
    onSetupOpenChange?.(Boolean(provider));
  };
  return (
    <>
      <main className="onboarding">
        <div className="brand">
          <span className="brand-mark">
            <img alt="" aria-hidden="true" draggable={false} src={fluxmailBrandIcon} />
          </span>
          <span>Fluxmail</span>
        </div>
        <div className="onboarding-actions">
          <button
            className="primary-button connect-button"
            disabled={connecting}
            onClick={() => {
              setConnecting(true);
              setError(undefined);
              void window.fluxmail.accounts
                .connect("gmail")
                .then(onConnected)
                .catch((caught) =>
                  setError(
                    caught instanceof Error ? caught.message : "Fluxmail could not connect Gmail.",
                  ),
                )
                .finally(() => setConnecting(false));
            }}
          >
            {connecting ? "Waiting for Google..." : "Connect Gmail"}
          </button>
          <button
            className="secondary-button connect-button"
            disabled={connecting}
            onClick={() => {
              setError(undefined);
              setSetupProvider("outlook");
            }}
          >
            Connect Outlook
          </button>
          <button
            className="secondary-button connect-button"
            disabled={connecting}
            onClick={() => {
              setError(undefined);
              setSetupProvider("imap");
            }}
          >
            Connect with IMAP
          </button>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
      {setupProvider ? (
        <AccountSetupDialog
          provider={setupProvider}
          onClose={() => setSetupProvider(undefined)}
          onConnected={async () => {
            setSetupProvider(undefined);
            await onConnected();
          }}
        />
      ) : null}
    </>
  );
}
