const RELEASES_URL = "https://github.com/fluxmailai/fluxmail-desktop/releases";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface UpdateClient {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "update-downloaded", listener: () => void): unknown;
  setFeedURL(options: { url: string; serverType: "json" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

interface DesktopUpdaterOptions {
  arch: string;
  onReady(): void;
  onInstallFailed(): void;
}

export function updateFeedUrl(arch: string): string {
  return `${RELEASES_URL}/latest/download/RELEASES-darwin-${arch}.json`;
}

export class DesktopUpdater {
  private downloaded = false;
  private installStarted = false;
  private checkTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly client: UpdateClient,
    private readonly options: DesktopUpdaterOptions,
  ) {}

  get ready(): boolean {
    return this.downloaded;
  }

  get installing(): boolean {
    return this.installStarted;
  }

  start(): void {
    this.client.on("error", (error) => {
      console.warn(`Fluxmail could not update: ${error.message}`);
      if (this.installStarted) this.options.onInstallFailed();
    });
    this.client.on("update-downloaded", () => {
      this.downloaded = true;
      clearInterval(this.checkTimer);
      this.options.onReady();
    });
    this.client.setFeedURL({ url: updateFeedUrl(this.options.arch), serverType: "json" });
    this.client.checkForUpdates();
    this.checkTimer = setInterval(() => this.client.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  }

  install(): void {
    this.installStarted = true;
    this.client.quitAndInstall();
  }
}
