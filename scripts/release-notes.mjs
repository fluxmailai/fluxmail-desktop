#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(repositoryRoot, "CHANGELOG.md");
const validSigningModes = new Set(["ad-hoc", "self-signed", "developer-id"]);

export function renderReleaseNotes(changelog, requestedVersion, signingMode) {
  const version = normalizeVersion(requestedVersion);
  const escapedVersion = escapeRegExp(version);
  const headingPattern = new RegExp(
    `^## \\[${escapedVersion}\\]\\(https://github\\.com/fluxmailai/fluxmail-desktop/releases/tag/v${escapedVersion}\\) - \\d{4}-\\d{2}-\\d{2}\\s*$`,
    "m",
  );
  const heading = headingPattern.exec(changelog);
  if (!heading) throw new Error(`CHANGELOG.md does not contain a valid ${version} release entry.`);

  const remainingChangelog = changelog.slice(heading.index + heading[0].length);
  const nextEntry = remainingChangelog.search(/^## \[/m);
  const bodyEnd = nextEntry < 0 ? changelog.length : heading.index + heading[0].length + nextEntry;
  const notes = `${changelog.slice(heading.index, bodyEnd).trim()}\n`;

  if (signingMode) validateSigningNotice(notes, signingMode);
  return notes;
}

function normalizeVersion(requestedVersion) {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(requestedVersion ?? "");
  if (!match) throw new Error(`Invalid release version: ${requestedVersion || "<missing>"}.`);
  return match[1];
}

function validateSigningNotice(notes, signingMode) {
  if (!validSigningModes.has(signingMode)) throw new Error(`Invalid signing mode: ${signingMode}.`);

  const notice = notes
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^_.+_$/.test(line));
  const hasAdHocNotice = notice?.includes("ad hoc") ?? false;
  const hasSelfSignedNotice = notice?.includes("self-signed certificate") ?? false;
  const saysNotNotarized = notice?.includes("not been notarized by Apple") ?? false;

  if (signingMode === "ad-hoc" && (!hasAdHocNotice || !saysNotNotarized)) {
    throw new Error("The changelog entry must include the ad hoc signing and notarization notice.");
  }
  if (signingMode === "self-signed" && (!hasSelfSignedNotice || !saysNotNotarized)) {
    throw new Error(
      "The changelog entry must include the self-signed certificate and notarization notice.",
    );
  }
  if (
    signingMode === "developer-id" &&
    (hasAdHocNotice || hasSelfSignedNotice || saysNotNotarized)
  ) {
    throw new Error(
      "The changelog entry contains a fallback signing notice for a notarized Developer ID release.",
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(args) {
  const [version, ...options] = args;
  let signingMode;
  if (options.length > 0) {
    if (options.length !== 2 || options[0] !== "--signing-mode") {
      throw new Error("Usage: release-notes.mjs <version> [--signing-mode <mode>]");
    }
    signingMode = options[1];
  }

  const changelog = await readFile(changelogPath, "utf8");
  process.stdout.write(renderReleaseNotes(changelog, version, signingMode));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
