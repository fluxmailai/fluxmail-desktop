import { defineConfig, loadEnv } from "vite";
import { readFileSync } from "node:fs";
import path from "node:path";

export const mainExternalDependencies = ["better-sqlite3", "@node-rs/argon2"];

const mainImportMetaUrlIdentifier = "__fluxmailImportMetaUrl";
export const mainImportMetaUrlIntro = `var ${mainImportMetaUrlIdentifier} = require("node:url").pathToFileURL(__filename).href;`;

export function loadDesktopOAuthConfig(mode: string, root = process.cwd()) {
  const environment = loadEnv(mode, root, "");
  return {
    clientId: environment.FLUXMAIL_DESKTOP_GOOGLE_CLIENT_ID ?? "",
    clientSecret: environment.FLUXMAIL_DESKTOP_GOOGLE_CLIENT_SECRET ?? "",
  };
}

export function loadInstalledFluxmailVersion(root = process.cwd()): string {
  const manifestPath = path.join(root, "node_modules/fluxmail/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error(`Installed Fluxmail package at ${manifestPath} has no version.`);
  }
  return manifest.version;
}

export default defineConfig(({ mode }) => {
  const oauth = loadDesktopOAuthConfig(mode);
  const engineVersion = loadInstalledFluxmailVersion();
  return {
    plugins: [
      {
        name: "fluxmail-installed-version",
        enforce: "pre",
        transform(_source, id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (
            normalizedId.includes("/node_modules/fluxmail/") &&
            normalizedId.endsWith("/dist/version.js")
          ) {
            return `export const VERSION = ${JSON.stringify(engineVersion)};`;
          }
        },
      },
    ],
    define: {
      __FLUXMAIL_GOOGLE_CLIENT_ID__: JSON.stringify(oauth.clientId),
      __FLUXMAIL_GOOGLE_CLIENT_SECRET__: JSON.stringify(oauth.clientSecret),
      // Rolldown leaves import.meta empty in CommonJS output, so give each chunk its own file URL.
      "import.meta.url": mainImportMetaUrlIdentifier,
    },
    build: {
      assetsInlineLimit: 0,
      rolldownOptions: {
        external: mainExternalDependencies,
        output: { intro: mainImportMetaUrlIntro },
      },
    },
  };
});
