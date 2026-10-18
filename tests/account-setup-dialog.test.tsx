/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSetupDialog } from "../src/renderer/components/AccountSetupDialog";
import { Onboarding } from "../src/renderer/components/Onboarding";
import type { AccountInfo, FluxmailDesktopApi } from "../src/shared/contracts";

afterEach(cleanup);

const imapAccount: AccountInfo = {
  id: "acct_imap",
  email: "me@icloud.com",
  provider: "imap",
  status: "active",
};
const outlookAccount: AccountInfo = {
  id: "acct_outlook",
  email: "me@outlook.com",
  provider: "outlook",
  status: "active",
};
const redirectUri = "http://localhost:8976/oauth/microsoft/callback";

describe("AccountSetupDialog IMAP", () => {
  it("suggests servers from the address and connects with them", async () => {
    const accounts = installApi({
      connectImap: vi.fn(async () => ({ account: imapAccount, warnings: [] })),
    });
    const onConnected = vi.fn();
    render(<AccountSetupDialog provider="imap" onConnected={onConnected} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "me@icloud.com" },
    });
    expect(screen.getByLabelText("IMAP server")).toHaveValue("imap.mail.me.com");
    expect(screen.getByLabelText("SMTP server")).toHaveValue("smtp.mail.me.com");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "app-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(imapAccount));
    expect(accounts.connectImap).toHaveBeenCalledWith({
      email: "me@icloud.com",
      imap: {
        host: "imap.mail.me.com",
        port: 993,
        security: "tls",
        user: "me@icloud.com",
        password: "app-password",
      },
      smtp: {
        host: "smtp.mail.me.com",
        port: 587,
        security: "starttls",
        user: "me@icloud.com",
      },
      separateSmtpPassword: false,
    });
  });

  it("keeps hosts the user typed when the address changes", () => {
    installApi();
    render(<AccountSetupDialog provider="imap" onConnected={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("IMAP server"), {
      target: { value: "mail.example.net" },
    });
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "me@example.org" },
    });

    expect(screen.getByLabelText("IMAP server")).toHaveValue("mail.example.net");
  });

  it("shows the server's error and keeps the form open", async () => {
    installApi({
      connectImap: vi.fn(async () => {
        throw new Error("The IMAP server rejected the username or password.");
      }),
    });
    const onConnected = vi.fn();
    render(<AccountSetupDialog provider="imap" onConnected={onConnected} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "me@example.org" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The IMAP server rejected the username or password.",
    );
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("wrong");
  });

  it("shows folder warnings before closing", async () => {
    installApi({
      connectImap: vi.fn(async () => ({
        account: imapAccount,
        warnings: ["No Archive folder was found"],
      })),
    });
    const onConnected = vi.fn();
    render(<AccountSetupDialog provider="imap" onConnected={onConnected} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "me@icloud.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "app-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("No Archive folder was found")).toBeVisible();
    expect(onConnected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onConnected).toHaveBeenCalledWith(imapAccount);
  });

  it("reports onboarding setup open until folder warnings are dismissed", async () => {
    installApi({
      connectImap: vi.fn(async () => ({
        account: imapAccount,
        warnings: ["No Archive folder was found"],
      })),
    });
    const onConnected = vi.fn(async () => undefined);
    const onSetupOpenChange = vi.fn();
    render(<Onboarding onConnected={onConnected} onSetupOpenChange={onSetupOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect with IMAP" }));
    expect(onSetupOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "me@icloud.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "app-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("No Archive folder was found")).toBeVisible();
    expect(onSetupOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onSetupOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });

  it("prefills saved settings when reconnecting and keeps the saved password", async () => {
    const accounts = installApi({
      imapSettings: vi.fn(async () => ({
        email: "me@example.org",
        displayName: "Me",
        imap: { host: "mail.example.org", port: 143, security: "tls" as const, user: "me" },
        smtp: { host: "mail.example.org", port: 465, security: "tls" as const, user: "me" },
        separateSmtpPassword: false,
      })),
      connectImap: vi.fn(async () => ({ account: imapAccount, warnings: [] })),
    });
    render(
      <AccountSetupDialog
        provider="imap"
        reconnectAccountId="acct_imap"
        onConnected={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("Email address")).toHaveValue("me@example.org");
    expect(screen.getByLabelText("Email address")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("IMAP username")).toHaveValue("me");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(accounts.connectImap).toHaveBeenCalled());
    expect(accounts.connectImap).toHaveBeenCalledWith({
      email: "me@example.org",
      displayName: "Me",
      imap: { host: "mail.example.org", port: 143, security: "tls", user: "me" },
      smtp: { host: "mail.example.org", port: 465, security: "tls", user: "me" },
      separateSmtpPassword: false,
      reconnectAccountId: "acct_imap",
    });
  });
});

describe("AccountSetupDialog Outlook", () => {
  it("saves a Microsoft app and then signs in", async () => {
    const accounts = installApi({
      outlookSetup: vi.fn(async () => ({ configured: false, editable: true, redirectUri })),
      configureOutlook: vi.fn(async () => ({ configured: true, editable: true, redirectUri })),
      connect: vi.fn(async () => outlookAccount),
    });
    const onConnected = vi.fn();
    render(<AccountSetupDialog provider="outlook" onConnected={onConnected} onClose={vi.fn()} />);

    expect(await screen.findByText(redirectUri)).toBeVisible();
    expect(accounts.connect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Application (client) ID"), {
      target: { value: " 11111111-2222-3333-4444-555555555555 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and sign in" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(outlookAccount));
    expect(accounts.configureOutlook).toHaveBeenCalledWith({
      clientId: "11111111-2222-3333-4444-555555555555",
      tenantId: "common",
    });
    expect(accounts.connect).toHaveBeenCalledWith("outlook");
  });

  it("signs in right away when a Microsoft app is already set up", async () => {
    const accounts = installApi({
      outlookSetup: vi.fn(async () => ({ configured: true, editable: true, redirectUri })),
      connect: vi.fn(async () => outlookAccount),
    });
    const onConnected = vi.fn();
    render(<AccountSetupDialog provider="outlook" onConnected={onConnected} onClose={vi.fn()} />);

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(outlookAccount));
    expect(accounts.connect).toHaveBeenCalledTimes(1);
  });

  it("reconnects an existing Outlook account", async () => {
    const accounts = installApi({
      outlookSetup: vi.fn(async () => ({ configured: true, editable: true, redirectUri })),
      reconnect: vi.fn(async () => outlookAccount),
    });
    const onConnected = vi.fn();
    render(
      <AccountSetupDialog
        provider="outlook"
        reconnectAccountId="acct_outlook"
        onConnected={onConnected}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(outlookAccount));
    expect(accounts.reconnect).toHaveBeenCalledWith("acct_outlook");
    expect(accounts.connect).not.toHaveBeenCalled();
  });

  it("lets the user retry or change the app after sign-in fails", async () => {
    const accounts = installApi({
      outlookSetup: vi.fn(async () => ({ configured: true, editable: true, redirectUri })),
      connect: vi
        .fn<FluxmailDesktopApi["accounts"]["connect"]>()
        .mockRejectedValueOnce(new Error("Microsoft sign-in failed: AADSTS700016"))
        .mockResolvedValueOnce(outlookAccount),
    });
    const onConnected = vi.fn();
    render(<AccountSetupDialog provider="outlook" onConnected={onConnected} onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("AADSTS700016");
    fireEvent.click(screen.getByRole("button", { name: "Change Microsoft app" }));
    expect(screen.getByLabelText("Application (client) ID")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(outlookAccount));
    expect(accounts.connect).toHaveBeenCalledTimes(2);
  });
});

function installApi(
  overrides: Partial<Record<keyof FluxmailDesktopApi["accounts"], unknown>> = {},
) {
  const accounts = {
    connect: vi.fn(),
    connectImap: vi.fn(),
    imapSettings: vi.fn(),
    outlookSetup: vi.fn(),
    configureOutlook: vi.fn(),
    reconnect: vi.fn(),
    ...overrides,
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  Object.defineProperty(window, "fluxmail", {
    configurable: true,
    value: {
      accounts,
      system: { openExternal: vi.fn(async () => undefined) },
    } as unknown as FluxmailDesktopApi,
  });
  return accounts;
}
