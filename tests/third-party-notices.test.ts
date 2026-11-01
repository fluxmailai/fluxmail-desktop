import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

execFileSync("node", ["scripts/generate-third-party-notices.mjs"]);
const notices = readFileSync(path.join(process.cwd(), "THIRD_PARTY_NOTICES.md"), "utf8");

function noticeFor(packageName: string): string {
  const heading = `## ${packageName} `;
  const headingIndex = notices.indexOf(`\n${heading}`);
  if (headingIndex < 0) throw new Error(`Could not find the notice for ${packageName}.`);
  const start = headingIndex + 1;
  const end = notices.indexOf("\n## ", start + heading.length);
  return notices.slice(start, end < 0 ? undefined : end).trim();
}

describe("third-party software notices", () => {
  it("uses the parent Argon2 notice for both release architectures", () => {
    expect(noticeFor("@node-rs/argon2")).toContain("Declared license: MIT");
    expect(notices).not.toMatch(/^## @node-rs\/argon2-darwin-(?:arm64|x64) /m);
  });

  it("normalizes legacy object-valued license metadata", () => {
    expect(noticeFor("config-chain")).toContain("Declared license: MIT");
    expect(notices).not.toContain("[object Object]");
  });

  it("uses reviewed fallbacks when packages omit their license files", () => {
    expect(noticeFor("@posthog/core")).toContain("Copyright 2020 Posthog / Hiberly, Inc.");
    expect(noticeFor("@posthog/core")).toContain("Permission is hereby granted");
    expect(noticeFor("@posthog/core")).toContain("Apache License");
    expect(noticeFor("drizzle-orm")).toContain("Apache License");
    expect(noticeFor("eastasianwidth")).toContain("Copyright (c) 2013 Masaki Komagata");
  });

  it("preserves reviewed notices when package metadata conflicts with the bundled license", () => {
    for (const packageName of ["@pkgjs/parseargs", "@posthog/types", "posthog-node"]) {
      const notice = noticeFor(packageName);
      expect(notice).toContain("Declared license: MIT");
      expect(notice).toContain("Permission is hereby granted");
      expect(notice).toContain("Apache License");
    }
  });

  it("includes a license body for every package", () => {
    const entries = notices.split(/^## /m).slice(1);

    for (const entry of entries) {
      const body = entry
        .split("\n")
        .slice(1)
        .filter(
          (line) => line && !line.startsWith("Declared license: ") && !line.startsWith("Project: "),
        );
      expect(body, entry.split("\n")[0]).not.toHaveLength(0);
    }
  });
});
