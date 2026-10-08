import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EmailQuery, Message, ModifyAction } from "@fluxmail/core";
import Database from "better-sqlite3";
import {
  encryptString,
  IncompatibleStoreError,
  inspectStoreCompatibility,
  MAX_SUPPORTED_STORE_FORMAT,
  type StoreCompatibility,
} from "fluxmail";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAnalytics } from "../src/main/analytics";
import { MailCache } from "../src/main/cache";
import {
  FluxmailRuntime,
  prepareFluxmailConfiguration,
  shouldUseBundledGoogleConfig,
} from "../src/main/fluxmail-runtime";
import type { AccountInfo } from "../src/shared/contracts";
import { GMAIL_FULL_ACCESS_SCOPE, GMAIL_MODIFY_SCOPE } from "../src/main/oauth";

const account = {
  id: "account-1",
  email: "me@example.com",
  provider: "gmail" as const,
  status: "active" as const,
  canPermanentlyDelete: false,
};
const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("FluxmailRuntime account capabilities", () => {
  it("reads the latest permanent-delete grant from shared Gmail credentials", () => {
    const encryptionKey = Buffer.alloc(32, 7);
    let encryptedCredentials = encryptString(
      encryptionKey,
      JSON.stringify({ scope: GMAIL_MODIFY_SCOPE }),
    );
    const runtime = createRuntime({
      cache: {},
      service: {},
      onCacheChanged: vi.fn(),
    });
    const context = (
      runtime as unknown as {
        context: {
          config: Record<string, unknown>;
          db?: unknown;
        };
      }
    ).context;
    context.config.encryptionKey = encryptionKey;
    context.db = {
      $client: {
        prepare: vi.fn(() => ({
          get: vi.fn(() => ({ encrypted_credentials: encryptedCredentials })),
        })),
      },
    };

    expect(runtime.accounts()).toEqual([
      expect.objectContaining({ id: account.id, canPermanentlyDelete: false }),
    ]);

    encryptedCredentials = encryptString(
      encryptionKey,
      JSON.stringify({ scope: GMAIL_FULL_ACCESS_SCOPE }),
    );

    expect(runtime.accounts()).toEqual([
      expect.objectContaining({ id: account.id, canPermanentlyDelete: true }),
    ]);

    context.config.google = {
      clientId: "current-custom-client",
      clientSecret: "current-custom-secret",
    };
    encryptedCredentials = encryptString(encryptionKey, JSON.stringify({}));

    expect(runtime.accounts()).toEqual([
      expect.objectContaining({ id: account.id, canPermanentlyDelete: false }),
    ]);

    encryptedCredentials = encryptString(
      encryptionKey,
      JSON.stringify({ fluxmailOAuthClient: { clientId: "another-custom-client" } }),
    );

    expect(runtime.accounts()).toEqual([
      expect.objectContaining({ id: account.id, canPermanentlyDelete: false }),
    ]);
  });
});

