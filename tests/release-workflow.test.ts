import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(
  path.join(process.cwd(), ".github/workflows/release.yml"),
  "utf8",
);

describe("Release workflow", () => {
  it("does not mutate macOS trust settings for self-signed builds", () => {
    expect(releaseWorkflow).not.toContain("security add-trusted-cert");
  });

  it("publishes the committed changelog entry", () => {
    expect(releaseWorkflow).toContain('node scripts/release-notes.mjs "${GITHUB_REF_NAME}"');
    expect(releaseWorkflow).toContain('--notes-file "$RUNNER_TEMP/release-notes.md"');
    expect(releaseWorkflow).not.toContain("--generate-notes");
  });

  it("publishes the update manifests with the release", () => {
    expect(releaseWorkflow).toContain(
      'node scripts/update-manifests.mjs "${GITHUB_REF_NAME}" release',
    );
    expect(releaseWorkflow).toContain("-name 'RELEASES-darwin-*.json'");
  });
});
