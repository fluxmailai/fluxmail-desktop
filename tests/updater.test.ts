import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeUpdateClient } from "../src/main/fake-updater";
import { DesktopUpdater, updateFeedUrl } from "../src/main/updater";

class FakeClient extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

function createUpdater() {
  const client = new FakeClient();
  const onStatus = vi.fn();
  const onInstallFailed = vi.fn();
  const updater = new DesktopUpdater(client, { arch: "arm64", onStatus, onInstallFailed });
  return { client, onStatus, onInstallFailed, updater };
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
    expect(updater.status).toEqual({ state: "checking" });
    client.emit("update-not-available");
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("reports each step of a found update and stops checking once it is ready", () => {
    const { client, onStatus, updater } = createUpdater();
    updater.start();

    client.emit("update-available");
    expect(updater.status).toEqual({ state: "downloading" });
    client.emit("update-downloaded", {}, "", "0.11.0");

    expect(updater.ready).toBe(true);
    expect(updater.status).toEqual({ state: "ready", version: "0.11.0" });
    expect(onStatus.mock.calls.map(([status]) => status.state)).toEqual([
      "checking",
      "downloading",
      "ready",
    ]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(updater.check()).toEqual({ state: "ready", version: "0.11.0" });
    expect(client.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("leaves out a release name that is not a short version", () => {
    const { client, updater } = createUpdater();
    updater.start();

    client.emit("update-downloaded", {}, "", "x".repeat(65));

    expect(updater.status).toEqual({ state: "ready" });
  });

  it("reports when a manual check finds no update", () => {
    const { client, updater } = createUpdater();
    updater.start();
    client.emit("update-not-available");

    expect(updater.check()).toEqual({ state: "checking" });
    client.emit("update-not-available");

    expect(updater.status).toEqual({ state: "current" });
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("does not start a second check while one is running or downloading", () => {
    const { client, updater } = createUpdater();
    updater.start();

    updater.check();
    expect(client.checkForUpdates).toHaveBeenCalledOnce();
    client.emit("update-available");
    updater.check();
    vi.advanceTimersByTime(20 * 60 * 1000);
    updater.check();

    expect(client.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.status).toEqual({ state: "downloading" });
  });

  it("ignores failed background checks", () => {
    const { client, onInstallFailed, updater } = createUpdater();
    updater.start();

    client.emit("error", new Error("offline"));

    expect(updater.ready).toBe(false);
    expect(updater.status).toEqual({ state: "idle" });
    expect(onInstallFailed).not.toHaveBeenCalled();
  });

  it("reports a failed manual check and allows another", () => {
    const { client, updater } = createUpdater();
    updater.start();
    client.emit("update-not-available");

    updater.check();
    client.emit("error", new Error("offline"));
    expect(updater.status).toEqual({ state: "failed", stage: "check" });

    updater.check();
    expect(updater.status).toEqual({ state: "checking" });
    expect(client.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it("reports a failure when the user joins a background check that fails", () => {
    const { client, updater } = createUpdater();
    updater.start();

    updater.check();
    client.emit("error", new Error("offline"));

    expect(updater.status).toEqual({ state: "failed", stage: "check" });
  });

  it("reports a manual check that throws", () => {
    const { client, updater } = createUpdater();
    updater.start();
    client.emit("update-not-available");
    client.checkForUpdates.mockImplementationOnce(() => {
      throw new Error("no feed");
    });

    expect(updater.check()).toEqual({ state: "failed", stage: "check" });
  });

  it("keeps a later background error quiet after a manual check finished", () => {
    const { client, updater } = createUpdater();
    updater.start();
    client.emit("update-not-available");
    updater.check();
    client.emit("update-not-available");

    client.emit("error", new Error("background"));

    expect(updater.status).toEqual({ state: "idle" });
  });

  it("reports a failed download even when a background check found it", () => {
    const { client, updater } = createUpdater();
    updater.start();
    client.emit("update-available");

    client.emit("error", new Error("bad signature"));

    expect(updater.status).toEqual({ state: "failed", stage: "download" });
    updater.check();
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("replaces a check that stalled without a result", () => {
    const { client, updater } = createUpdater();
    updater.start();
    client.emit("update-available");

    vi.advanceTimersByTime(29 * 60 * 1000);
    updater.check();
    expect(client.checkForUpdates).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60 * 1000);
    expect(updater.check()).toEqual({ state: "checking" });
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("keeps a downloaded update when a later error arrives", () => {
    const { client, updater } = createUpdater();
    updater.start();
    client.emit("update-downloaded", {}, "", "0.11.0");

    client.emit("error", new Error("late"));

    expect(updater.status).toEqual({ state: "ready", version: "0.11.0" });
  });

  it("reports a failure after installing has started", () => {
    const { client, onInstallFailed, updater } = createUpdater();
    updater.start();
    client.emit("update-downloaded", {}, "", "0.11.0");

    updater.install();
    client.emit("error", new Error("install failed"));

    expect(updater.installing).toBe(true);
    expect(client.quitAndInstall).toHaveBeenCalledOnce();
    expect(onInstallFailed).toHaveBeenCalledOnce();
  });
});

describe("FakeUpdateClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays one outcome per check and repeats the last one", () => {
    const exit = vi.fn();
    const client = new FakeUpdateClient("current,available", exit);
    const events: string[] = [];
    for (const name of [
      "checking-for-update",
      "update-not-available",
      "update-available",
      "update-downloaded",
      "error",
    ]) {
      client.on(name, () => events.push(name));
    }

    client.checkForUpdates();
    vi.runAllTimers();
    client.checkForUpdates();
    vi.runAllTimers();
    client.checkForUpdates();
    vi.runAllTimers();
    client.quitAndInstall();

    expect(events).toEqual([
      "checking-for-update",
      "update-not-available",
      "checking-for-update",
      "update-available",
      "update-downloaded",
      "checking-for-update",
      "update-available",
      "update-downloaded",
    ]);
    expect(exit).toHaveBeenCalledOnce();
  });
});