describe("FluxmailRuntime license activation", () => {
  const licenseKey = `fluxmail_lic_${"ab".repeat(20)}`;

  it("stores a validated key and returns the updated plan", async () => {
    const runtime = createRuntime({ cache: {}, service: {}, onCacheChanged: vi.fn() });
    const internals = runtime as unknown as {
      fluxmail: ReturnType<typeof runtimeFluxmailModule>;
      context: {
        configuration: { setLicenseKey: ReturnType<typeof vi.fn> };
        licenseController: { wake: ReturnType<typeof vi.fn> };
      };
    };
    const refreshLicense = vi.fn(async () => ({
      outcome: "refreshed" as const,
      lease: {
        plan: "pro",
        maxMembers: 1,
        maxAccounts: 5,
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
    }));
    internals.fluxmail.refreshLicense = refreshLicense;
    internals.fluxmail.getEntitlements = vi.fn(() => ({
      plan: "pro",
      licensed: true,
      inGrace: false,
      maxMembers: 1,
      maxAccounts: 5,
    }));

    await expect(runtime.activateLicense(` ${licenseKey} `)).resolves.toEqual({
      outcome: "activated",
      license: {
        plan: "pro",
        maxMembers: 1,
        maxAccounts: 5,
        canUsePrivateImageRelay: true,
      },
    });
    expect(refreshLicense).toHaveBeenCalledWith(expect.anything(), {
      licenseKey,
      serverUrl: "https://license.test",
      dataDir: "/tmp/fluxmail",
    });
    expect(internals.context.configuration.setLicenseKey).toHaveBeenCalledWith(licenseKey);
    expect(internals.context.licenseController.wake).toHaveBeenCalledOnce();
  });

  it("saves a well-formed key for retry when the license server is unavailable", async () => {
    const runtime = createRuntime({ cache: {}, service: {}, onCacheChanged: vi.fn() });
    const internals = runtime as unknown as {
      fluxmail: ReturnType<typeof runtimeFluxmailModule>;
      context: {
        configuration: { setLicenseKey: ReturnType<typeof vi.fn> };
        licenseController: { wake: ReturnType<typeof vi.fn> };
      };
    };
    internals.fluxmail.refreshLicense = vi.fn(async () => ({
      outcome: "outage" as const,
      message: "offline",
      cachedLeaseActive: false,
    }));

    await expect(runtime.activateLicense(licenseKey)).resolves.toMatchObject({
      outcome: "saved_for_retry",
      license: { plan: "personal" },
    });
    expect(internals.context.configuration.setLicenseKey).toHaveBeenCalledOnce();
    expect(internals.context.licenseController.wake).toHaveBeenCalledOnce();
  });

  it("does not store malformed, rejected, or environment-managed keys", async () => {
    const runtime = createRuntime({ cache: {}, service: {}, onCacheChanged: vi.fn() });
    const internals = runtime as unknown as {
      fluxmail: ReturnType<typeof runtimeFluxmailModule>;
      context: {
        config: { licenseKeyFromEnvironment?: boolean };
        configuration: { setLicenseKey: ReturnType<typeof vi.fn> };
        licenseController: { wake: ReturnType<typeof vi.fn> };
      };
    };

    await expect(runtime.activateLicense("not-a-license")).rejects.toThrow("does not look right");
    expect(internals.fluxmail.refreshLicense).not.toHaveBeenCalled();

    internals.fluxmail.refreshLicense = vi.fn(async () => ({
      outcome: "in_use" as const,
      message: "in use",
      cachedLeaseActive: false,
    }));
    await expect(runtime.activateLicense(licenseKey)).rejects.toThrow(
      "active on another Fluxmail instance",
    );
    expect(internals.context.configuration.setLicenseKey).not.toHaveBeenCalled();
    expect(internals.context.licenseController.wake).not.toHaveBeenCalled();

    internals.context.config.licenseKeyFromEnvironment = true;
    await expect(runtime.activateLicense(licenseKey)).rejects.toThrow(
      "managed by FLUXMAIL_LICENSE_KEY",
    );
  });
});

describe("FluxmailRuntime private image relay license", () => {
  it("exposes and returns the signed lease for a current paid plan", async () => {
    const runtime = createRuntime({
      cache: {},
      service: {},
      onCacheChanged: vi.fn(),
    });
    const entitlements = {
      plan: "team",
      licensed: true,
      inGrace: false,
      maxMembers: 5,
      maxAccounts: 10,
    };
    const verifyLease = vi.fn();
    Object.assign(runtime, {
      fluxmail: {
        ...runtimeFluxmailModule(),
        getEntitlements: vi.fn(() => entitlements),
        checkLicenseState: vi.fn(() => ({ entitlements })),
        readLeaseRow: vi.fn(() => ({ token: "signed-license-lease", updatedAt: Date.now() })),
        verifyLease,
        licensePublicKeys: vi.fn(() => ["public-key"]),
      },
    });

    expect(runtime.license()).toMatchObject({
      plan: "team",
      canUsePrivateImageRelay: true,
    });
    await expect(runtime.imageRelayLicenseLease()).resolves.toBe("signed-license-lease");
    expect(verifyLease).toHaveBeenCalledWith("signed-license-lease", ["public-key"]);
  });

  it("refreshes a stale lease but does not use the licensing grace period", async () => {
    const onLicenseChanged = vi.fn();
    const runtime = createRuntime({
      cache: {},
      service: {},
      onCacheChanged: vi.fn(),
      onLicenseChanged,
    });
    const internals = runtime as unknown as {
      fluxmail: Record<string, unknown>;
      context: { licenseController: { refreshNow: ReturnType<typeof vi.fn> } };
    };
    const inGrace = {
      plan: "pro",
      licensed: true,
      inGrace: true,
      maxMembers: 1,
      maxAccounts: 5,
    };
    internals.fluxmail = {
      ...runtimeFluxmailModule(),
      getEntitlements: vi.fn(() => inGrace),
      readLeaseRow: vi.fn(() => ({ token: "expired-lease", updatedAt: Date.now() })),
    };
    internals.context.licenseController.refreshNow = vi.fn(async () => undefined);

    await expect(runtime.imageRelayLicenseLease()).rejects.toThrow(
      "available on Pro, Team, and Enterprise",
    );
    expect(internals.context.licenseController.refreshNow).toHaveBeenCalledOnce();
    expect(onLicenseChanged).toHaveBeenCalledOnce();
  });

  it("notifies the renderer after refreshing an unusable cached lease", async () => {
    const onLicenseChanged = vi.fn();
    const runtime = createRuntime({
      cache: {},
      service: {},
      onCacheChanged: vi.fn(),
      onLicenseChanged,
    });
    const inGrace = {
      plan: "pro",
      licensed: true,
      inGrace: true,
      maxMembers: 1,
      maxAccounts: 5,
    };
    const current = { ...inGrace, inGrace: false };
    let entitlements = inGrace;
    let finishRefresh!: (value: { outcome: "refreshed" }) => void;
    const refreshNow = vi.fn(
      () =>
        new Promise<{ outcome: "refreshed" }>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const internals = runtime as unknown as {
      fluxmail: Record<string, unknown>;
      context: {
        licenseController: {
          configuredKey(): string;
          refreshNow: typeof refreshNow;
        };
      };
    };
    internals.fluxmail = {
      ...runtimeFluxmailModule(),
      getEntitlements: vi.fn(() => entitlements),
      checkLicenseState: vi.fn(() => ({ entitlements })),
    };
    internals.context.licenseController = {
      configuredKey: () => "configured-license-key",
      refreshNow,
    };

    expect(runtime.license().canUsePrivateImageRelay).toBe(false);
    expect(refreshNow).toHaveBeenCalledOnce();
    entitlements = current;
    finishRefresh({ outcome: "refreshed" });

    await vi.waitFor(() => expect(onLicenseChanged).toHaveBeenCalledOnce());
    expect(runtime.license().canUsePrivateImageRelay).toBe(true);
    expect(refreshNow).toHaveBeenCalledOnce();
  });

  it("disables relay access after a server denial and restores it after revalidation", async () => {
    const onLicenseChanged = vi.fn();
    const runtime = createRuntime({
      cache: {},
      service: {},
      onCacheChanged: vi.fn(),
      onLicenseChanged,
    });
    const entitlements = {
      plan: "pro",
      licensed: true,
      inGrace: false,
      maxMembers: 1,
      maxAccounts: 5,
    };
    let finishRefresh!: (value: { outcome: "refreshed" }) => void;
    const refreshNow = vi.fn(
      () =>
        new Promise<{ outcome: "refreshed" }>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const internals = runtime as unknown as {
      fluxmail: Record<string, unknown>;
      context: {
        licenseController: {
          configuredKey(): string;
          refreshNow: typeof refreshNow;
        };
      };
    };
    internals.fluxmail = {
      ...runtimeFluxmailModule(),
      getEntitlements: vi.fn(() => entitlements),
      checkLicenseState: vi.fn(() => ({ entitlements })),
    };
    internals.context.licenseController = {
      configuredKey: () => "configured-license-key",
      refreshNow,
    };

    expect(runtime.license().canUsePrivateImageRelay).toBe(true);
    runtime.imageRelayAccessDenied();
    expect(onLicenseChanged).toHaveBeenCalledOnce();
    expect(runtime.license().canUsePrivateImageRelay).toBe(false);
    expect(refreshNow).toHaveBeenCalledOnce();

    finishRefresh({ outcome: "refreshed" });

    await vi.waitFor(() => expect(onLicenseChanged).toHaveBeenCalledTimes(2));
    expect(runtime.license().canUsePrivateImageRelay).toBe(true);
    expect(refreshNow).toHaveBeenCalledOnce();
  });
});

describe("FluxmailRuntime thread loading", () => {
  it("paginates with provider tokens when messages collapse into fewer threads", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      inboxMessage({
        id: `message-${index}`,
        threadId: "thread-one",
        date: `2026-07-16T12:${String(index % 60).padStart(2, "0")}:00Z`,
      }),
    );
    const historical = inboxMessage({
      id: "historical",
      threadId: "thread-two",
      date: "2026-07-15T12:00:00Z",
    });
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: firstPage, nextPageToken: "page-2" })
      .mockResolvedValueOnce({ items: [historical] });
    const onCacheChanged = vi.fn();
    const onNewMessages = vi.fn();
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: { listMessages },
      onCacheChanged,
      onNewMessages,
    });

    const first = await runtime.listThreads({ view: "inbox", pageSize: 100 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe("1");
    expect(listMessages).toHaveBeenCalledOnce();

    const cached = await runtime.listThreads({ view: "inbox", pageSize: 100 });
    expect(cached.items).toHaveLength(1);
    expect(listMessages).toHaveBeenCalledOnce();

    const second = await runtime.listThreads({
      view: "inbox",
      cursor: first.nextCursor,
      pageSize: 100,
    });
    expect(second.items.map((item) => item.id)).toEqual(["thread-two"]);
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(listMessages.mock.calls[1]?.[2]).toMatchObject({
      pageToken: "page-2",
    });
    expect(onNewMessages).not.toHaveBeenCalled();
    expect(onCacheChanged).toHaveBeenCalledTimes(2);
  });

  it("keeps provider search results that do not match cached summary text", async () => {
    const listMessages = vi.fn(async (_accountId: string, _query: EmailQuery) => ({
      items: [
        inboxMessage({
          id: "attachment",
          threadId: "attachment-thread",
          subject: "Quarterly report",
          snippet: "The report is ready.",
        }),
      ],
    }));
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: { listMessages },
      onCacheChanged: vi.fn(),
    });
    const input = {
      view: "search" as const,
      query: "has:attachment",
      pageSize: 100,
    };

    const providerResult = await runtime.listThreads(input, true);
    expect(providerResult.items.map((item) => item.id)).toEqual(["attachment-thread"]);
    const cachedResult = await runtime.listThreads(input);
    expect(cachedResult.items.map((item) => item.id)).toEqual(["attachment-thread"]);
    expect(listMessages).toHaveBeenCalledOnce();
    expect(listMessages.mock.calls[0]?.[1]).toEqual({ hasAttachment: true });
  });

  it("keeps cached threads when a forced refresh fails", async () => {
    const sent = inboxMessage({
      id: "sent-message",
      threadId: "sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [sent] })
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: { listMessages },
      onCacheChanged: vi.fn(),
    });

    await runtime.listThreads({ view: "sent", pageSize: 100 });
    const fallback = await runtime.listThreads({
      view: "sent",
      pageSize: 100,
      refresh: true,
    });

    expect(fallback.items.map((item) => item.id)).toEqual(["sent-thread"]);
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it("waits for the provider when a background refresh has no initialized cache", async () => {
    const sent = inboxMessage({
      id: "first-sent-message",
      threadId: "first-sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    const listMessages = vi.fn().mockResolvedValue({ items: [sent] });
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: { listMessages },
      onCacheChanged: vi.fn(),
    });

    const result = await runtime.listThreads({
      view: "sent",
      pageSize: 100,
      backgroundRefresh: true,
    });

    expect(result.items.map((item) => item.id)).toEqual(["first-sent-thread"]);
    expect(listMessages).toHaveBeenCalledOnce();
  });

  it("uses an earlier successful page when a newer refresh fails", async () => {
    const sent = inboxMessage({
      id: "sent-message",
      threadId: "sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    let finishInitialLoad!: (page: { items: Message[] }) => void;
    const pendingInitialLoad = new Promise<{ items: Message[] }>((resolve) => {
      finishInitialLoad = resolve;
    });
    const listMessages = vi
      .fn()
      .mockReturnValueOnce(pendingInitialLoad)
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    const onCacheChanged = vi.fn();
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: { listMessages },
      onCacheChanged,
    });

    const initialLoad = runtime.listThreads({ view: "sent" });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledOnce());
    await expect(runtime.listThreads({ view: "sent", refresh: true })).rejects.toThrow(
      "Provider unavailable",
    );

    finishInitialLoad({ items: [sent] });
    const result = await initialLoad;

    expect(result.items.map((item) => item.id)).toEqual(["sent-thread"]);
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });

  it("returns an initialized mailbox from cache while refreshing it in the background", async () => {
    const cachedSent = inboxMessage({
      id: "cached-sent-message",
      threadId: "cached-sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    const freshSent = inboxMessage({
      id: "fresh-sent-message",
      threadId: "fresh-sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    let finishRefresh!: (page: { items: Message[] }) => void;
    const pendingRefresh = new Promise<{ items: Message[] }>((resolve) => {
      finishRefresh = resolve;
    });
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [cachedSent] })
      .mockReturnValueOnce(pendingRefresh);
    const onCacheChanged = vi.fn();
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: { listMessages },
      onCacheChanged,
    });

    await runtime.listThreads({ view: "sent", pageSize: 100 });
    const backgroundResult = await runtime.listThreads({
      view: "sent",
      pageSize: 100,
      backgroundRefresh: true,
    });

    expect(backgroundResult.items.map((item) => item.id)).toEqual(["cached-sent-thread"]);
    expect(listMessages).toHaveBeenCalledTimes(2);

    finishRefresh({ items: [freshSent] });
    await vi.waitFor(() => expect(onCacheChanged).toHaveBeenCalledTimes(2));
    const refreshedResult = await runtime.listThreads({ view: "sent", pageSize: 100 });
    expect(refreshedResult.items.map((item) => item.id)).toEqual(["fresh-sent-thread"]);
  });

  it("keeps a newer refresh when an older background request finishes last", async () => {
    const cachedSent = inboxMessage({
      id: "cached-sent-message",
      threadId: "cached-sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    const staleSent = inboxMessage({
      id: "stale-sent-message",
      threadId: "stale-sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    const freshSent = inboxMessage({
      id: "fresh-sent-message",
      threadId: "fresh-sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    let finishBackgroundRefresh!: (page: { items: Message[] }) => void;
    const pendingBackgroundRefresh = new Promise<{ items: Message[] }>((resolve) => {
      finishBackgroundRefresh = resolve;
    });
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [cachedSent] })
      .mockReturnValueOnce(pendingBackgroundRefresh)
      .mockResolvedValueOnce({ items: [freshSent] });
    const onCacheChanged = vi.fn();
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: { listMessages },
      onCacheChanged,
    });

    await runtime.listThreads({ view: "sent" });
    await runtime.listThreads({ view: "sent", backgroundRefresh: true });
    const refreshedResult = await runtime.listThreads({ view: "sent", refresh: true });
    expect(refreshedResult.items.map((item) => item.id)).toEqual(["fresh-sent-thread"]);

    finishBackgroundRefresh({ items: [staleSent] });
    const settledResult = await runtime.listThreads({ view: "sent", cursor: "0" });

    expect(settledResult.items.map((item) => item.id)).toEqual(["fresh-sent-thread"]);
    expect(listMessages).toHaveBeenCalledTimes(3);
    expect(onCacheChanged).toHaveBeenCalledTimes(2);
  });

  it("does not reuse stale later pages after a non-inbox view refresh", async () => {
    const oldFirst = inboxMessage({
      id: "old-first-message",
      threadId: "old-first-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
      date: "2026-07-16T14:00:00Z",
    });
    const oldSecond = inboxMessage({
      id: "old-second-message",
      threadId: "old-second-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
      date: "2026-07-16T13:00:00Z",
    });
    const newFirst = inboxMessage({
      id: "new-first-message",
      threadId: "new-first-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
      date: "2026-07-16T16:00:00Z",
    });
    const newSecond = inboxMessage({
      id: "new-second-message",
      threadId: "new-second-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
      date: "2026-07-16T15:00:00Z",
    });
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [oldFirst], nextPageToken: "old-page-2" })
      .mockResolvedValueOnce({ items: [oldSecond] })
      .mockResolvedValueOnce({ items: [newFirst], nextPageToken: "new-page-2" })
      .mockResolvedValueOnce({ items: [newSecond] });
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: { listMessages },
      onCacheChanged: vi.fn(),
    });

    const firstPage = await runtime.listThreads({ view: "sent", pageSize: 1 });
    expect(firstPage.items.map((item) => item.id)).toEqual(["old-first-thread"]);
    expect(
      (
        await runtime.listThreads({
          view: "sent",
          cursor: firstPage.nextCursor,
          pageSize: 1,
        })
      ).items.map((item) => item.id),
    ).toEqual(["old-second-thread"]);

    const refreshed = await runtime.listThreads({
      view: "sent",
      pageSize: 1,
      refresh: true,
    });
    expect(refreshed.items.map((item) => item.id)).toEqual(["new-first-thread"]);
    expect(
      (
        await runtime.listThreads({
          view: "sent",
          cursor: refreshed.nextCursor,
          pageSize: 1,
        })
      ).items.map((item) => item.id),
    ).toEqual(["new-second-thread"]);
    expect(listMessages).toHaveBeenCalledTimes(4);
    expect(listMessages.mock.calls[3]?.[2]).toMatchObject({
      pageToken: "new-page-2",
    });
  });

  it("keeps refreshing healthy accounts when another account fails", async () => {
    const healthyAccount: AccountInfo = {
      id: "account-2",
      email: "healthy@example.com",
      provider: "gmail",
      status: "active",
    };
    const listFolders = vi.fn(async (accountId: string) => {
      if (accountId === account.id) throw new Error("Reconnect this account");
      return [{ id: "INBOX", name: "Inbox", role: "inbox" as const }];
    });
    const listMessages = vi.fn(async (accountId: string) => {
      if (accountId === account.id) throw new Error("Reconnect this account");
      return {
        items: [
          inboxMessage({
            id: "healthy-message",
            threadId: "healthy-thread",
            accountId: healthyAccount.id,
          }),
        ],
      };
    });
    const cache = createCache();
    const runtime = createRuntimeWithCache({
      cache,
      accounts: [account, healthyAccount],
      service: { listFolders, listMessages },
      onCacheChanged: vi.fn(),
    });

    await expect(runtime.refresh("poll")).resolves.toBe(1);
    expect(
      cache.listThreads({
        view: "inbox",
        accountIds: [healthyAccount.id],
        offset: 0,
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(listFolders).toHaveBeenCalledTimes(2);
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it("does not spin when only the account with a next page fails", async () => {
    const exhaustedAccount: AccountInfo = {
      id: "account-2",
      email: "exhausted@example.com",
      provider: "gmail",
      status: "active",
    };
    const cache = createCache();
    cache.setPageToken(account.id, "inbox::", "next-page");
    cache.setPageToken(exhaustedAccount.id, "inbox::");
    const listMessages = vi.fn(async () => {
      throw new Error("Provider unavailable");
    });
    const runtime = createRuntimeWithCache({
      cache,
      accounts: [account, exhaustedAccount],
      service: { listMessages },
      onCacheChanged: vi.fn(),
    });

    await expect(runtime.listThreads({ view: "inbox" })).rejects.toThrow("Provider unavailable");
    expect(listMessages).toHaveBeenCalledOnce();
  });

  it("refreshes the active mailbox as well as Inbox", async () => {
    const listMessages = vi.fn(async (_accountId: string, _query: { folder?: string }) => ({
      items: [],
    }));
    const runtime = createRuntimeWithCache({
      cache: createCache(),
      service: {
        listFolders: vi.fn(async () => [{ id: "INBOX", name: "Inbox", role: "inbox" as const }]),
        listMessages,
      },
      onCacheChanged: vi.fn(),
    });

    await runtime.refresh("manual", { view: "sent", pageSize: 100 });

    expect(listMessages.mock.calls.map((call) => call[1])).toEqual([
      { folder: "inbox" },
      { folder: "drafts" },
      { folder: "sent" },
    ]);
  });

  it("loads every Drafts page during startup so the count is complete", async () => {
    const cache = createCache();
    cache.putMessages(account, [
      inboxMessage({
        id: "deleted-draft",
        threadId: "deleted-draft-thread",
        folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
        flags: { read: true, starred: false, draft: true },
      }),
    ]);
    const listMessages = vi.fn(
      async (_accountId: string, query: { folder?: string }, page?: { pageToken?: string }) => {
        if (query.folder === "inbox") return { items: [] };
        if (!page?.pageToken)
          return {
            items: [
              inboxMessage({
                id: "draft-1",
                threadId: "draft-thread-1",
                folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
                flags: { read: true, starred: false, draft: true },
              }),
            ],
            nextPageToken: "draft-page-2",
          };
        return {
          items: [
            inboxMessage({
              id: "draft-2",
              threadId: "draft-thread-2",
              folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
              flags: { read: true, starred: false, draft: true },
            }),
          ],
        };
      },
    );
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        listFolders: vi.fn(async () => [{ id: "INBOX", name: "Inbox", role: "inbox" as const }]),
        listMessages,
      },
      onCacheChanged: vi.fn(),
    });

    await runtime.refresh("startup");

    expect(cache.draftCount()).toBe(2);
    expect(listMessages).toHaveBeenCalledTimes(3);
  });

  it("uses provider folder totals for unread counts", () => {
    const cache = createCache();
    cache.putMessages(account, [inboxMessage()]);
    cache.putFolders(account.id, [{ id: "INBOX", name: "Inbox", role: "inbox", unreadCount: 237 }]);
    const runtime = createRuntimeWithCache({
      cache,
      service: {},
      onCacheChanged: vi.fn(),
    });

    expect(runtime.unreadCount()).toBe(237);
  });
});

