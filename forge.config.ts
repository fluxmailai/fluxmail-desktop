import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { MakerDMG, type MakerDMGConfig } from "@electron-forge/maker-dmg";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import type { ForgeConfig } from "@electron-forge/shared-types";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const packagedPaths = [
  "/.vite",
  "/node_modules/better-sqlite3/LICENSE",
  "/node_modules/better-sqlite3/package.json",
  "/node_modules/better-sqlite3/lib",
  "/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "/node_modules/bindings",
  "/node_modules/file-uri-to-path",
  "/node_modules/@node-rs/argon2",
  "/node_modules/@node-rs/argon2-darwin-arm64",
  "/node_modules/@node-rs/argon2-darwin-x64",
];
export const legalResources = [
  "LICENSE",
  "DISTRIBUTION_NOTICES.md",
  "THIRD_PARTY_NOTICES.md",
  "licenses/ELECTRON_LICENSE",
  "node_modules/electron/dist/LICENSES.chromium.html",
  "node_modules/fluxmail/LICENSE.md",
] as const;
const runFile = promisify(execFile);

type PackagerConfig = NonNullable<ForgeConfig["packagerConfig"]>;
type StrictOsxSignOptions = Exclude<PackagerConfig["osxSign"], boolean | undefined> & {
  continueOnError?: boolean;
};
type MacPackagingConfig = {
  osxSign: StrictOsxSignOptions;
  osxNotarize: PackagerConfig["osxNotarize"];
};

export function createMacPackagingConfig(
  env: Record<string, string | undefined> = process.env,
): MacPackagingConfig {
  const identity = env.APPLE_SIGNING_IDENTITY?.trim();
  const keychain = env.APPLE_SIGNING_KEYCHAIN?.trim();
  const notarizationValues = [env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER];
  const notarizationValueCount = notarizationValues.filter(Boolean).length;

  if (notarizationValueCount !== 0 && notarizationValueCount !== notarizationValues.length) {
    throw new Error("Set all three Apple notarization variables or remove all of them.");
  }
  if (notarizationValueCount && !identity) {
    throw new Error("Apple notarization requires APPLE_SIGNING_IDENTITY.");
  }

  const shouldNotarize = notarizationValueCount === notarizationValues.length;
  if (!identity) {
    return {
      osxSign: {
        identity: "-",
        identityValidation: false,
        optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
      },
      osxNotarize: undefined,
    };
  }

  if (!shouldNotarize) {
    return {
      osxSign: {
        identity,
        ...(keychain ? { keychain } : {}),
        continueOnError: false,
        identityValidation: false,
        optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
      },
      osxNotarize: undefined,
    };
  }

  return {
    osxSign: {
      identity,
      ...(keychain ? { keychain } : {}),
      continueOnError: false,
      optionsForFile: () => ({
        entitlements: path.join(process.cwd(), "build/entitlements.mac.plist"),
        hardenedRuntime: true,
      }),
    },
    osxNotarize: {
      appleApiKey: env.APPLE_API_KEY!,
      appleApiKeyId: env.APPLE_API_KEY_ID!,
      appleApiIssuer: env.APPLE_API_ISSUER!,
    },
  };
}

const macPackagingConfig = createMacPackagingConfig();

export function shouldIgnorePackagedPath(file: string, appRoot = process.cwd()): boolean {
  if (!file) return false;

  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedRoot = path.resolve(appRoot).replaceAll("\\", "/");
  if (normalizedFile === normalizedRoot) return false;

  const rootPrefix = `${normalizedRoot}/`;
  const packagedPath = normalizedFile.startsWith(rootPrefix)
    ? `/${normalizedFile.slice(rootPrefix.length)}`
    : normalizedFile.startsWith("/")
      ? normalizedFile
      : `/${normalizedFile}`;

  return !packagedPaths.some(
    (allowed) =>
      packagedPath === allowed ||
      packagedPath.startsWith(`${allowed}/`) ||
      allowed.startsWith(`${packagedPath}/`),
  );
}

export const dmgMakerConfig = {
  format: "ULFO",
  icon: "build/icon.icns",
  background: "build/dmg-background.png",
  iconSize: 96,
  contents: (options) => [
    { x: 462, y: 233, type: "link", path: "/Applications" },
    { x: 196, y: 233, type: "file", path: options.appPath },
  ],
  additionalDMGOptions: {
    window: { size: { width: 658, height: 498 } },
  },
} satisfies MakerDMGConfig;

const config: ForgeConfig = {
  packagerConfig: {
    asar: { unpack: "**/*.node" },
    executableName: "Fluxmail",
    name: "Fluxmail",
    appBundleId: "ai.fluxmail.desktop",
    appCategoryType: "public.app-category.productivity",
    icon: "build/icon.icns",
    extendInfo: {
      LSMinimumSystemVersion: "13.0",
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
    },
    extraResource: [...legalResources],
    prune: false,
    ignore: shouldIgnorePackagedPath,
    ...macPackagingConfig,
  },
  // postinstall rebuilds the hoisted native module for Electron.
  rebuildConfig: { force: true, ignoreModules: ["better-sqlite3"] },
  hooks: {
    async generateAssets() {
      await runFile("node", ["scripts/generate-third-party-notices.mjs"], { cwd: process.cwd() });
      await runFile("bash", ["scripts/generate-icon.sh"], { cwd: process.cwd() });
      await runFile("swift", ["scripts/generate-dmg-background.swift"], { cwd: process.cwd() });
    },
  },
  makers: [new MakerZIP({}, ["darwin"]), new MakerDMG(dmgMakerConfig, ["darwin"])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // Self-signed builds lose Keychain access on every update, and Fluxmail keeps no sign-ins in cookies.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
