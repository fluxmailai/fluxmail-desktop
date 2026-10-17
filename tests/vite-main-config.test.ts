import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION as reportedFluxmailEngineVersion } from "fluxmail";
import {
  loadDesktopOAuthConfig,
  loadInstalledFluxmailVersion,
  mainExternalDependencies,
} from "../vite.main.config";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("main Vite configuration", () => {
  it("uses the pinned Fluxmail npm package", () => {
    expect(loadInstalledFluxmailVersion()).toBe(reportedFluxmailEngineVersion);
    expect(reportedFluxmailEngineVersion).toBe("0.15.0");
  });

  it("leaves native dependencies for Electron to load", () => {
    expect(mainExternalDependencies).toEqual(["better-sqlite3", "@node-rs/argon2"]);
  });

  it("loads desktop OAuth credentials from .env", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fluxmail-vite-env-"));
    directories.push(directory);
    writeFileSync(
      path.join(directory, ".env"),
      "FLUXMAIL_DESKTOP_GOOGLE_CLIENT_ID=desktop-client\nFLUXMAIL_DESKTOP_GOOGLE_CLIENT_SECRET=desktop-secret\n",
    );

    const previousClientId = process.env.FLUXMAIL_DESKTOP_GOOGLE_CLIENT_ID;
    const previousClientSecret = process.env.FLUXMAIL_DESKTOP_GOOGLE_CLIENT_SECRET;
    delete process.env.FLUXMAIL_DESKTOP_GOOGLE_CLIENT_ID;
    delete process.env.FLUXMAIL_DESKTOP_GOOGLE_CLIENT_SECRET;
    try {
      expect(loadDesktopOAuthConfig("development", directory)).toEqual({
        clientId: "desktop-client",
        clientSecret: "desktop-secret",
      });
    } finally {
      restoreEnvironment("FLUXMAIL_DESKTOP_GOOGLE_CLIENT_ID", previousClientId);
      restoreEnvironment("FLUXMAIL_DESKTOP_GOOGLE_CLIENT_SECRET", previousClientSecret);
    }
  });
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
