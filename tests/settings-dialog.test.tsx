/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../src/renderer/components/SettingsDialog";
import type { BootstrapState, FluxmailDesktopApi } from "../src/shared/contracts";

afterEach(cleanup);

describe("SettingsDialog license activation", () => {
  it("activates a key, clears the input, and updates the displayed plan", async () => {
    const activate = vi.fn(async () => ({
      outcome: "activated" as const,
      license: {
        plan: "pro",
        maxMembers: 1,
        maxAccounts: 5,
        canUsePrivateImageRelay: true,
      },
    }));
    installApi(activate);
    render(<SettingsHarness />);

    expect(screen.queryByLabelText("License key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Activate license key" }));
    const input = screen.getByLabelText("License key");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "fluxmail_lic_valid-key" } });
    fireEvent.click(screen.getByRole("button", { name: /^Activate$/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("License activated.");
    expect(activate).toHaveBeenCalledWith("fluxmail_lic_valid-key");
    expect(screen.queryByLabelText("License key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate license key" })).toBeVisible();
    expect(screen.getByText("Pro", { exact: true })).toBeVisible();
    expect(screen.getByText("Includes up to 5 connected mailboxes for one member.")).toBeVisible();
  });

  it("keeps the key in the input when activation fails", async () => {
    const activate = vi.fn(async () => {
      throw new Error("That license key is invalid. Check it for typos.");
    });
    installApi(activate);
    render(<SettingsHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Activate license key" }));
    const input = screen.getByLabelText("License key");
    fireEvent.change(input, { target: { value: "fluxmail_lic_typo" } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That license key is invalid. Check it for typos.",
    );
    expect(input).toHaveValue("fluxmail_lic_typo");
    await waitFor(() => expect(screen.getByRole("button", { name: "Activate" })).toBeEnabled());
  });
});

describe("SettingsDialog private image relay", () => {
  it("keeps a saved image relay preference checked but inactive on Personal", () => {
    const state = bootstrapState(false);
    const { rerender } = render(
      <SettingsDialog state={state} onState={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: "Private image relay",
    }) as HTMLButtonElement;

    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(checkbox.disabled).toBe(true);
    expect(
      screen
        .getByText("Private image relay")
        .closest(".toggle-row")
        ?.classList.contains("setting-unavailable"),
    ).toBe(true);
    expect(
      screen.getByText("Private image relay is available on Pro, Team, and Enterprise."),
    ).toBeTruthy();

    rerender(
      <SettingsDialog
        state={{
          ...state,
          license: {
            plan: "pro",
            maxMembers: 1,
            maxAccounts: 5,
            canUsePrivateImageRelay: true,
          },
        }}
        onState={vi.fn()}
        onClose={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(checkbox.disabled).toBe(false);
  });
});

describe("SettingsDialog About links", () => {
  it("opens the bundled software licenses and the external links", async () => {
    const openExternal = vi.fn(async () => undefined);
    const openLegalNotices = vi.fn(async () => undefined);
    installApi(undefined, undefined, undefined, openExternal, openLegalNotices);
    render(<SettingsHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Source code" }));
    fireEvent.click(screen.getByRole("button", { name: "Software licenses" }));
    fireEvent.click(screen.getByRole("button", { name: "Terms" }));

    await waitFor(() =>
      expect(openExternal).toHaveBeenNthCalledWith(
        1,
        "https://github.com/fluxmailai/fluxmail-desktop",
      ),
    );
    expect(openExternal).toHaveBeenNthCalledWith(2, "https://www.fluxmail.ai/terms");
    expect(openLegalNotices).toHaveBeenCalledOnce();
  });
});

describe("SettingsDialog undo send", () => {
  it("can turn undo send off", async () => {
    const setUndoSendDelaySeconds = vi.fn(async () => 0 as const);
    installApi(undefined, undefined, setUndoSendDelaySeconds);
    render(<SettingsHarness />);
    const trigger = screen.getByRole("button", { name: "Undo send" });

    expect(trigger).toHaveTextContent("10 seconds");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Off" }));

    await waitFor(() => expect(setUndoSendDelaySeconds).toHaveBeenCalledWith(0));
    expect(trigger).toHaveTextContent("Off");
  });
});

describe("SettingsDialog archive behavior", () => {
  it("updates the enabled-by-default archive setting", async () => {
    const setOpenNextAfterArchive = vi.fn(async (enabled: boolean) => enabled);
    installApi(
      vi.fn(async () => {
        throw new Error("Unused");
      }),
      setOpenNextAfterArchive,
    );
    render(<SettingsHarness />);
    const checkbox = screen.getByRole("checkbox", {
      name: "Open next conversation after archiving",
    });

    expect(checkbox).toHaveAttribute("aria-checked", "true");
    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toHaveAttribute("aria-checked", "false"));
    expect(setOpenNextAfterArchive).toHaveBeenCalledWith(false);
  });

  it("restores the setting when saving fails", async () => {
    const onError = vi.fn();
    installApi(
      vi.fn(async () => {
        throw new Error("Unused");
      }),
      vi.fn(async () => {
        throw new Error("Could not save this setting.");
      }),
    );
    render(<SettingsHarness onError={onError} />);
    const checkbox = screen.getByRole("checkbox", {
      name: "Open next conversation after archiving",
    });

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toHaveAttribute("aria-checked", "true"));
    expect(onError).toHaveBeenCalledWith("Could not save this setting.");
  });
});

function SettingsHarness({ onError = vi.fn() }: { onError?(): void }) {
  const [state, setState] = useState<BootstrapState | null>(bootstrapState(false));
  if (!state) return null;
  return <SettingsDialog state={state} onState={setState} onClose={vi.fn()} onError={onError} />;
}

function installApi(
  activate: (key: string) => Promise<{
    outcome: "activated" | "saved_for_retry";
    license: BootstrapState["license"];
  }> = vi.fn(),
  setOpenNextAfterArchive: (enabled: boolean) => Promise<boolean> = async (enabled) => enabled,
  setUndoSendDelaySeconds = vi.fn(),
  openExternal = vi.fn(async () => undefined),
  openLegalNotices = vi.fn(async () => undefined),
): void {
  Object.defineProperty(window, "fluxmail", {
    configurable: true,
    value: {
      license: { activate },
      preferences: { setOpenNextAfterArchive, setUndoSendDelaySeconds },
      analytics: { trackFeature: vi.fn(async () => undefined) },
      system: { openExternal, openLegalNotices },
    } as unknown as FluxmailDesktopApi,
  });
}

function bootstrapState(canUsePrivateImageRelay: boolean): BootstrapState {
  return {
    engine: {
      version: "0.5.0",
      storeFormat: 1,
      minimumSupportedFormat: 1,
      maximumSupportedFormat: 1,
    },
    accounts: [],
    folders: [],
    unreadCount: 0,
    draftCount: 0,
    scheduledCount: 0,
    countsByAccount: {},
    sync: { status: "idle" },
    telemetry: { enabled: false, lockedByEnvironment: false },
    preferences: {
      appearance: "system",
      dockBadge: true,
      openNextAfterArchive: true,
      blockRemoteImages: true,
      imageRelay: true,
      undoSendDelaySeconds: 10,
    },
    license: {
      plan: "personal",
      maxMembers: 1,
      maxAccounts: 3,
      canUsePrivateImageRelay,
    },
  };
}