describe("FluxmailRuntime conversation mutations", () => {
  it("does not let stale body hydration overwrite an optimistic mark-read", async () => {
    const cache = createCache();
    const remote = inboxMessage({ id: "message-1", threadId: "thread-1" });
    cache.putMessages(account, [structuredClone(remote)]);
    let finishHydration!: (thread: { id: string; subject: string; messages: Message[] }) => void;
    let finishProviderMutation!: () => void;
    const hydration = new Promise<{
      id: string;
      subject: string;
      messages: Message[];
    }>((resolve) => {
      finishHydration = resolve;
    });
    const providerMutation = new Promise<void>((resolve) => {
      finishProviderMutation = resolve;
    });
    const getThread = vi
      .fn()
      .mockImplementationOnce(() => hydration)
      .mockImplementation(async () => ({
        id: remote.threadId,
        subject: remote.subject,
        messages: [structuredClone(remote)],
      }));
    const modify = vi.fn(async () => {
      await providerMutation;
      remote.flags.read = true;
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: { getThread, modify },
      onCacheChanged: vi.fn(),
    });

    const bodyLoad = runtime.getThread(account.id, remote.threadId);
    await vi.waitFor(() => expect(getThread).toHaveBeenCalledTimes(1));
    const mutation = runtime.modify(
      [{ accountId: account.id, threadId: remote.threadId }],
      { type: "markRead" },
      false,
    );
    await vi.waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    expect(cache.snapshotThread(account.id, remote.threadId)?.unread).toBe(0);

    finishHydration({
      id: remote.threadId,
      subject: remote.subject,
      messages: [structuredClone(remote)],
    });
    await bodyLoad;
    expect(cache.snapshotThread(account.id, remote.threadId)?.unread).toBe(0);

    finishProviderMutation();
    await mutation;
    expect(cache.snapshotThread(account.id, remote.threadId)?.unread).toBe(0);
  });

  it("does not let an older failed mutation roll back a newer action", async () => {
    const cache = createCache();
    const remote = inboxMessage({ id: "message-1", threadId: "thread-1" });
    cache.putMessages(account, [structuredClone(remote)]);
    let rejectOlder!: (error: Error) => void;
    let finishNewer!: () => void;
    const olderProviderCall = new Promise<void>((_resolve, reject) => {
      rejectOlder = reject;
    });
    const newerProviderCall = new Promise<void>((resolve) => {
      finishNewer = resolve;
    });
    const modify = vi
      .fn()
      .mockImplementationOnce(() => olderProviderCall)
      .mockImplementationOnce(async () => {
        remote.flags.starred = true;
        await newerProviderCall;
      });
    const getThread = vi.fn(async () => ({
      id: remote.threadId,
      subject: remote.subject,
      messages: [structuredClone(remote)],
    }));
    const runtime = createRuntimeWithCache({
      cache,
      service: { getThread, modify },
      onCacheChanged: vi.fn(),
    });

    const older = runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "markRead",
    });
    await vi.waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    const newer = runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "star",
    });

    expect(cache.snapshotThread(account.id, remote.threadId)).toMatchObject({
      unread: 0,
      starred: 1,
    });
    rejectOlder(new Error("The older action failed"));
    await expect(older).rejects.toThrow("The older action failed");
    await vi.waitFor(() => expect(modify).toHaveBeenCalledTimes(2));

    expect(cache.snapshotThread(account.id, remote.threadId)).toMatchObject({
      unread: 0,
      starred: 1,
    });
    finishNewer();
    await newer;

    expect(cache.snapshotThread(account.id, remote.threadId)).toMatchObject({
      unread: 1,
      starred: 1,
    });
    expect(getThread).toHaveBeenCalledTimes(3);
  });

  it("undoes only the most recent action and consumes its token", async () => {
    const cache = createCache();
    const remote = inboxMessage({ id: "message-1", threadId: "thread-1" });
    cache.putMessages(account, [structuredClone(remote)]);
    const modify = vi.fn(async (_accountId: string, _ids: string[], action: ModifyAction) => {
      if (action === "star") remote.flags.starred = true;
      if (action === "unstar") remote.flags.starred = false;
      if (action === "markRead") remote.flags.read = true;
      if (action === "markUnread") remote.flags.read = false;
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread: vi.fn(async () => ({
          id: remote.threadId,
          subject: remote.subject,
          messages: [structuredClone(remote)],
        })),
        modify,
      },
      onCacheChanged: vi.fn(),
    });

    const first = await runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "star",
    });
    const second = await runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "markRead",
    });

    expect(first.undoToken).toBeTruthy();
    expect(second.undoToken).toBeTruthy();
    await expect(runtime.undo(first.undoToken!)).resolves.toEqual({ undone: false });
    await expect(runtime.undo(second.undoToken!)).resolves.toEqual({ undone: true });
    await expect(runtime.undo(second.undoToken!)).resolves.toEqual({ undone: false });
    expect(remote.flags).toMatchObject({ read: false, starred: true });
    expect(cache.snapshotThread(account.id, remote.threadId)).toMatchObject({
      unread: 1,
      starred: 1,
    });
    expect(modify.mock.calls.map((call) => call[2])).toEqual(["star", "markRead", "markUnread"]);
  });

  it("undoes only the fields changed by the original action", async () => {
    const cache = createCache();
    const remote = inboxMessage({
      id: "message-1",
      threadId: "thread-1",
      labels: ["Customer"],
    });
    cache.putMessages(account, [structuredClone(remote)]);
    const modify = vi.fn(async (_accountId: string, _ids: string[], action: ModifyAction) => {
      if (action === "star") remote.flags.starred = true;
      if (action === "unstar") remote.flags.starred = false;
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread: vi.fn(async () => ({
          id: remote.threadId,
          subject: remote.subject,
          messages: [structuredClone(remote)],
        })),
        modify,
      },
      onCacheChanged: vi.fn(),
    });

    const result = await runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "star",
    });
    remote.flags.read = true;
    remote.labels = ["Customer", "Updated elsewhere"];

    await expect(runtime.undo(result.undoToken!)).resolves.toEqual({ undone: true });
    expect(remote.flags).toMatchObject({ read: true, starred: false });
    expect(remote.labels).toEqual(["Customer", "Updated elsewhere"]);
    expect(cache.snapshotThread(account.id, remote.threadId)).toMatchObject({
      unread: 0,
      starred: 0,
      labels_json: JSON.stringify(["Customer", "Updated elsewhere"]),
    });
    expect(modify.mock.calls.map((call) => call[2])).toEqual(["star", "unstar"]);
  });

  it("restores the complete cached thread when undo fails offline", async () => {
    const cache = createCache();
    const remote = inboxMessage({
      id: "message-1",
      threadId: "thread-1",
      body: { text: "Current provider body" },
    });
    cache.putMessages(account, [structuredClone(remote)]);
    let offline = false;
    const getThread = vi.fn(async () => {
      if (offline) throw new Error("The provider is offline");
      return {
        id: remote.threadId,
        subject: remote.subject,
        messages: [structuredClone(remote)],
      };
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread,
        modify: vi.fn(async (_accountId: string, _ids: string[], action: ModifyAction) => {
          if (action === "star") remote.flags.starred = true;
        }),
      },
      onCacheChanged: vi.fn(),
    });

    const result = await runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "star",
    });
    expect(cache.getThread(account.id, remote.threadId)?.messages[0]?.flags.starred).toBe(true);

    offline = true;
    await expect(runtime.undo(result.undoToken!)).rejects.toThrow("The provider is offline");

    expect(cache.snapshotThread(account.id, remote.threadId)?.starred).toBe(1);
    expect(cache.getThread(account.id, remote.threadId)?.messages[0]).toMatchObject({
      flags: { starred: true },
      body: { text: "Current provider body" },
    });
  });

  it("undoes only labels added by the original action", async () => {
    const cache = createCache();
    const remote = inboxMessage({
      id: "message-1",
      threadId: "thread-1",
      labels: ["Existing"],
    });
    cache.putMessages(account, [structuredClone(remote)]);
    const modify = vi.fn(async (_accountId: string, _ids: string[], action: ModifyAction) => {
      if (typeof action !== "object") return;
      if ("addLabels" in action)
        remote.labels = [...new Set([...(remote.labels ?? []), ...action.addLabels])];
      if ("removeLabels" in action)
        remote.labels = (remote.labels ?? []).filter(
          (label) => !action.removeLabels.includes(label),
        );
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread: vi.fn(async () => ({
          id: remote.threadId,
          subject: remote.subject,
          messages: [structuredClone(remote)],
        })),
        modify,
      },
      onCacheChanged: vi.fn(),
    });

    const result = await runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "addLabels",
      labels: ["Action label"],
    });
    remote.labels = [...(remote.labels ?? []), "Updated elsewhere"];

    await expect(runtime.undo(result.undoToken!)).resolves.toEqual({ undone: true });
    expect(remote.labels).toEqual(["Existing", "Updated elsewhere"]);
    expect(modify.mock.calls.map((call) => call[2])).toEqual([
      { addLabels: ["Action label"] },
      { removeLabels: ["Action label"] },
    ]);
  });

  it("does not offer undo when a successful action cannot rehydrate its target", async () => {
    const cache = createCache();
    const remote = inboxMessage({ id: "message-1", threadId: "thread-1" });
    cache.putMessages(account, [structuredClone(remote)]);
    const getThread = vi
      .fn()
      .mockResolvedValueOnce({
        id: remote.threadId,
        subject: remote.subject,
        messages: [structuredClone(remote)],
      })
      .mockRejectedValueOnce(new Error("The moved message has no known provider location"));
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread,
        modify: vi.fn(async () => undefined),
      },
      onCacheChanged: vi.fn(),
    });

    await expect(
      runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
        type: "archive",
      }),
    ).resolves.toEqual({});
    expect(getThread).toHaveBeenCalledTimes(2);
  });

  it("restores Gmail flags without modifying their system labels", async () => {
    const cache = createCache();
    const remote = inboxMessage({
      id: "message-1",
      threadId: "thread-1",
      labels: ["INBOX", "UNREAD"],
    });
    cache.putMessages(account, [structuredClone(remote)]);
    const modify = vi.fn(async (_accountId: string, _ids: string[], action: ModifyAction) => {
      if (action === "markRead") {
        remote.flags.read = true;
        remote.labels = ["INBOX"];
      }
      if (action === "markUnread") {
        remote.flags.read = false;
        remote.labels = ["INBOX", "UNREAD"];
      }
      if (typeof action === "object") throw new Error("Gmail rejected a system-label change");
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread: vi.fn(async () => ({
          id: remote.threadId,
          subject: remote.subject,
          messages: [structuredClone(remote)],
        })),
        modify,
      },
      onCacheChanged: vi.fn(),
    });

    const result = await runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "markRead",
    });

    await expect(runtime.undo(result.undoToken!)).resolves.toEqual({ undone: true });
    expect(modify.mock.calls.map((call) => call[2])).toEqual(["markRead", "markUnread"]);
  });

  it("undoes trash for Gmail Sent messages without moving to the reserved Sent role", async () => {
    const cache = createCache();
    const remote = inboxMessage({
      id: "message-1",
      threadId: "thread-1",
      folder: { id: "SENT", name: "Sent", role: "sent" },
    });
    cache.putMessages(account, [structuredClone(remote)]);
    const modify = vi.fn(async (_accountId: string, _ids: string[], action: ModifyAction) => {
      if (action === "trash") remote.folder = { id: "TRASH", name: "Trash", role: "trash" };
      if (action === "untrash") remote.folder = { id: "SENT", name: "Sent", role: "sent" };
      if (typeof action === "object" && "move" in action && action.move.toLowerCase() === "sent")
        throw new Error("Gmail does not allow moving to Sent");
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread: vi.fn(async () => ({
          id: remote.threadId,
          subject: remote.subject,
          messages: [structuredClone(remote)],
        })),
        modify,
      },
      onCacheChanged: vi.fn(),
    });

    const result = await runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "trash",
    });

    await expect(runtime.undo(result.undoToken!)).resolves.toEqual({ undone: true });
    expect(modify.mock.calls.map((call) => call[2])).toEqual(["trash", "untrash", "archive"]);
    expect(cache.snapshotThread(account.id, remote.threadId)?.folder_roles_json).toBe(
      JSON.stringify(["sent"]),
    );
  });

  it("invalidates undo when its account is removed", async () => {
    const cache = createCache();
    const remote = inboxMessage({ id: "message-1", threadId: "thread-1" });
    cache.putMessages(account, [structuredClone(remote)]);
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread: vi.fn(async () => ({
          id: remote.threadId,
          subject: remote.subject,
          messages: [structuredClone(remote)],
        })),
        modify: vi.fn(async () => {
          remote.flags.starred = true;
        }),
      },
      onCacheChanged: vi.fn(),
    });
    const result = await runtime.modify([{ accountId: account.id, threadId: remote.threadId }], {
      type: "star",
    });

    runtime.removeAccount(account.id);

    await expect(runtime.undo(result.undoToken!)).resolves.toEqual({ undone: false });
    expect(cache.accountIds()).toEqual([]);
  });

  it("clears scheduled reconciliation timers when their account is removed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const cache = createCache();
    const listScheduled = vi.fn(() => {
      throw new Error("The removed account should not be queried.");
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        listScheduled,
        createDraft: vi.fn(async () => draftMessage()),
        scheduleSend: vi.fn(async (_accountId, input) => ({
          scheduleId: "schedule-1",
          accountId: account.id,
          draftId: input.draftId,
          sendAt: "2026-07-21T12:00:05.000Z",
          status: "pending" as const,
          attempts: 0,
        })),
      },
      onCacheChanged: vi.fn(),
    });

    await runtime.schedule({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Scheduled subject",
      text: "Scheduled body",
      sendAt: "2026-07-21T12:00:05.000Z",
    });
    runtime.removeAccount(account.id);

    await vi.advanceTimersByTimeAsync(5_100);

    expect(listScheduled).not.toHaveBeenCalled();
  });

  it("keeps the latest requested undo when account mutations finish out of order", async () => {
    const secondAccount: AccountInfo = {
      id: "account-2",
      email: "other@example.com",
      provider: "outlook",
      status: "active",
      canPermanentlyDelete: false,
    };
    const cache = createCache();
    const firstRemote = inboxMessage({ id: "message-1", threadId: "thread-1" });
    const secondRemote = inboxMessage({
      id: "message-2",
      threadId: "thread-2",
      accountId: secondAccount.id,
    });
    cache.putMessages(account, [structuredClone(firstRemote)]);
    cache.putMessages(secondAccount, [structuredClone(secondRemote)]);
    let finishFirst!: () => void;
    const firstProviderCall = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const modify = vi.fn(
      async (accountId: string, _ids: string[], action: ModifyAction): Promise<void> => {
        if (accountId === account.id) {
          await firstProviderCall;
          if (action === "markRead") firstRemote.flags.read = true;
          return;
        }
        if (action === "star") secondRemote.flags.starred = true;
        if (action === "unstar") secondRemote.flags.starred = false;
      },
    );
    const getThread = vi.fn(async (accountId: string, threadId: string) => {
      const remote = accountId === account.id ? firstRemote : secondRemote;
      expect(threadId).toBe(remote.threadId);
      return {
        id: remote.threadId,
        subject: remote.subject,
        messages: [structuredClone(remote)],
      };
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: { getThread, modify },
      accounts: [account, secondAccount],
      onCacheChanged: vi.fn(),
    });

    const first = runtime.modify([{ accountId: account.id, threadId: firstRemote.threadId }], {
      type: "markRead",
    });
    await vi.waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    const second = await runtime.modify(
      [{ accountId: secondAccount.id, threadId: secondRemote.threadId }],
      { type: "star" },
    );
    expect(second.undoToken).toBeTruthy();

    finishFirst();
    await expect(first).resolves.toEqual({});
    await expect(runtime.undo(second.undoToken!)).resolves.toEqual({ undone: true });
    expect(secondRemote.flags.starred).toBe(false);
  });

  it("does not let an older sync page overwrite a completed mutation", async () => {
    const cache = createCache();
    const unread = inboxMessage({ id: "message-1", threadId: "thread-1" });
    cache.putMessages(account, [unread]);
    let resolvePage: ((page: { items: Message[] }) => void) | undefined;
    const listMessages = vi.fn(
      () =>
        new Promise<{ items: Message[] }>((resolve) => {
          resolvePage = resolve;
        }),
    );
    let modified = false;
    const getThread = vi.fn(async () => ({
      id: "thread-1",
      subject: "Hello",
      messages: [
        inboxMessage({
          id: "message-1",
          threadId: "thread-1",
          flags: { read: modified, starred: false, draft: false },
        }),
      ],
    }));
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        listFolders: vi.fn(async () => [{ id: "INBOX", name: "Inbox", role: "inbox" as const }]),
        listMessages,
        getThread,
        modify: vi.fn(async () => {
          modified = true;
        }),
      },
      onCacheChanged: vi.fn(),
    });

    const refresh = runtime.refresh("poll");
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledOnce());
    await runtime.modify([{ accountId: account.id, threadId: "thread-1" }], {
      type: "markRead",
    });
    resolvePage?.({ items: [unread] });
    await refresh;

    expect(cache.snapshotThread(account.id, "thread-1")?.unread).toBe(0);
  });

  it("does not let an older folder response overwrite mutation counts", async () => {
    const cache = createCache();
    const unread = inboxMessage({ id: "message-1", threadId: "thread-1" });
    cache.putMessages(account, [unread]);
    cache.putFolders(account.id, [{ id: "INBOX", name: "Inbox", role: "inbox", unreadCount: 1 }]);
    let resolveFolders:
      | ((folders: Array<{ id: string; name: string; role: "inbox"; unreadCount: number }>) => void)
      | undefined;
    const listFolders = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Array<{ id: string; name: string; role: "inbox"; unreadCount: number }>>(
            (resolve) => {
              resolveFolders = resolve;
            },
          ),
      )
      .mockResolvedValueOnce([
        { id: "INBOX", name: "Inbox", role: "inbox" as const, unreadCount: 0 },
      ]);
    let modified = false;
    const getThread = vi.fn(async () => ({
      id: "thread-1",
      subject: "Hello",
      messages: [
        inboxMessage({
          id: "message-1",
          threadId: "thread-1",
          flags: { read: modified, starred: false, draft: false },
        }),
      ],
    }));
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        listFolders,
        listMessages: vi.fn(async () => ({
          items: [
            inboxMessage({
              id: "message-1",
              threadId: "thread-1",
              flags: { read: true, starred: false, draft: false },
            }),
          ],
        })),
        getThread,
        modify: vi.fn(async () => {
          modified = true;
        }),
      },
      onCacheChanged: vi.fn(),
    });

    const refresh = runtime.refresh("poll");
    await vi.waitFor(() => expect(listFolders).toHaveBeenCalledOnce());
    await runtime.modify([{ accountId: account.id, threadId: "thread-1" }], {
      type: "markRead",
    });
    resolveFolders?.([{ id: "INBOX", name: "Inbox", role: "inbox", unreadCount: 1 }]);
    await refresh;

    expect(cache.listFolders()[0]?.unreadCount).toBe(0);
  });

  it("hydrates every target before modifying the complete conversation", async () => {
    const cache = createCache();
    const first = inboxMessage({ id: "first", threadId: "thread-1" });
    const second = inboxMessage({
      id: "second",
      threadId: "thread-1",
      date: "2026-07-16T13:00:00Z",
    });
    cache.putMessages(account, [first]);
    const getThread = vi.fn(async () => ({
      id: "thread-1",
      subject: "Hello",
      messages: [first, second],
    }));
    const modify = vi.fn(async () => undefined);
    const runtime = createRuntimeWithCache({
      cache,
      service: { getThread, modify },
      onCacheChanged: vi.fn(),
    });

    await runtime.modify([{ accountId: account.id, threadId: "thread-1" }], {
      type: "markRead",
    });

    expect(modify).toHaveBeenCalledWith(account.id, ["first", "second"], "markRead");
    expect(getThread).toHaveBeenCalledTimes(2);
  });

  it("keeps successful account mutations when another account fails", async () => {
    const secondary: AccountInfo = {
      id: "account-2",
      email: "secondary@example.com",
      provider: "gmail",
      status: "active",
    };
    const cache = createCache();
    cache.putMessages(account, [inboxMessage({ id: "a", threadId: "thread-a" })]);
    cache.putMessages(secondary, [
      inboxMessage({
        id: "b",
        threadId: "thread-b",
        accountId: secondary.id,
      }),
    ]);
    const modifiedAccounts = new Set<string>();
    const getThread = vi.fn(async (accountId: string, threadId: string) => ({
      id: threadId,
      subject: "Hello",
      messages: [
        inboxMessage({
          id: accountId === account.id ? "a" : "b",
          accountId,
          threadId,
          flags: {
            read: modifiedAccounts.has(accountId),
            starred: false,
            draft: false,
          },
        }),
      ],
    }));
    const modify = vi.fn(async (accountId: string) => {
      if (accountId === secondary.id) throw new Error("Secondary account failed");
      modifiedAccounts.add(accountId);
    });
    const runtime = createRuntimeWithCache({
      cache,
      accounts: [account, secondary],
      service: { getThread, modify },
      onCacheChanged: vi.fn(),
    });

    await expect(
      runtime.modify(
        [
          { accountId: account.id, threadId: "thread-a" },
          { accountId: secondary.id, threadId: "thread-b" },
        ],
        { type: "markRead" },
      ),
    ).rejects.toThrow("Secondary account failed");

    expect(cache.snapshotThread(account.id, "thread-a")?.unread).toBe(0);
    expect(cache.snapshotThread(secondary.id, "thread-b")?.unread).toBe(1);
  });

  it("reconciles the provider state after a partially applied mutation fails", async () => {
    const cache = createCache();
    const first = inboxMessage({ id: "first", threadId: "thread-1" });
    const second = inboxMessage({
      id: "second",
      threadId: "thread-1",
      date: "2026-07-16T13:00:00Z",
    });
    cache.putThread(account, {
      id: "thread-1",
      subject: "Hello",
      messages: [first, second],
    });
    const getThread = vi
      .fn()
      .mockResolvedValueOnce({ id: "thread-1", subject: "Hello", messages: [first, second] })
      .mockResolvedValueOnce({ id: "thread-1", subject: "Hello", messages: [second] });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        getThread,
        modify: vi.fn(async () => {
          throw new Error("The second provider operation failed");
        }),
      },
      onCacheChanged: vi.fn(),
    });

    await expect(
      runtime.modify([{ accountId: account.id, threadId: "thread-1" }], { type: "delete" }),
    ).rejects.toThrow("The second provider operation failed");

    expect(getThread).toHaveBeenCalledTimes(2);
    expect(cache.messageIds(account.id, "thread-1")).toEqual(["second"]);
    expect(cache.snapshotThread(account.id, "thread-1")?.message_count).toBe(1);
  });
});

