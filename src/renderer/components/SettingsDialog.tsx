import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import {
  ChevronsUpDown,
  ExternalLink,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import type {
  AppearancePreference,
  BootstrapState,
  UndoSendDelaySeconds,
} from "../../shared/contracts";
import { IconButton, MenuButton, SelectionCheckbox } from "./Controls";

const UNDO_SEND_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 20, label: "20 seconds" },
  { value: 30, label: "30 seconds" },
] as const satisfies ReadonlyArray<{ value: UndoSendDelaySeconds; label: string }>;

const ABOUT_ACTIONS = [
  {
    label: "Source code",
    open: () =>
      window.fluxmail.system.openExternal("https://github.com/fluxmailai/fluxmail-desktop"),
  },
  {
    label: "Software licenses",
    open: () => window.fluxmail.system.openLegalNotices(),
  },
  {
    label: "Terms",
    open: () => window.fluxmail.system.openExternal("https://www.fluxmail.ai/terms"),
  },
] as const;

interface Props {
  state: BootstrapState;
  onState: Dispatch<SetStateAction<BootstrapState | null>>;
  onClose(): void;
  onError(message: string): void;
}

export function SettingsDialog({ state, onState, onClose, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [appearanceBusy, setAppearanceBusy] = useState(false);
  const [dockBadgeBusy, setDockBadgeBusy] = useState(false);
  const [undoSendBusy, setUndoSendBusy] = useState(false);
  const [openNextAfterArchiveBusy, setOpenNextAfterArchiveBusy] = useState(false);
  const [blockRemoteImagesBusy, setBlockRemoteImagesBusy] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [licenseFeedback, setLicenseFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  }>();
  const [imageRelayBusy, setImageRelayBusy] = useState(false);
  const imageRelayAvailable = state.license.canUsePrivateImageRelay;
  const updateTelemetry = async (enabled: boolean) => {
    const previous = state.telemetry;
    setBusy(true);
    onState((current) =>
      current ? { ...current, telemetry: { ...current.telemetry, enabled } } : current,
    );
    try {
      const telemetry = await window.fluxmail.telemetry.setEnabled(enabled);
      onState((current) => (current ? { ...current, telemetry } : current));
      void window.fluxmail.analytics
        .trackFeature({
          feature: "settings",
          action: enabled ? "enabled" : "disabled",
          source: "settings",
        })
        .catch(() => undefined);
    } catch (error) {
      onState((current) => (current ? { ...current, telemetry: previous } : current));
      onError(
        error instanceof Error ? error.message : "Fluxmail could not update analytics settings.",
      );
    } finally {
      setBusy(false);
    }
  };
  const connectAccount = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      await window.fluxmail.accounts.connectGmail();
      onState(await window.fluxmail.bootstrap());
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not connect Gmail.");
    } finally {
      setConnecting(false);
    }
  };
  const updateAppearance = async (appearance: AppearancePreference) => {
    if (appearanceBusy || appearance === state.preferences.appearance) return;
    setAppearanceBusy(true);
    try {
      const value = await window.fluxmail.preferences.setAppearance(appearance);
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, appearance: value },
            }
          : current,
      );
      void window.fluxmail.analytics
        .trackFeature({
          feature: "settings",
          action: "updated",
          source: "settings",
        })
        .catch(() => undefined);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not change the appearance.");
    } finally {
      setAppearanceBusy(false);
    }
  };
  const updateDockBadge = async (enabled: boolean) => {
    if (dockBadgeBusy || enabled === state.preferences.dockBadge) return;
    const previous = state.preferences.dockBadge;
    setDockBadgeBusy(true);
    onState((current) =>
      current
        ? {
            ...current,
            preferences: { ...current.preferences, dockBadge: enabled },
          }
        : current,
    );
    try {
      const value = await window.fluxmail.preferences.setDockBadge(enabled);
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, dockBadge: value },
            }
          : current,
      );
      void window.fluxmail.analytics
        .trackFeature({
          feature: "settings",
          action: "updated",
          source: "settings",
        })
        .catch(() => undefined);
    } catch (error) {
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, dockBadge: previous },
            }
          : current,
      );
      onError(error instanceof Error ? error.message : "Could not change the Dock badge setting.");
    } finally {
      setDockBadgeBusy(false);
    }
  };
  const updateUndoSendDelay = async (delay: UndoSendDelaySeconds) => {
    if (undoSendBusy || delay === state.preferences.undoSendDelaySeconds) return;
    const previous = state.preferences.undoSendDelaySeconds;
    setUndoSendBusy(true);
    onState((current) =>
      current
        ? {
            ...current,
            preferences: { ...current.preferences, undoSendDelaySeconds: delay },
          }
        : current,
    );
    try {
      const value = await window.fluxmail.preferences.setUndoSendDelaySeconds(delay);
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, undoSendDelaySeconds: value },
            }
          : current,
      );
    } catch (error) {
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, undoSendDelaySeconds: previous },
            }
          : current,
      );
      onError(error instanceof Error ? error.message : "Could not change the undo send setting.");
    } finally {
      setUndoSendBusy(false);
    }
  };
  const updateOpenNextAfterArchive = async (enabled: boolean) => {
    if (openNextAfterArchiveBusy || enabled === state.preferences.openNextAfterArchive) return;
    const previous = state.preferences.openNextAfterArchive;
    setOpenNextAfterArchiveBusy(true);
    onState((current) =>
      current
        ? {
            ...current,
            preferences: { ...current.preferences, openNextAfterArchive: enabled },
          }
        : current,
    );
    try {
      const value = await window.fluxmail.preferences.setOpenNextAfterArchive(enabled);
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, openNextAfterArchive: value },
            }
          : current,
      );
      void window.fluxmail.analytics
        .trackFeature({
          feature: "settings",
          action: "updated",
          source: "settings",
        })
        .catch(() => undefined);
    } catch (error) {
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, openNextAfterArchive: previous },
            }
          : current,
      );
      onError(
        error instanceof Error ? error.message : "Could not change the archive behavior setting.",
      );
    } finally {
      setOpenNextAfterArchiveBusy(false);
    }
  };
  const updateBlockRemoteImages = async (enabled: boolean) => {
    if (blockRemoteImagesBusy || enabled === state.preferences.blockRemoteImages) return;
    const previous = state.preferences.blockRemoteImages;
    setBlockRemoteImagesBusy(true);
    onState((current) =>
      current
        ? {
            ...current,
            preferences: { ...current.preferences, blockRemoteImages: enabled },
          }
        : current,
    );
    try {
      const value = await window.fluxmail.preferences.setBlockRemoteImages(enabled);
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, blockRemoteImages: value },
            }
          : current,
      );
      void window.fluxmail.analytics
        .trackFeature({
          feature: "settings",
          action: "updated",
          source: "settings",
        })
        .catch(() => undefined);
    } catch (error) {
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, blockRemoteImages: previous },
            }
          : current,
      );
      onError(
        error instanceof Error ? error.message : "Could not change the image blocking setting.",
      );
    } finally {
      setBlockRemoteImagesBusy(false);
    }
  };
  const activateLicense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (licenseBusy || !licenseKey.trim()) return;
    setLicenseBusy(true);
    setLicenseFeedback(undefined);
    try {
      const result = await window.fluxmail.license.activate(licenseKey);
      onState((current) => (current ? { ...current, license: result.license } : current));
      setLicenseKey("");
      setLicenseOpen(false);
      setLicenseFeedback({
        kind: "success",
        message:
          result.outcome === "activated"
            ? "License activated."
            : "License key saved. Fluxmail will retry when it can reach the license server.",
      });
      void window.fluxmail.analytics
        .trackFeature({ feature: "settings", action: "completed", source: "settings" })
        .catch(() => undefined);
    } catch (error) {
      setLicenseFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Fluxmail could not activate the license.",
      });
      void window.fluxmail.analytics
        .trackFeature({ feature: "settings", action: "failed", source: "settings" })
        .catch(() => undefined);
    } finally {
      setLicenseBusy(false);
    }
  };

  const updateImageRelay = async (enabled: boolean) => {
    if (imageRelayBusy || enabled === state.preferences.imageRelay) return;
    const previous = state.preferences.imageRelay;
    setImageRelayBusy(true);
    onState((current) =>
      current
        ? {
            ...current,
            preferences: { ...current.preferences, imageRelay: enabled },
          }
        : current,
    );
    try {
      const value = await window.fluxmail.preferences.setImageRelay(enabled);
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, imageRelay: value },
            }
          : current,
      );
      void window.fluxmail.analytics
        .trackFeature({
          feature: "settings",
          action: enabled ? "enabled" : "disabled",
          source: "settings",
        })
        .catch(() => undefined);
    } catch (error) {
      onState((current) =>
        current
          ? {
              ...current,
              preferences: { ...current.preferences, imageRelay: previous },
            }
          : current,
      );
      onError(error instanceof Error ? error.message : "Could not change the image relay setting.");
    } finally {
      setImageRelayBusy(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <header>
          <h1>Settings</h1>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="settings-content">
          <section>
            <h2>Plan</h2>
            <div className="plan-row">
              <span>
                <strong>{formatPlan(state.license.plan)}</strong>
                <small>
                  {formatPlanOffer(state.license.maxMembers, state.license.maxAccounts)}
                </small>
              </span>
              <button
                className="secondary-button"
                onClick={() =>
                  void window.fluxmail.system
                    .openExternal("https://fluxmail.ai/pricing")
                    .catch((error) =>
                      onError(
                        error instanceof Error ? error.message : "Could not open the plans page.",
                      ),
                    )
                }
              >
                View plans
                <ExternalLink size={13} />
              </button>
            </div>
            {licenseOpen ? (
              <form
                id="license-activation-form"
                className="license-activation"
                onSubmit={(event) => void activateLicense(event)}
              >
                <label htmlFor="settings-license-key">License key</label>
                <div>
                  <input
                    id="settings-license-key"
                    type="password"
                    value={licenseKey}
                    placeholder="fluxmail_lic_..."
                    autoComplete="off"
                    autoFocus
                    spellCheck={false}
                    disabled={licenseBusy}
                    onChange={(event) => {
                      setLicenseKey(event.target.value);
                      if (licenseFeedback) setLicenseFeedback(undefined);
                    }}
                  />
                  <button
                    type="submit"
                    className="secondary-button"
                    disabled={licenseBusy || !licenseKey.trim()}
                  >
                    {licenseBusy ? "Activating..." : "Activate"}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={licenseBusy}
                    onClick={() => {
                      setLicenseOpen(false);
                      setLicenseKey("");
                      setLicenseFeedback(undefined);
                    }}
                  >
                    Cancel
                  </button>
                </div>
                <p className="settings-help">
                  Paste the key from your Fluxmail purchase. The desktop app, CLI, and MCP server
                  use the same license.
                </p>
              </form>
            ) : (
              <button
                type="button"
                className="secondary-button license-activation-trigger"
                aria-expanded="false"
                aria-controls="license-activation-form"
                onClick={() => {
                  setLicenseOpen(true);
                  setLicenseFeedback(undefined);
                }}
              >
                Activate license key
              </button>
            )}
            {licenseFeedback ? (
              <p
                className={`${licenseFeedback.kind === "error" ? "form-error" : "form-success"} license-feedback`}
                role={licenseFeedback.kind === "error" ? "alert" : "status"}
              >
                {licenseFeedback.message}
              </p>
            ) : null}
            {state.license.warning ? <p className="form-error">{state.license.warning}</p> : null}
          </section>
          <section>
            <h2>Accounts</h2>
            <p className="settings-help">
              Fluxmail uses the same connected accounts as the local Fluxmail MCP server.
            </p>
            <div className="settings-accounts">
              {state.accounts.map((account) => (
                <div key={account.id}>
                  <span className="account-identity">
                    <strong>{account.displayName || account.email}</strong>
                    <small>{account.email}</small>
                  </span>
                  <span className="account-actions">
                    <IconButton
                      label="Reconnect account"
                      onClick={() =>
                        void window.fluxmail.accounts
                          .reconnect(account.id)
                          .catch((error) =>
                            onError(
                              error instanceof Error ? error.message : "Could not reconnect.",
                            ),
                          )
                      }
                    >
                      <RefreshCw size={16} />
                    </IconButton>
                    <IconButton
                      label="Remove account"
                      className="icon-button danger"
                      onClick={() => {
                        if (!window.confirm(`Remove ${account.email} from Fluxmail?`)) return;
                        void window.fluxmail.accounts
                          .remove(account.id)
                          .then(() =>
                            onState((current) =>
                              current
                                ? {
                                    ...current,
                                    accounts: current.accounts.filter(
                                      (item) => item.id !== account.id,
                                    ),
                                  }
                                : current,
                            ),
                          )
                          .catch((error) =>
                            onError(
                              error instanceof Error
                                ? error.message
                                : "Could not remove the account.",
                            ),
                          );
                      }}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </span>
                </div>
              ))}
            </div>
            <button
              className="secondary-button"
              disabled={connecting}
              onClick={() => void connectAccount()}
            >
              {connecting ? "Waiting for Google..." : "Add Gmail account"}
            </button>
          </section>
          <section>
            <h2>Appearance</h2>
            <p className="settings-help">Choose a theme, or follow your Mac setting.</p>
            <div className="appearance-options" role="radiogroup" aria-label="Appearance">
              {(
                [
                  { value: "system", label: "System", icon: Monitor },
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                ] as const
              ).map((option) => {
                const Icon = option.icon;
                const selected = state.preferences.appearance === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={selected ? "active" : ""}
                    disabled={appearanceBusy}
                    onClick={() => void updateAppearance(option.value)}
                  >
                    <Icon size={16} />
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="toggle-row">
              <span>
                <strong>Dock badge</strong>
                <small>Show the unread count on the Fluxmail icon in the Dock.</small>
              </span>
              <SelectionCheckbox
                state={state.preferences.dockBadge ? "checked" : "unchecked"}
                label="Dock badge"
                className="settings-checkbox"
                disabled={dockBadgeBusy}
                onClick={() => void updateDockBadge(!state.preferences.dockBadge)}
              />
            </div>
          </section>
          <section>
            <h2>Behavior</h2>
            <div className="toggle-row">
              <span>
                <strong>Open next conversation after archiving</strong>
                <small>When you archive an open conversation, open the next one in the list.</small>
              </span>
              <SelectionCheckbox
                state={state.preferences.openNextAfterArchive ? "checked" : "unchecked"}
                label="Open next conversation after archiving"
                className="settings-checkbox"
                disabled={openNextAfterArchiveBusy}
                onClick={() =>
                  void updateOpenNextAfterArchive(!state.preferences.openNextAfterArchive)
                }
              />
            </div>
          </section>
          <section>
            <h2>Sending</h2>
            <div className="setting-select-row">
              <span>
                <strong>Undo send</strong>
                <small>Delay delivery so you have time to cancel a sent message.</small>
              </span>
              <MenuButton
                label="Undo send"
                className="setting-select-menu"
                triggerClassName="account-picker-trigger setting-select-trigger"
                menuClassName="setting-select-options"
                align="right"
                tooltip={false}
                disabled={undoSendBusy}
                options={UNDO_SEND_OPTIONS.map((option) => ({
                  id: String(option.value),
                  label: option.label,
                  selected: state.preferences.undoSendDelaySeconds === option.value,
                  onSelect: () => void updateUndoSendDelay(option.value),
                }))}
              >
                <span>
                  {
                    UNDO_SEND_OPTIONS.find(
                      (option) => option.value === state.preferences.undoSendDelaySeconds,
                    )?.label
                  }
                </span>
                <ChevronsUpDown size={14} />
              </MenuButton>
            </div>
          </section>
          <section>
            <h2>Privacy</h2>
            <div className="toggle-row">
              <span>
                <strong>Block remote images by default</strong>
                <small>
                  If you're not using the private image relay, we recommend keeping this on. Turning
                  it off may expose your IP address to email senders.
                </small>
              </span>
              <SelectionCheckbox
                state={state.preferences.blockRemoteImages ? "checked" : "unchecked"}
                label="Block remote images by default"
                className="settings-checkbox"
                disabled={blockRemoteImagesBusy}
                onClick={() => void updateBlockRemoteImages(!state.preferences.blockRemoteImages)}
              />
            </div>
            <div
              className={`toggle-row${imageRelayAvailable ? "" : " setting-unavailable"}`}
              aria-disabled={!imageRelayAvailable}
            >
              <span>
                <strong>Private image relay</strong>
                <small>
                  {imageRelayAvailable
                    ? "Use Fluxmail's private hosted relay when you load remote images. This hides your IP address from the sender."
                    : state.license.warning
                      ? "Renew your Fluxmail license to use the private image relay."
                      : "Private image relay is available on Pro, Team, and Enterprise."}
                </small>
              </span>
              <SelectionCheckbox
                state={state.preferences.imageRelay ? "checked" : "unchecked"}
                label="Private image relay"
                className="settings-checkbox"
                disabled={imageRelayBusy || !imageRelayAvailable}
                onClick={() => void updateImageRelay(!state.preferences.imageRelay)}
              />
            </div>
            <div className="toggle-row">
              <span>
                <strong>Anonymous analytics</strong>
                <small>
                  Send anonymized analytics to help us improve our features, performance, and
                  reliability. Your email content is never included.
                </small>
              </span>
              <SelectionCheckbox
                state={state.telemetry.enabled ? "checked" : "unchecked"}
                label="Anonymous analytics"
                className="settings-checkbox"
                disabled={busy || state.telemetry.lockedByEnvironment}
                onClick={() => void updateTelemetry(!state.telemetry.enabled)}
              />
            </div>
            {state.telemetry.lockedByEnvironment ? (
              <p className="settings-help">
                Your environment has disabled analytics with DO_NOT_TRACK or FLUXMAIL_TELEMETRY.
              </p>
            ) : null}
          </section>
          <section>
            <h2>About</h2>
            <div className="settings-about">
              <span>
                <strong>Fluxmail version</strong>
                <small>{state.engine.version}</small>
              </span>
              <span>
                <strong>Shared data format</strong>
                <small>{state.engine.storeFormat}</small>
              </span>
            </div>
            <div className="settings-about-links">
              {ABOUT_ACTIONS.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="text-button"
                  onClick={() =>
                    void action
                      .open()
                      .catch((error) =>
                        onError(
                          error instanceof Error
                            ? error.message
                            : `Could not open ${action.label}.`,
                        ),
                      )
                  }
                >
                  {action.label}
                  <ExternalLink size={12} />
                </button>
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function formatPlan(value: string): string {
  const names: Record<string, string> = {
    free: "Free",
    personal: "Personal",
    pro: "Pro",
    professional: "Professional",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
  };
  return (
    names[value.toLowerCase()] ??
    value.replaceAll(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

export function formatPlanOffer(maxMembers: number, maxAccounts: number): string {
  const members = maxMembers === 1 ? "one member" : `${maxMembers} members`;
  const mailboxes =
    maxAccounts === 1 ? "one connected mailbox" : `${maxAccounts} connected mailboxes`;
  return `Includes up to ${mailboxes} for ${members}.`;
}
