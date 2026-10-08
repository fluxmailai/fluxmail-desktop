import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const releaseNotesScript = path.join(process.cwd(), "scripts/release-notes.mjs");

describe("release notes", () => {
  it("renders one committed changelog entry", () => {
    const notes = execFileSync(process.execPath, [releaseNotesScript, "v0.2.0"], {
      encoding: "utf8",
    });

    expect(notes).toContain(
      "## [0.2.0](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.2.0) - 2026-07-20",
    );
    expect(notes).toContain("### Fixed");
    expect(notes).not.toContain("## [0.1.0]");
  });

  it("checks the signing notice", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [releaseNotesScript, "0.2.0", "--signing-mode", "self-signed"],
        { stdio: "pipe" },
      ),
    ).not.toThrow();

    const mismatched = spawnSync(
      process.execPath,
      [releaseNotesScript, "0.2.0", "--signing-mode", "ad-hoc"],
      { encoding: "utf8" },
    );
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("must include the ad hoc signing");
  });

  it("rejects missing changelog entries", () => {
    const missing = spawnSync(process.execPath, [releaseNotesScript, "9.9.9"], {
      encoding: "utf8",
    });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("does not contain a valid 9.9.9 release entry");
  });
});