describe("FluxmailRuntime draft mutations", () => {
  it("deletes only drafts when discarding a draft conversation", async () => {
    const original = inboxMessage({ id: "original", threadId: "thread-1" });
    const draft = draftMessage({
      id: "draft-message",
      threadId: "thread-1",
      draftId: "draft-1",
    });
    const providerDelete = vi.fn(async () => undefined);
    const cacheDelete = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: {
        getThread: vi.fn(async () => ({
          id: "thread-1",
          subject: "Hello",
          messages: [original, draft],
        })),
        deleteDraft: providerDelete,
      },
      cache: { deleteDraft: cacheDelete },
      onCacheChanged,
    });

    await runtime.modify([{ accountId: account.id, threadId: "thread-1" }], {
      type: "discardDraft",
    });

    expect(providerDelete).toHaveBeenCalledWith(account.id, "draft-1");
    expect(cacheDelete).toHaveBeenCalledWith(account, "draft-1");
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });

  it("shows a saved draft in initialized cached views", async () => {
    const cache = createCache();
    cache.setPageToken(account.id, "drafts::");
    cache.setPageToken(account.id, "all::");
    const runtime = createRuntimeWithCache({
      cache,
      service: { createDraft: vi.fn(async () => draftMessage()) },
      onCacheChanged: vi.fn(),
    });

    await runtime.saveDraft({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Draft subject",
      text: "Draft body",
    });

    expect((await runtime.listThreads({ view: "drafts" })).items.map((item) => item.id)).toEqual([
      "draft-thread",
    ]);
    expect((await runtime.listThreads({ view: "all" })).items.map((item) => item.id)).toEqual([
      "draft-thread",
    ]);
  });

  it("shows a sent message in initialized cached views", async () => {
    const cache = createCache();
    cache.setPageToken(account.id, "sent::");
    cache.setPageToken(account.id, "all::");
    const sent = inboxMessage({
      id: "sent-message",
      threadId: "sent-thread",
      folder: { id: "SENT", name: "Sent", role: "sent" },
      flags: { read: true, starred: false, draft: false },
    });
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        send: vi.fn(async () => ({ id: sent.id, threadId: sent.threadId })),
        getThread: vi.fn(async () => ({
          id: sent.threadId,
          subject: sent.subject,
          messages: [sent],
        })),
      },
      onCacheChanged: vi.fn(),
    });

    await runtime.send({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Sent subject",
      text: "Sent body",
    });

    expect((await runtime.listThreads({ view: "sent" })).items.map((item) => item.id)).toEqual([
      "sent-thread",
    ]);
    expect((await runtime.listThreads({ view: "all" })).items.map((item) => item.id)).toEqual([
      "sent-thread",
    ]);
  });

  it("updates a saved draft with the current compose payload before sending it", async () => {
    const updateDraft = vi.fn(async () => draftMessage());
    const send = vi.fn(async () => ({
      id: "sent-message",
      threadId: "sent-thread",
    }));
    const putMessages = vi.fn();
    const deleteDraft = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: { updateDraft, send },
      cache: { putMessages, deleteDraft },
      onCacheChanged,
    });

    await runtime.send({
      accountId: account.id,
      draftId: "draft-1",
      to: [{ email: "new-recipient@example.com" }],
      subject: "Updated subject",
      text: "Updated body",
    });

    expect(updateDraft).toHaveBeenCalledWith(account.id, "draft-1", {
      to: [{ email: "new-recipient@example.com" }],
      subject: "Updated subject",
      body: { text: "Updated body" },
    });
    expect(send).toHaveBeenCalledWith(account.id, { draftId: "draft-1" });
    expect(updateDraft.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(putMessages).toHaveBeenCalledWith(
      account,
      [expect.objectContaining({ draftId: "draft-1" })],
      {
        invalidateBodies: true,
      },
    );
    expect(deleteDraft).toHaveBeenCalledWith(account, "draft-1");
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });

  it("adds the quoted message only during the final update of a saved reply", async () => {
    const original = inboxMessage({
      id: "original",
      threadId: "thread-1",
      from: { email: "friend@example.com" },
      body: {
        text: "Original message",
        html: '<p>Original message</p><img src="cid:reply-logo@example.com">',
      },
      attachments: [
        {
          id: "reply-logo",
          filename: "logo.png",
          mimeType: "image/png",
          sizeBytes: 4,
          contentId: "reply-logo@example.com",
          disposition: "inline",
        },
      ],
    });
    const createDraft = vi.fn(async () =>
      draftMessage({ id: "draft-reply", threadId: "thread-1" }),
    );
    const updateDraft = vi.fn(async () =>
      draftMessage({ id: "draft-reply", threadId: "thread-1" }),
    );
    const send = vi.fn(async () => ({ id: "reply", threadId: "thread-1" }));
    const getAttachment = vi.fn(async () => ({
      meta: { filename: "logo.png", mimeType: "image/png" },
      content: Buffer.from("logo"),
    }));
    const runtime = createRuntime({
      service: {
        createDraft,
        updateDraft,
        send,
        getMessage: vi.fn(async () => original),
        getAttachment,
        getThread: vi.fn(async () => ({
          id: "thread-1",
          subject: "Hello",
          messages: [original],
        })),
      },
      cache: { putMessages: vi.fn(), deleteDraft: vi.fn() },
      onCacheChanged: vi.fn(),
    });
    const input = {
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Re: Hello",
      text: "Reply",
      html: "<p>Reply</p>",
      replyToMessageId: "original",
    };

    await runtime.saveDraft(input);
    await runtime.send({ ...input, draftId: "draft-1" });

    expect(createDraft).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({
        body: { text: "Reply", html: "<p>Reply</p>" },
      }),
    );
    expect(updateDraft).toHaveBeenCalledWith(
      account.id,
      "draft-1",
      expect.objectContaining({
        body: {
          text: expect.stringContaining("\n> Original message"),
          html: expect.stringContaining('class="gmail_quote gmail_quote_container"'),
        },
        attachments: [
          {
            filename: "logo.png",
            mimeType: "image/png",
            content: Buffer.from("logo").toString("base64"),
            contentId: "reply-logo@example.com",
            disposition: "inline",
          },
        ],
      }),
    );
    expect(getAttachment).toHaveBeenCalledWith(
      account.id,
      "original",
      "reply-logo",
      25 * 1024 * 1024,
    );
    expect(send).toHaveBeenCalledWith(account.id, { draftId: "draft-1" });
  });

  it("creates a provider draft before scheduling delivery", async () => {
    const createDraft = vi.fn(async () => draftMessage());
    const scheduleSend = vi.fn(async (_accountId, input, sendAt) => ({
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: input.draftId,
      sendAt,
      status: "pending",
      attempts: 0,
    }));
    const putMessages = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: { createDraft, scheduleSend },
      cache: { putMessages },
      onCacheChanged,
    });

    const result = await runtime.schedule({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Scheduled subject",
      text: "Scheduled body",
      sendAt: "2026-07-21T13:30:00.000Z",
    });

    expect(createDraft).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ body: { text: "Scheduled body" } }),
    );
    expect(scheduleSend).toHaveBeenCalledWith(
      account.id,
      { draftId: "draft-1" },
      "2026-07-21T13:30:00.000Z",
    );
    expect(result).toEqual({
      scheduleId: "schedule-1",
      draftId: "draft-1",
      sendAt: "2026-07-21T13:30:00.000Z",
    });
    expect(putMessages).toHaveBeenCalled();
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });

  it("deletes a newly created draft when scheduling it fails", async () => {
    const schedulingError = new Error("Could not create the schedule.");
    const draft = draftMessage();
    const deleteDraft = vi.fn(async () => undefined);
    const deleteCachedDraft = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: {
        createDraft: vi.fn(async () => draft),
        scheduleSend: vi.fn(async () => {
          throw schedulingError;
        }),
        deleteDraft,
      },
      cache: { putMessages: vi.fn(), deleteDraft: deleteCachedDraft },
      onCacheChanged,
    });

    await expect(
      runtime.schedule({
        accountId: account.id,
        to: [{ email: "friend@example.com" }],
        subject: "Scheduled subject",
        text: "Scheduled body",
        sendAt: "2026-07-21T13:30:00.000Z",
      }),
    ).rejects.toBe(schedulingError);

    expect(deleteDraft).toHaveBeenCalledWith(account.id, draft.draftId);
    expect(deleteCachedDraft).toHaveBeenCalledWith(account, draft.draftId);
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });

  it("keeps a failed schedule's draft visible when provider cleanup fails", async () => {
    const schedulingError = new Error("Could not create the schedule.");
    const draft = draftMessage();
    const runtime = createRuntime({
      service: {
        createDraft: vi.fn(async () => draft),
        scheduleSend: vi.fn(async () => {
          throw schedulingError;
        }),
        deleteDraft: vi.fn(async () => {
          throw new Error("Could not delete the draft.");
        }),
      },
      cache: { putMessages: vi.fn(), deleteDraft: vi.fn() },
      onCacheChanged: vi.fn(),
    });

    await expect(
      runtime.schedule({
        accountId: account.id,
        to: [{ email: "friend@example.com" }],
        subject: "Scheduled subject",
        text: "Scheduled body",
        sendAt: "2026-07-21T13:30:00.000Z",
      }),
    ).rejects.toBe(schedulingError);
  });

  it("replaces an existing schedule before rescheduling its draft", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const oldSchedule = {
      scheduleId: "old-schedule",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-21T13:00:00.000Z",
      status: "pending" as const,
      attempts: 0,
    };
    const cancelScheduled = vi.fn(() => ({
      scheduleId: oldSchedule.scheduleId,
      draftId: oldSchedule.draftId,
      draftKept: true as const,
    }));
    const scheduleSend = vi.fn(async (_accountId, input, sendAt) => ({
      scheduleId: "new-schedule",
      accountId: account.id,
      draftId: input.draftId,
      sendAt,
      status: "pending" as const,
      attempts: 0,
    }));
    const runtime = createRuntime({
      service: {
        listScheduled: vi.fn(() => [oldSchedule]),
        updateDraft: vi.fn(async () => draftMessage()),
        cancelScheduled,
        scheduleSend,
      },
      cache: { putMessages: vi.fn() },
      onCacheChanged: vi.fn(),
    });

    await runtime.schedule({
      accountId: account.id,
      draftId: oldSchedule.draftId,
      to: [{ email: "friend@example.com" }],
      subject: "Updated schedule",
      text: "Updated body",
      sendAt: "2026-07-21T14:00:00.000Z",
    });

    expect(cancelScheduled).toHaveBeenCalledWith(oldSchedule.scheduleId);
    expect(cancelScheduled.mock.invocationCallOrder[0]).toBeLessThan(
      scheduleSend.mock.invocationCallOrder[0]!,
    );
  });

  it("restores the existing schedule when its replacement fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const oldSchedule = {
      scheduleId: "old-schedule",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-21T13:00:00.000Z",
      status: "pending" as const,
      attempts: 0,
    };
    const replacementError = new Error("Could not create the replacement schedule.");
    const scheduleSend = vi
      .fn()
      .mockRejectedValueOnce(replacementError)
      .mockImplementationOnce(async (_accountId, input, sendAt) => ({
        scheduleId: "restored-schedule",
        accountId: account.id,
        draftId: input.draftId,
        sendAt,
        status: "pending" as const,
        attempts: 0,
      }));
    const runtime = createRuntime({
      service: {
        listScheduled: vi.fn(() => [oldSchedule]),
        updateDraft: vi.fn(async () => draftMessage()),
        cancelScheduled: vi.fn(),
        scheduleSend,
      },
      cache: { putMessages: vi.fn() },
      onCacheChanged: vi.fn(),
    });

    await expect(
      runtime.schedule({
        accountId: account.id,
        draftId: oldSchedule.draftId,
        to: [{ email: "friend@example.com" }],
        subject: "Updated schedule",
        text: "Updated body",
        sendAt: "2026-07-21T14:00:00.000Z",
      }),
    ).rejects.toBe(replacementError);

    expect(scheduleSend).toHaveBeenNthCalledWith(
      2,
      oldSchedule.accountId,
      { draftId: oldSchedule.draftId },
      oldSchedule.sendAt,
    );
  });

  it("clamps long reconciliation timers instead of polling before the send date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const sendAt = "2026-09-01T12:00:00.000Z";
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const runtime = createRuntime({
      service: {
        createDraft: vi.fn(async () => draftMessage()),
        scheduleSend: vi.fn(async (_accountId, input) => ({
          scheduleId: "schedule-1",
          accountId: account.id,
          draftId: input.draftId,
          sendAt,
          status: "pending" as const,
          attempts: 0,
        })),
      },
      cache: { putMessages: vi.fn() },
      onCacheChanged: vi.fn(),
    });

    await runtime.schedule({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Long schedule",
      text: "Send this later",
      sendAt,
    });

    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_147_483_647);
  });

  it("cancels an existing schedule before sending its draft immediately", async () => {
    const oldSchedule = {
      scheduleId: "old-schedule",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-21T13:00:00.000Z",
      status: "pending" as const,
      attempts: 0,
    };
    const cancelScheduled = vi.fn(() => ({
      scheduleId: oldSchedule.scheduleId,
      draftId: oldSchedule.draftId,
      draftKept: true as const,
    }));
    const send = vi.fn(async () => ({ id: "sent-message", threadId: "sent-thread" }));
    const runtime = createRuntime({
      service: {
        listScheduled: vi.fn(() => [oldSchedule]),
        updateDraft: vi.fn(async () => draftMessage()),
        cancelScheduled,
        send,
        getThread: vi.fn(async () => ({
          id: "sent-thread",
          subject: "Sent now",
          messages: [
            draftMessage({
              id: "sent-message",
              threadId: "sent-thread",
              draftId: undefined,
              flags: { read: true, starred: false, draft: false },
            }),
          ],
        })),
      },
      cache: { putMessages: vi.fn(), deleteDraft: vi.fn() },
      onCacheChanged: vi.fn(),
    });

    await runtime.send({
      accountId: account.id,
      draftId: oldSchedule.draftId,
      to: [{ email: "friend@example.com" }],
      subject: "Sent now",
      text: "Updated body",
    });

    expect(cancelScheduled).toHaveBeenCalledWith(oldSchedule.scheduleId);
    expect(cancelScheduled.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0]!,
    );
  });

  it("lists pending scheduled drafts in send-time order", async () => {
    const cache = createCache();
    cache.setPageToken(account.id, "drafts::");
    cache.putMessages(account, [
      draftMessage({
        id: "later-message",
        threadId: "later-thread",
        draftId: "later-draft",
        to: [{ name: "Jamie", email: "jamie@example.com" }],
        subject: "Later",
      }),
      draftMessage({
        id: "sooner-message",
        threadId: "sooner-thread",
        draftId: "sooner-draft",
        to: [{ email: "sam@example.com" }],
        subject: "Sooner",
      }),
    ]);
    const listScheduled = vi.fn(() => [
      {
        scheduleId: "later",
        accountId: account.id,
        draftId: "later-draft",
        sendAt: "2026-07-25T12:00:00.000Z",
        status: "pending" as const,
        attempts: 0,
      },
      {
        scheduleId: "sooner",
        accountId: account.id,
        draftId: "sooner-draft",
        sendAt: "2026-07-24T12:00:00.000Z",
        status: "pending" as const,
        attempts: 0,
      },
    ]);
    const runtime = createRuntimeWithCache({
      cache,
      service: { listScheduled },
      onCacheChanged: vi.fn(),
    });

    const page = await runtime.listThreads({ view: "scheduled" });

    expect(page.items).toMatchObject([
      {
        id: "sooner-thread",
        senderName: "sam@example.com",
        date: "2026-07-24T12:00:00.000Z",
      },
      {
        id: "later-thread",
        senderName: "Jamie",
        date: "2026-07-25T12:00:00.000Z",
      },
    ]);
    expect(page.totalCount).toBe(2);
    await expect(runtime.listThreads({ view: "drafts" })).resolves.toMatchObject({
      items: [],
      totalCount: 0,
    });
    cache.close();
  });

  it("hydrates an uncached scheduled draft before listing it", async () => {
    const cache = createCache();
    const scheduled = {
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-24T12:00:00.000Z",
      status: "pending" as const,
      attempts: 0,
    };
    const listMessages = vi.fn(async () => ({
      items: [
        draftMessage({
          draftId: scheduled.draftId,
          subject: "Hydrated schedule",
          to: [{ email: "friend@example.com" }],
        }),
      ],
    }));
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        listScheduled: vi.fn(() => [scheduled]),
        listMessages,
      },
      onCacheChanged: vi.fn(),
    });

    const page = await runtime.listThreads({
      view: "scheduled",
      backgroundRefresh: true,
    });

    expect(listMessages).toHaveBeenCalledOnce();
    expect(page.items).toMatchObject([
      {
        scheduleId: scheduled.scheduleId,
        draftId: scheduled.draftId,
        subject: "Hydrated schedule",
      },
    ]);
    cache.close();
  });

  it("marks an active scheduled draft when it appears in All Mail", async () => {
    const cache = createCache();
    const scheduled = {
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-24T12:00:00.000Z",
      status: "pending" as const,
      attempts: 0,
    };
    cache.putMessages(account, [
      draftMessage({
        draftId: scheduled.draftId,
        subject: "Scheduled in All Mail",
      }),
    ]);
    cache.recordResultPage(account.id, "all::", ["draft-thread"], true);
    cache.setPageToken(account.id, "all::");
    const runtime = createRuntimeWithCache({
      cache,
      service: { listScheduled: vi.fn(() => [scheduled]) },
      onCacheChanged: vi.fn(),
    });

    const page = await runtime.listThreads({ view: "all" });

    expect(page.items).toMatchObject([
      {
        scheduleId: scheduled.scheduleId,
        draftId: scheduled.draftId,
      },
    ]);
    cache.close();
  });

  it("starts the undo delay after the provider draft is ready", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const createDraft = vi.fn(async () => {
      vi.setSystemTime("2026-07-21T12:00:20.000Z");
      return draftMessage();
    });
    const scheduleSend = vi.fn(async (_accountId, input, sendAt) => ({
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: input.draftId,
      sendAt,
      status: "pending",
      attempts: 0,
    }));
    const runtime = createRuntime({
      service: { createDraft, scheduleSend },
      cache: { putMessages: vi.fn() },
      onCacheChanged: vi.fn(),
    });

    await runtime.schedule({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Scheduled subject",
      text: "Scheduled body",
      delaySeconds: 5,
    });

    expect(scheduleSend).toHaveBeenCalledWith(
      account.id,
      { draftId: "draft-1" },
      "2026-07-21T12:00:25.000Z",
    );
  });

  it("keeps an undo send in Sent through a provider refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const cache = createCache();
    const scheduled = {
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-21T12:00:10.000Z",
      status: "pending" as const,
      attempts: 0,
    };
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        createDraft: vi.fn(async () =>
          draftMessage({
            subject: "Optimistic subject",
            body: { text: "Optimistic body" },
          }),
        ),
        scheduleSend: vi.fn(async () => scheduled),
        listScheduled: vi.fn(() => [scheduled]),
        listMessages: vi.fn(async () => ({ items: [] })),
      },
      onCacheChanged: vi.fn(),
    });

    await runtime.schedule({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Optimistic subject",
      text: "Optimistic body",
      delaySeconds: 10,
    });

    await expect(runtime.listThreads({ view: "sent", refresh: true })).resolves.toMatchObject({
      items: [
        {
          id: "draft-thread",
          scheduleId: "schedule-1",
          draftId: "draft-1",
          pendingSend: true,
        },
      ],
    });
    await expect(runtime.getThread(account.id, "draft-thread")).resolves.toMatchObject({
      messages: [{ id: "draft-message", body: { text: "Optimistic body" } }],
    });
    cache.close();
  });

  it.each([false, true])(
    "keeps earlier messages in an undo-send reply preview (invalidated body: %s)",
    async (invalidateBody) => {
      vi.useFakeTimers();
      vi.setSystemTime("2026-07-21T12:00:00.000Z");
      const cache = createCache();
      const original = inboxMessage({
        id: "original",
        body: { text: "Original body" },
        flags: { read: true, starred: false, draft: false },
      });
      const followUp = inboxMessage({
        id: "follow-up",
        date: "2026-07-17T12:00:00Z",
        body: { text: "Follow-up body" },
      });
      cache.putThread(account, {
        id: original.threadId,
        subject: original.subject,
        messages: [original, followUp],
      });
      if (invalidateBody) {
        // A mailbox refresh can invalidate the body while the conversation stays open.
        cache.putMessages(account, [{ ...followUp, flags: { ...followUp.flags, read: true } }]);
        expect(cache.getThread(account.id, original.threadId)).toBeUndefined();
      }
      const draft = draftMessage({
        threadId: original.threadId,
        date: "2026-07-21T12:00:00Z",
        body: { text: "Pending reply" },
      });
      const scheduled = {
        scheduleId: "reply-schedule",
        accountId: account.id,
        draftId: draft.draftId!,
        sendAt: "2026-07-21T12:00:10.000Z",
        status: "pending" as const,
        attempts: 0,
      };
      const getThread = vi.fn(async () => ({
        id: original.threadId,
        subject: original.subject,
        messages: [original, followUp, draft],
      }));
      const runtime = createRuntimeWithCache({
        cache,
        service: {
          getMessage: vi.fn(async () => followUp),
          createDraft: vi.fn(async () => draft),
          scheduleSend: vi.fn(async () => scheduled),
          listScheduled: vi.fn(() => [scheduled]),
          getThread,
        },
        onCacheChanged: vi.fn(),
      });

      await runtime.schedule({
        accountId: account.id,
        to: [{ email: "friend@example.com" }],
        subject: "Re: Hello",
        text: "Pending reply",
        replyToMessageId: followUp.id,
        delaySeconds: 10,
      });

      const preview = await runtime.getThread(account.id, original.threadId);
      expect(preview.messages.map((message) => message.id)).toEqual([
        original.id,
        followUp.id,
        draft.id,
      ]);
      expect(preview.messages.map((message) => message.body?.text)).toEqual([
        "Original body",
        "Follow-up body",
        "Pending reply",
      ]);
      expect(getThread).toHaveBeenCalledTimes(invalidateBody ? 1 : 0);
      cache.close();
    },
  );

  it("removes a delivered schedule from Drafts and caches its Sent thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const scheduled = {
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-21T12:00:05.000Z",
      status: "sent" as const,
      attempts: 0,
      sentThreadId: "sent-thread",
    };
    const scheduleSend = vi.fn(async () => ({ ...scheduled, status: "pending" as const }));
    const listScheduled = vi.fn(() => [scheduled]);
    const getThread = vi.fn(async () => ({
      id: "sent-thread",
      subject: "Scheduled subject",
      messages: [draftMessage({ id: "sent-message", threadId: "sent-thread" })],
    }));
    const deleteDraft = vi.fn();
    const putThread = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: {
        createDraft: vi.fn(async () => draftMessage()),
        scheduleSend,
        listScheduled,
        getThread,
      },
      cache: { putMessages: vi.fn(), deleteDraft, putThread },
      onCacheChanged,
    });

    await runtime.schedule({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Scheduled subject",
      text: "Scheduled body",
      delaySeconds: 5,
    });
    await vi.advanceTimersByTimeAsync(5_100);

    expect(listScheduled).toHaveBeenCalledWith(account.id);
    expect(deleteDraft).toHaveBeenCalledWith(account, "draft-1");
    expect(getThread).toHaveBeenCalledWith(account.id, "sent-thread");
    expect(putThread).toHaveBeenCalledWith(account, expect.objectContaining({ id: "sent-thread" }));
    expect(onCacheChanged).toHaveBeenCalledTimes(3);
  });

  it("reveals an undo send when its delivery attempt will be retried", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const cache = createCache();
    const scheduled = {
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-21T12:00:05.000Z",
      status: "pending" as const,
      attempts: 1,
      lastError: "Network unavailable",
    };
    const runtime = createRuntimeWithCache({
      cache,
      service: {
        createDraft: vi.fn(async () => draftMessage()),
        scheduleSend: vi.fn(async () => ({ ...scheduled, attempts: 0, lastError: undefined })),
        listScheduled: vi.fn(() => [scheduled]),
      },
      onCacheChanged: vi.fn(),
    });

    await runtime.schedule({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Retry this",
      text: "Scheduled body",
      delaySeconds: 5,
    });
    await expect(runtime.listThreads({ view: "scheduled" })).resolves.toMatchObject({
      totalCount: 0,
    });

    await vi.advanceTimersByTimeAsync(5_100);

    await expect(runtime.listThreads({ view: "scheduled" })).resolves.toMatchObject({
      totalCount: 1,
      items: [{ scheduleId: "schedule-1", draftId: "draft-1" }],
    });
    cache.close();
  });

  it("notifies the renderer when a scheduled send fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-21T12:00:00.000Z");
    const failed = {
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: "draft-1",
      sendAt: "2026-07-21T12:00:05.000Z",
      status: "failed" as const,
      attempts: 1,
      lastError: "Draft no longer exists",
    };
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: {
        createDraft: vi.fn(async () => draftMessage()),
        scheduleSend: vi.fn(async () => ({ ...failed, status: "pending" as const })),
        listScheduled: vi.fn(() => [failed]),
      },
      cache: { putMessages: vi.fn() },
      onCacheChanged,
    });

    await runtime.schedule({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Scheduled subject",
      text: "Scheduled body",
      sendAt: failed.sendAt,
    });
    expect(onCacheChanged).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_100);

    expect(onCacheChanged).toHaveBeenCalledTimes(2);
  });

  it("purges the cached draft after the provider deletes it", async () => {
    const providerDelete = vi.fn(async () => undefined);
    const cacheDelete = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: { deleteDraft: providerDelete },
      cache: { deleteDraft: cacheDelete },
      onCacheChanged,
    });

    await runtime.deleteDraft(account.id, "draft-1");

    expect(providerDelete).toHaveBeenCalledWith(account.id, "draft-1");
    expect(cacheDelete).toHaveBeenCalledWith(account, "draft-1");
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });

  it("cancels a scheduled send before directly deleting its draft", async () => {
    const cancelScheduled = vi.fn();
    const providerDelete = vi.fn(async () => undefined);
    const cacheDelete = vi.fn();
    const runtime = createRuntime({
      service: {
        listScheduled: vi.fn(() => [
          {
            scheduleId: "schedule-1",
            accountId: account.id,
            draftId: "draft-1",
            sendAt: "2026-07-24T12:00:00.000Z",
            status: "pending",
            attempts: 0,
          },
        ]),
        cancelScheduled,
        deleteDraft: providerDelete,
      },
      cache: { deleteDraft: cacheDelete },
      onCacheChanged: vi.fn(),
    });

    await runtime.deleteDraft(account.id, "draft-1");

    expect(cancelScheduled).toHaveBeenCalledWith("schedule-1");
    expect(providerDelete).toHaveBeenCalledWith(account.id, "draft-1");
    expect(cancelScheduled.mock.invocationCallOrder[0]).toBeLessThan(
      providerDelete.mock.invocationCallOrder[0]!,
    );
    expect(cacheDelete).toHaveBeenCalledWith(account, "draft-1");
  });

  it("cancels a scheduled send before discarding its draft", async () => {
    const cancelScheduled = vi.fn();
    const deleteDraft = vi.fn(async () => undefined);
    const cacheDelete = vi.fn();
    const runtime = createRuntime({
      service: {
        listScheduled: vi.fn(() => [
          {
            scheduleId: "schedule-1",
            accountId: account.id,
            draftId: "draft-1",
            sendAt: "2026-07-24T12:00:00.000Z",
            status: "pending",
            attempts: 0,
          },
        ]),
        cancelScheduled,
        deleteDraft,
        getThread: vi.fn(async () => ({
          id: "draft-thread",
          subject: "Scheduled subject",
          messages: [draftMessage()],
        })),
      },
      cache: { deleteDraft: cacheDelete },
      onCacheChanged: vi.fn(),
    });

    await runtime.modify([{ accountId: account.id, threadId: "draft-thread" }], {
      type: "discardDraft",
    });

    expect(cancelScheduled).toHaveBeenCalledWith("schedule-1");
    expect(deleteDraft).toHaveBeenCalledWith(account.id, "draft-1");
    expect(cacheDelete).toHaveBeenCalledWith(account, "draft-1");
    expect(cancelScheduled.mock.invocationCallOrder[0]).toBeLessThan(
      deleteDraft.mock.invocationCallOrder[0]!,
    );
  });

  it("refreshes the cached conversation after a direct reply", async () => {
    const send = vi.fn(async () => ({ id: "reply", threadId: "thread-1" }));
    const original = inboxMessage({
      id: "original",
      threadId: "thread-1",
      from: { name: "Friend", email: "friend@example.com" },
      body: { text: "Original message", html: "<p>Original message</p>" },
    });
    const getMessage = vi.fn(async () => original);
    const getThread = vi.fn(async () => ({
      id: "thread-1",
      subject: "Hello",
      messages: [draftMessage({ id: "reply", threadId: "thread-1" })],
    }));
    const putThread = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: { send, getMessage, getThread },
      cache: { putThread, invalidateThread: vi.fn() },
      onCacheChanged,
    });

    await runtime.send({
      accountId: account.id,
      to: [{ email: "friend@example.com" }],
      subject: "Re: Hello",
      text: "Reply",
      html: "<p>Reply</p>",
      replyToMessageId: "original",
    });

    expect(getMessage).toHaveBeenCalledWith(account.id, "original");
    expect(send).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({
        replyToMessageId: "original",
        body: {
          text: expect.stringMatching(/^Reply\n\nOn .+ Friend <friend@example\.com> wrote:/),
          html: expect.stringContaining('class="gmail_quote gmail_quote_container"'),
        },
      }),
    );
    expect(getThread).toHaveBeenCalledWith(account.id, "thread-1");
    expect(send).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({
        body: {
          text: expect.stringContaining("> Original message"),
          html: expect.stringContaining('class="gmail_quote gmail_quote_container"'),
        },
      }),
    );
    expect(putThread).toHaveBeenCalledWith(account, expect.objectContaining({ id: "thread-1" }));
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });

  it("refreshes the cached conversation after forwarding", async () => {
    const original = inboxMessage({
      id: "original",
      body: { text: "Original body", html: "<p>Original body</p>" },
      attachments: [
        {
          id: "original-attachment",
          filename: "original.pdf",
          mimeType: "application/pdf",
          sizeBytes: 8,
        },
      ],
    });
    const getMessage = vi.fn(async () => original);
    const getAttachment = vi.fn(async () => ({
      meta: { filename: "original.pdf", mimeType: "application/pdf" },
      content: Buffer.from("original"),
    }));
    const send = vi.fn(async () => ({
      id: "forward",
      threadId: "forward-thread",
    }));
    const getThread = vi.fn(async () => ({
      id: "forward-thread",
      subject: "Fwd: Hello",
      messages: [draftMessage({ id: "forward", threadId: "forward-thread" })],
    }));
    const putThread = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: { getMessage, getAttachment, send, getThread },
      cache: { putThread, invalidateThread: vi.fn() },
      onCacheChanged,
    });

    await runtime.forward({
      accountId: account.id,
      messageId: "original",
      to: [{ email: "friend@example.com" }],
      bcc: [{ email: "archive@example.com" }],
      subject: "A custom forward subject",
      text: "For your review",
      html: "<p><strong>For your review</strong></p>",
      attachments: [
        {
          token: "added-attachment",
          filename: "attachment.txt",
          mimeType: "text/plain",
          sizeBytes: 7,
        },
      ],
      includeAttachments: true,
    });

    expect(getAttachment).toHaveBeenCalledWith(
      account.id,
      "original",
      "original-attachment",
      25 * 1024 * 1024,
    );
    expect(send).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({
        to: [{ email: "friend@example.com" }],
        bcc: [{ email: "archive@example.com" }],
        subject: "A custom forward subject",
        body: {
          text: expect.stringMatching(/For your review[\s\S]*Original body/),
          html: expect.stringMatching(/<strong>For your review<\/strong>[\s\S]*Original body/),
        },
        attachments: [
          expect.objectContaining({ filename: "original.pdf" }),
          expect.objectContaining({ filename: "attachment.txt" }),
        ],
      }),
    );
    expect(getThread).toHaveBeenCalledWith(account.id, "forward-thread");
    expect(putThread).toHaveBeenCalledWith(
      account,
      expect.objectContaining({ id: "forward-thread" }),
    );
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });

  it("caches a provider draft before scheduling a forward", async () => {
    const original = inboxMessage({ id: "original" });
    const draft = draftMessage({ id: "forward-draft", threadId: "forward-thread" });
    const createDraft = vi.fn(async () => draft);
    const scheduleSend = vi.fn(async (_accountId, input, sendAt) => ({
      scheduleId: "schedule-1",
      accountId: account.id,
      draftId: input.draftId,
      sendAt,
      status: "pending",
      attempts: 0,
    }));
    const putMessages = vi.fn();
    const runtime = createRuntime({
      service: {
        getMessage: vi.fn(async () => original),
        createDraft,
        scheduleSend,
      },
      cache: { putMessages },
      onCacheChanged: vi.fn(),
    });

    await runtime.forward({
      accountId: account.id,
      messageId: original.id,
      to: [{ email: "friend@example.com" }],
      subject: "Fwd: Hello",
      text: "See below",
      sendAt: "2026-07-22T12:00:00.000Z",
    });

    expect(createDraft).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ to: [{ email: "friend@example.com" }] }),
    );
    expect(putMessages).toHaveBeenCalledWith(account, [draft], { invalidateBodies: true });
    expect(scheduleSend).toHaveBeenCalledWith(
      account.id,
      { draftId: draft.draftId },
      "2026-07-22T12:00:00.000Z",
    );
  });

  it("deletes a forward draft when scheduling it fails", async () => {
    const schedulingError = new Error("Could not create the schedule.");
    const original = inboxMessage({ id: "original" });
    const draft = draftMessage({ id: "forward-draft", threadId: "forward-thread" });
    const deleteDraft = vi.fn(async () => undefined);
    const deleteCachedDraft = vi.fn();
    const onCacheChanged = vi.fn();
    const runtime = createRuntime({
      service: {
        getMessage: vi.fn(async () => original),
        createDraft: vi.fn(async () => draft),
        scheduleSend: vi.fn(async () => {
          throw schedulingError;
        }),
        deleteDraft,
      },
      cache: { putMessages: vi.fn(), deleteDraft: deleteCachedDraft },
      onCacheChanged,
    });

    await expect(
      runtime.forward({
        accountId: account.id,
        messageId: original.id,
        to: [{ email: "friend@example.com" }],
        subject: "Fwd: Hello",
        text: "See below",
        sendAt: "2026-07-22T12:00:00.000Z",
      }),
    ).rejects.toBe(schedulingError);

    expect(deleteDraft).toHaveBeenCalledWith(account.id, draft.draftId);
    expect(deleteCachedDraft).toHaveBeenCalledWith(account, draft.draftId);
    expect(onCacheChanged).toHaveBeenCalledOnce();
  });
});

