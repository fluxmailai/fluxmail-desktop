import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdater, updateFeedUrl } from "../src/main/updater";

class FakeClient extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

function createUpdater() {
  const client = new FakeClient();
  const onReady = vi.fn();
  const onInstallFailed = vi.fn();
  const updater = new DesktopUpdater(client, { arch: "arm64", onReady, onInstallFailed });
  return { client, onReady, onInstallFailed, updater };
}

describe("DesktopUpdater", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("checks the feed for this architecture at launch and every six hours", () => {
    const { client, updater } = createUpdater();

    updater.start();

    expect(client.setFeedURL).toHaveBeenCalledWith({
      url: updateFeedUrl("arm64"),
      serverType: "json",
    });
    expect(updateFeedUrl("arm64")).toBe(
      "https://github.com/fluxmailai/fluxmail-desktop/releases/latest/download/RELEASES-darwin-arm64.json",
    );
    expect(client.checkForUpdates).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("stops checking once an update is ready", () => {
    const { client, onReady, updater } = createUpdater();
    updater.start();

    client.emit("update-downloaded");

    expect(updater.ready).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(client.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("ignores failed checks", () => {
    const { client, onInstallFailed, updater } = createUpdater();
    updater.start();

    client.emit("error", new Error("offline"));

    expect(updater.ready).toBe(false);
    expect(onInstallFailed).not.toHaveBeenCalled();
  });

  it("reports a failure after installing has started", () => {
    const { client, onInstallFailed, updater } = createUpdater();
    updater.start();
    client.emit("update-downloaded");

    updater.install();
    client.emit("error", new Error("install failed"));

    expect(updater.installing).toBe(true);
    expect(client.quitAndInstall).toHaveBeenCalledOnce();
    expect(onInstallFailed).toHaveBeenCalledOnce();
  });
});
