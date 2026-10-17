import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.1.0" },
}));

import { createTelemetry, type Telemetry } from "fluxmail";
import { DesktopAnalytics, environmentForcesOptOut } from "../src/main/analytics";

const directories: string[] = [];

afterEach(() => {
  delete process.env.FLUXMAIL_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("DesktopAnalytics", () => {
  it("adds required desktop context and strips unknown feature properties", async () => {
    const captures: Array<{
      event: string;
      properties?: Record<string, unknown>;
    }> = [];
    const analytics = createDesktopAnalytics(captures);
    analytics.captureFeature({
      feature: "search",
      action: "submitted",
      source: "toolbar",
      query: "person@example.com",
      subject: "private subject",
      path: "/Users/person/mail",
    } as never);

    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      event: "feature_used",
      properties: {
        product_surface: "mail_app",
        client_platform: "desktop",
        deployment_environment: "production",
        desktop_app_version: "0.1.0",
        mcp_version: "0.15.0",
        feature: "search",
        action: "submitted",
        source: "toolbar",
      },
    });
    const payload = JSON.stringify(captures[0]);
    for (const prohibited of [
      "person@example.com",
      "private subject",
      "/Users/person/mail",
      "query",
      "subject",
      "path",
    ]) {
      expect(payload).not.toContain(prohibited);
    }
    await analytics.shutdown();
  });

  it("normalizes error codes and ignores analytics client failures", async () => {
    const captures: Array<{
      event: string;
      properties?: Record<string, unknown>;
    }> = [];
    const analytics = createDesktopAnalytics(captures, true);
    expect(() =>
      analytics.captureOperation({
        operation: "send",
        outcome: "error",
        errorCode: "token=https://secret",
        durationMs: 12.4,
      }),
    ).not.toThrow();
    expect(captures[0]?.properties).toMatchObject({
      error_code: "unknown_error",
      duration_ms: 12,
    });
    await expect(analytics.shutdown()).resolves.toBeUndefined();
  });

  it("honors environment opt-outs and applies preference changes immediately", async () => {
    const captures: Array<{
      event: string;
      properties?: Record<string, unknown>;
    }> = [];
    const analytics = createDesktopAnalytics(captures);
    expect(analytics.status().enabled).toBe(true);
    expect((await analytics.setEnabled(false)).enabled).toBe(false);
    analytics.captureStarted({ cacheState: "hit", onboardingComplete: true });
    expect(captures).toHaveLength(0);
    expect((await analytics.setEnabled(true)).enabled).toBe(true);
    process.env.DO_NOT_TRACK = "1";
    expect(analytics.status()).toEqual({
      enabled: false,
      lockedByEnvironment: true,
    });
    expect(await analytics.setEnabled(true)).toEqual({
      enabled: false,
      lockedByEnvironment: true,
    });
    await analytics.shutdown();
    expect(environmentForcesOptOut({ FLUXMAIL_TELEMETRY: "0" })).toBe(true);
  });

  it("saves the preference before the old client finishes shutting down", async () => {
    let finishShutdown: () => void = () => undefined;
    const firstClient: Telemetry = {
      capture: vi.fn(),
      shutdown: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishShutdown = resolve;
          }),
      ),
    };
    const secondClient: Telemetry = {
      capture: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const createClient = vi.fn().mockReturnValueOnce(firstClient).mockReturnValue(secondClient);
    const analytics = new DesktopAnalytics({
      dataDir: temporaryDirectory(),
      packaged: true,
      testClient: true,
      createClient: createClient as typeof createTelemetry,
    });

    const update = analytics.setEnabled(false);

    expect(analytics.status().enabled).toBe(false);
    expect(createClient).toHaveBeenCalledTimes(2);
    finishShutdown();
    await expect(update).resolves.toMatchObject({ enabled: false });
    await analytics.shutdown();
  });

  it("creates its data directory before saving a preference", async () => {
    const dataDir = path.join(temporaryDirectory(), "telemetry");
    const client: Telemetry = {
      capture: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const analytics = new DesktopAnalytics({
      dataDir,
      packaged: true,
      testClient: true,
      createClient: (() => client) as typeof createTelemetry,
    });

    expect(existsSync(dataDir)).toBe(true);
    await expect(analytics.setEnabled(false)).resolves.toMatchObject({ enabled: false });
    expect(readFileSync(path.join(dataDir, "telemetry.disabled"), "utf8")).toBe("disabled\n");
    await analytics.shutdown();
  });

  it("updates the saved preference in development without sending events", async () => {
    const captures: Array<{
      event: string;
      properties?: Record<string, unknown>;
    }> = [];
    const client: Telemetry = {
      capture: (event, properties) => captures.push({ event, properties }),
      async shutdown() {},
    };
    const analytics = new DesktopAnalytics({
      dataDir: temporaryDirectory(),
      packaged: false,
      createClient: (() => client) as typeof createTelemetry,
    });

    expect(analytics.status()).toEqual({
      enabled: true,
      lockedByEnvironment: false,
    });
    expect((await analytics.setEnabled(false)).enabled).toBe(false);
    expect((await analytics.setEnabled(true)).enabled).toBe(true);
    analytics.captureFeature({
      feature: "settings",
      action: "enabled",
      source: "settings",
    });
    expect(captures).toHaveLength(0);
    await analytics.shutdown();
  });

  it("keeps a stable mode-0600 installation ID and disables profiles and GeoIP", async () => {
    const directory = temporaryDirectory();
    const events: Array<Record<string, unknown>> = [];
    const client = {
      capture: (event: Record<string, unknown>) => events.push(event),
      shutdown: vi.fn(async () => undefined),
    };
    const first = createTelemetry({
      dataDir: directory,
      env: {},
      client: client as never,
    });
    first.capture("first");
    await first.shutdown();
    const firstId = readFileSync(path.join(directory, "telemetry.id"), "utf8").trim();
    const second = createTelemetry({
      dataDir: directory,
      env: {},
      client: client as never,
    });
    second.capture("second");
    await second.shutdown();
    const secondId = readFileSync(path.join(directory, "telemetry.id"), "utf8").trim();

    expect(firstId).toMatch(/^[a-f0-9]{32}$/);
    expect(secondId).toBe(firstId);
    expect(events[0]).toMatchObject({
      disableGeoip: true,
      distinctId: firstId,
      properties: { $process_person_profile: false },
    });
    expect(client.shutdown).toHaveBeenCalledWith(1_000);
  });
});

function createDesktopAnalytics(
  captures: Array<{ event: string; properties?: Record<string, unknown> }>,
  fail = false,
): DesktopAnalytics {
  const client: Telemetry = {
    capture(event, properties) {
      captures.push({ event, properties });
      if (fail) throw new Error("network included person@example.com");
    },
    async shutdown() {},
  };
  return new DesktopAnalytics({
    dataDir: temporaryDirectory(),
    packaged: true,
    testClient: true,
    createClient: (() => client) as typeof createTelemetry,
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fluxmail-analytics-"));
  directories.push(directory);
  return directory;
}