describe("FluxmailRuntime OAuth configuration", () => {
  it("rejects an incompatible store before writing bundled configuration", () => {
    const compatibility: StoreCompatibility = {
      engineVersion: "0.3.0",
      dataDir: "/tmp/fluxmail",
      dbPath: "/tmp/fluxmail/fluxmail.db",
      storeFormat: 2,
      minimumSupportedFormat: 1,
      maximumSupportedFormat: 1,
      compatible: false,
      requiresMigration: false,
    };
    class TestIncompatibleStoreError extends Error {
      readonly code = "incompatible_store";

      constructor(readonly compatibility: StoreCompatibility) {
        super("Incompatible store");
      }
    }
    const fluxmail = {
      resolveStoreLocation: vi.fn(() => ({
        dataDir: compatibility.dataDir,
        dbPath: compatibility.dbPath,
      })),
      inspectStoreCompatibility: vi.fn(() => compatibility),
      IncompatibleStoreError: TestIncompatibleStoreError,
    };

    expect(() =>
      prepareFluxmailConfiguration(
        fluxmail as Parameters<typeof prepareFluxmailConfiguration>[0],
        "bundled-id",
        "bundled-secret",
      ),
    ).toThrow(TestIncompatibleStoreError);
  });

  it("uses the bundled pair when the existing configuration is incomplete", () => {
    expect(
      shouldUseBundledGoogleConfig("custom-id", undefined, "bundled-id", "bundled-secret"),
    ).toBe(true);
    expect(
      shouldUseBundledGoogleConfig(undefined, "custom-secret", "bundled-id", "bundled-secret"),
    ).toBe(true);
  });

  it("keeps a complete existing pair and requires a complete bundled pair", () => {
    expect(
      shouldUseBundledGoogleConfig("custom-id", "custom-secret", "bundled-id", "bundled-secret"),
    ).toBe(false);
    expect(shouldUseBundledGoogleConfig(undefined, undefined, "bundled-id", "")).toBe(false);
  });
});

