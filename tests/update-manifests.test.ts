import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const updateManifestsScript = path.join(process.cwd(), "scripts/update-manifests.mjs");

describe("update manifests", () => {
  let artifactRoot: string;

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("points each architecture at its versioned ZIP", () => {
    artifactRoot = mkdtempSync(path.join(tmpdir(), "fluxmail-manifests-"));
    for (const arch of ["arm64", "x64"]) {
      const zipDirectory = path.join(artifactRoot, "zip/darwin", arch);
      mkdirSync(zipDirectory, { recursive: true });
      writeFileSync(path.join(zipDirectory, `Fluxmail-darwin-${arch}-0.9.0.zip`), "");
    }

    execFileSync(process.execPath, [updateManifestsScript, "v0.9.0", artifactRoot]);

    for (const arch of ["arm64", "x64"]) {
      const manifest = JSON.parse(
        readFileSync(path.join(artifactRoot, `RELEASES-darwin-${arch}.json`), "utf8"),
      );
      expect(manifest.currentRelease).toBe("0.9.0");
      expect(manifest.releases[0].version).toBe("0.9.0");
      expect(manifest.releases[0].updateTo.url).toBe(
        `https://github.com/fluxmailai/fluxmail-desktop/releases/download/v0.9.0/Fluxmail-darwin-${arch}-0.9.0.zip`,
      );
      expect(manifest.releases[0].updateTo.pub_date).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
    }
  });

  it("fails when an architecture's ZIP is missing", () => {
    artifactRoot = mkdtempSync(path.join(tmpdir(), "fluxmail-manifests-"));
    writeFileSync(path.join(artifactRoot, "Fluxmail-darwin-arm64-0.9.0.zip"), "");

    const result = spawnSync(process.execPath, [updateManifestsScript, "v0.9.0", artifactRoot], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fluxmail-darwin-x64-0.9.0.zip is missing");
  });
});
