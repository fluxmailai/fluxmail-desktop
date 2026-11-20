import { EventEmitter } from "node:events";
import type { UpdateClient } from "./updater";

type FakeUpdateOutcome = "current" | "available" | "error" | "download-error";
const OUTCOMES: readonly string[] = ["current", "available", "error", "download-error"];

export const FAKE_UPDATE_VERSION = "99.0.0";

/**
 * Stands in for Squirrel.Mac in development builds so tests and recordings can reach
 * every update state. `script` is a comma-separated list of outcomes, one per check,
 * such as "current,available". The last outcome repeats. "download-error" finds an
 * update and then fails to download it.
 */
export class FakeUpdateClient extends EventEmitter implements UpdateClient {
  private readonly outcomes: FakeUpdateOutcome[];

  constructor(
    script: string,
    private readonly exit: () => void,
    private readonly delays = { checkMs: 800, downloadMs: 2_000 },
  ) {
    super();
    const outcomes = script
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is FakeUpdateOutcome => OUTCOMES.includes(value));
    this.outcomes = outcomes.length ? outcomes : ["current"];
  }

  setFeedURL(): void {}

  checkForUpdates(): void {
    const outcome = this.outcomes.length > 1 ? this.outcomes.shift()! : this.outcomes[0];
    this.emit("checking-for-update");
    setTimeout(() => {
      if (outcome === "error") {
        this.emit("error", new Error("Fake update check failed."));
        return;
      }
      if (outcome === "current") {
        this.emit("update-not-available");
        return;
      }
      this.emit("update-available");
      setTimeout(() => {
        if (outcome === "download-error") this.emit("error", new Error("Fake download failed."));
        else this.emit("update-downloaded", {}, "", FAKE_UPDATE_VERSION);
      }, this.delays.downloadMs);
    }, this.delays.checkMs);
  }

  quitAndInstall(): void {
    this.exit();
  }
}