describe("FluxmailRuntime store compatibility", () => {
  it("accepts a store that has already been upgraded to format 5", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fluxmail-format-five-"));
    directories.push(directory);
    const dbPath = path.join(directory, "fluxmail.db");
    const sqlite = new Database(dbPath);
    sqlite.pragma("user_version = 5");
    sqlite.close();

    const fluxmail = {
      resolveStoreLocation: vi.fn(() => ({ dataDir: directory, dbPath })),
      inspectStoreCompatibility,
      IncompatibleStoreError,
    };

    expect(MAX_SUPPORTED_STORE_FORMAT).toBeGreaterThanOrEqual(5);
    expect(prepareFluxmailConfiguration(fluxmail, "", "")).toBe(false);
  });

  it("blocks bootstrap and mutations if another process upgrades the store", async () => {
    const createDraft = vi.fn();
    const runtime = createRuntime({
      cache: {},
      service: { createDraft },
      onCacheChanged: vi.fn(),
    });
    const internals = runtime as unknown as {
      fluxmail: {
        inspectStoreCompatibility: ReturnType<typeof vi.fn>;
      };
      context: {
        scheduler: { stop: ReturnType<typeof vi.fn> };
        licenseController: { stop: ReturnType<typeof vi.fn> };
      };
    };
    internals.fluxmail.inspectStoreCompatibility.mockReturnValue({
      ...compatibleStore(),
      storeFormat: 2,
      compatible: false,
      requiresMigration: false,
    });

    await expect(runtime.bootstrap({ status: "idle" })).rejects.toMatchObject({
      code: "incompatible_store",
    });
    await expect(
      runtime.saveDraft({
        accountId: account.id,
        to: [{ email: "friend@example.com" }],
        subject: "Draft subject",
        text: "Draft body",
      }),
    ).rejects.toMatchObject({ code: "incompatible_store" });

    expect(createDraft).not.toHaveBeenCalled();
    expect(internals.context.scheduler.stop).toHaveBeenCalled();
    expect(internals.context.licenseController.stop).toHaveBeenCalled();
  });
});

