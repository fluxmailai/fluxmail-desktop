import { updateStatusSchema, type UpdateStatus } from "../shared/contracts";

const RELEASES_URL = "https://github.com/fluxmailai/fluxmail-desktop/releases";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Squirrel downloads an update once per check, so a running check is joined rather than
// repeated. One that sends no result for this long has stalled and may be replaced.
const STALLED_CHECK_MS = 30 * 60 * 1000;

export interface UpdateClient {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "update-available", listener: () => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(
    event: "update-downloaded",
    listener: (event: unknown, releaseNotes: string, releaseName: string) => void,
  ): unknown;
  setFeedURL(options: { url: string; serverType: "json" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

interface DesktopUpdaterOptions {
  arch: string;
  onStatus(status: UpdateStatus): void;
  onInstallFailed(): void;
}

function checkFailedStatus(manual: boolean): UpdateStatus {
  return manual ? { state: "failed", stage: "check" } : { state: "idle" };
}

export function updateFeedUrl(arch: string): string {
  return `${RELEASES_URL}/latest/download/RELEASES-darwin-${arch}.json`;
}

export class DesktopUpdater {
  private current: UpdateStatus = { state: "idle" };
  private statusChangedAt = Date.now();
  // Only a check the user asked for reports a failed check. Background checks fail quietly.
  private manualCheck = false;
  private installStarted = false;
  private checkTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly client: UpdateClient,
    private readonly options: DesktopUpdaterOptions,
  ) {}

  get status(): UpdateStatus {
    return this.current;
  }

  get ready(): boolean {
    return this.current.state === "ready";
  }

  get installing(): boolean {
    return this.installStarted;
  }

  start(): void {
    this.client.on("error", (error) => {
      console.warn(`Fluxmail could not update: ${error.message}`);
      if (this.installStarted) {
        this.options.onInstallFailed();
        return;
      }
      // A downloaded update is still installed on the next launch, so keep offering it.
      if (this.ready) return;
      const manual = this.manualCheck;
      this.manualCheck = false;
      // The sidebar showed this download, so its failure is reported even for a background check.
      if (this.current.state === "downloading") {
        this.setStatus({ state: "failed", stage: "download" });
      } else {
        this.setStatus(checkFailedStatus(manual));
      }
    });
    this.client.on("update-available", () => {
      if (!this.ready) this.setStatus({ state: "downloading" });
    });
    this.client.on("update-not-available", () => {
      this.manualCheck = false;
      if (!this.ready) this.setStatus({ state: "current" });
    });
    this.client.on("update-downloaded", (_event, _releaseNotes, releaseName) => {
      this.manualCheck = false;
      clearInterval(this.checkTimer);
      const withVersion = updateStatusSchema.safeParse({
        state: "ready",
        version: typeof releaseName === "string" ? releaseName.trim() : undefined,
      });
      this.setStatus(withVersion.success ? withVersion.data : { state: "ready" });
    });
    this.client.setFeedURL({ url: updateFeedUrl(this.options.arch), serverType: "json" });
    this.check(false);
    this.checkTimer = setInterval(() => this.check(false), UPDATE_CHECK_INTERVAL_MS);
  }

  check(manual = true): UpdateStatus {
    const state = this.current.state;
    if (this.installStarted || state === "ready") return this.current;
    const running = state === "checking" || state === "downloading";
    if (running && Date.now() - this.statusChangedAt < STALLED_CHECK_MS) {
      if (state === "checking") this.manualCheck ||= manual;
      return this.current;
    }
    this.manualCheck = manual;
    this.setStatus({ state: "checking" });
    try {
      this.client.checkForUpdates();
    } catch (error) {
      console.warn(
        `Fluxmail could not check for updates: ${error instanceof Error ? error.message : error}`,
      );
      this.manualCheck = false;
      this.setStatus(checkFailedStatus(manual));
    }
    return this.current;
  }

  install(): void {
    this.installStarted = true;
    this.client.quitAndInstall();
  }

  private setStatus(status: UpdateStatus): void {
    this.current = status;
    this.statusChangedAt = Date.now();
    this.options.onStatus(status);
  }
}
