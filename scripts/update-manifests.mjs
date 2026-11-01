#!/usr/bin/env node

import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const releasesUrl = "https://github.com/fluxmailai/fluxmail-desktop/releases";
const architectures = ["arm64", "x64"];

export function renderUpdateManifest(tag, arch, publishedAt) {
  const version = tag.replace(/^v/, "");
  return {
    currentRelease: version,
    releases: [
      {
        version,
        updateTo: {
          version,
          name: version,
          notes: "",
          // Squirrel.Mac cannot parse fractional seconds.
          pub_date: publishedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
          url: `${releasesUrl}/download/${tag}/Fluxmail-darwin-${arch}-${version}.zip`,
        },
      },
    ],
  };
}

async function main(args) {
  const [tag, artifactRoot] = args;
  if (!tag?.startsWith("v") || !artifactRoot || args.length !== 2) {
    throw new Error("Usage: update-manifests.mjs <tag> <artifact-root>");
  }

  const artifacts = await readdir(artifactRoot, { recursive: true });
  const artifactNames = new Set(artifacts.map((artifact) => path.basename(artifact)));
  const publishedAt = new Date();
  for (const arch of architectures) {
    const manifest = renderUpdateManifest(tag, arch, publishedAt);
    const zipName = path.basename(manifest.releases[0].updateTo.url);
    if (!artifactNames.has(zipName)) throw new Error(`${zipName} is missing from ${artifactRoot}.`);
    await writeFile(
      path.join(artifactRoot, `RELEASES-darwin-${arch}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