function createRuntime(input: {
  service: Record<string, ReturnType<typeof vi.fn>>;
  cache: Record<string, ReturnType<typeof vi.fn>>;
  onCacheChanged(): void;
  onLicenseChanged?(): void;
}): FluxmailRuntime {
  const cache = {
    putThread: vi.fn(),
    putOptimisticDraft: vi.fn(),
    invalidateThread: vi.fn(),
    recordResultPage: vi.fn(),
    ...input.cache,
  };
  const runtime = new FluxmailRuntime({
    cache: cache as unknown as MailCache,
    analytics: {
      captureOperation: vi.fn(),
    } as unknown as DesktopAnalytics,
    openExternal: vi.fn(async () => undefined),
    resolveAttachment: vi.fn(async () => ({
      filename: "attachment.txt",
      mimeType: "text/plain",
      content: "Y29udGVudA==",
    })),
    onNewMessages: vi.fn(),
    onCacheChanged: input.onCacheChanged,
    onLicenseChanged: input.onLicenseChanged ?? vi.fn(),
  });
  Object.assign(runtime, {
    fluxmail: runtimeFluxmailModule(),
    context: {
      db: {},
      config: {
        dataDir: "/tmp/fluxmail",
        dbPath: "/tmp/fluxmail/fluxmail.db",
        licenseServerUrl: "https://license.test",
        maxAttachmentBytes: 25 * 1024 * 1024,
      },
      configuration: { setLicenseKey: vi.fn() },
      registry: { listAccounts: () => [account] },
      service: { listScheduled: vi.fn(() => []), ...input.service },
      scheduler: { stop: vi.fn() },
      licenseController: {
        stop: vi.fn(),
        wake: vi.fn(),
        configuredKey: vi.fn(() => undefined),
        refreshNow: vi.fn(async () => undefined),
      },
    },
  });
  return runtime;
}

function createRuntimeWithCache(input: {
  cache: MailCache;
  service: Record<string, ReturnType<typeof vi.fn>>;
  accounts?: AccountInfo[];
  onCacheChanged(): void;
  onNewMessages?(messages: Message[], account: AccountInfo): void;
  onLicenseChanged?(): void;
}): FluxmailRuntime {
  const runtimeAccounts = [...(input.accounts ?? [account])];
  const runtime = new FluxmailRuntime({
    cache: input.cache,
    analytics: {
      captureOperation: vi.fn(),
      captureSync: vi.fn(),
    } as unknown as DesktopAnalytics,
    openExternal: vi.fn(async () => undefined),
    resolveAttachment: vi.fn(async () => ({
      filename: "attachment.txt",
      mimeType: "text/plain",
      content: "Y29udGVudA==",
    })),
    onNewMessages: input.onNewMessages ?? vi.fn(),
    onCacheChanged: input.onCacheChanged,
    onLicenseChanged: input.onLicenseChanged ?? vi.fn(),
  });
  Object.assign(runtime, {
    fluxmail: runtimeFluxmailModule(),
    context: {
      db: {},
      config: {
        dataDir: "/tmp/fluxmail",
        dbPath: "/tmp/fluxmail/fluxmail.db",
        licenseServerUrl: "https://license.test",
        maxAttachmentBytes: 25 * 1024 * 1024,
      },
      configuration: { setLicenseKey: vi.fn() },
      registry: {
        listAccounts: () => runtimeAccounts,
        removeAccount: (accountId: string) => {
          const index = runtimeAccounts.findIndex((candidate) => candidate.id === accountId);
          if (index >= 0) runtimeAccounts.splice(index, 1);
        },
      },
      service: { listScheduled: vi.fn(() => []), ...input.service },
      scheduler: { stop: vi.fn() },
      licenseController: {
        stop: vi.fn(),
        wake: vi.fn(),
        configuredKey: vi.fn(() => undefined),
        refreshNow: vi.fn(async () => undefined),
      },
    },
  });
  return runtime;
}

function createCache(): MailCache {
  const directory = mkdtempSync(path.join(tmpdir(), "fluxmail-runtime-"));
  directories.push(directory);
  return new MailCache(directory, {
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString("utf8"),
  });
}

function compatibleStore(): StoreCompatibility {
  return {
    engineVersion: "0.3.0",
    dataDir: "/tmp/fluxmail",
    dbPath: "/tmp/fluxmail/fluxmail.db",
    storeFormat: 1,
    minimumSupportedFormat: 1,
    maximumSupportedFormat: 1,
    compatible: true,
    requiresMigration: false,
  };
}

function runtimeFluxmailModule() {
  return {
    inspectStoreCompatibility: vi.fn(() => compatibleStore()),
    IncompatibleStoreError,
    LICENSE_KEY_PATTERN: /^fluxmail_lic_[0-9a-f]{40}$/,
    refreshLicense: vi.fn(),
    getEntitlements: vi.fn(() => ({
      plan: "personal",
      licensed: false,
      inGrace: false,
      maxMembers: 1,
      maxAccounts: 3,
    })),
    checkLicenseState: vi.fn(() => ({ warning: undefined })),
    readLeaseRow: vi.fn(() => undefined),
    verifyLease: vi.fn(),
    licensePublicKeys: vi.fn(() => []),
  };
}

function inboxMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message",
    threadId: "thread",
    accountId: account.id,
    folder: { id: "INBOX", name: "Inbox", role: "inbox" },
    from: { email: "sender@example.com" },
    to: [{ email: account.email }],
    subject: "Hello",
    date: "2026-07-16T12:00:00Z",
    snippet: "Hello there",
    flags: { read: false, starred: false, draft: false },
    ...overrides,
  };
}

function draftMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "draft-message",
    threadId: "draft-thread",
    draftId: "draft-1",
    accountId: account.id,
    folder: { id: "DRAFT", name: "Drafts", role: "drafts" },
    from: { email: account.email },
    to: [{ email: "new-recipient@example.com" }],
    subject: "Updated subject",
    date: "2026-07-16T12:00:00Z",
    body: { text: "Updated body" },
    flags: { read: true, starred: false, draft: true },
    ...overrides,
  };
}
