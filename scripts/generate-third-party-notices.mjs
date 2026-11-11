import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md");
const electronLicenseSource = path.join(repositoryRoot, "node_modules/electron/LICENSE");
const electronLicenseOutput = path.join(repositoryRoot, "licenses", "ELECTRON_LICENSE");
const licenseFallbacksPath = path.join(repositoryRoot, "scripts", "third-party-license-fallbacks");
const excludedPackages = new Set(["fluxmail"]);
// Native Argon2 packages share @node-rs/argon2's project and license.
// Keeping their notice under the parent avoids architecture-specific output.
const packagesCoveredByParentNotice = new Set([
  "@node-rs/argon2-darwin-arm64",
  "@node-rs/argon2-darwin-x64",
]);
// Keep immutable upstream sources beside each fallback so license changes can be reviewed.
const reviewedLicenseFallbacks = new Map([
  [
    "@hono/zod-openapi@1.6.3",
    {
      license: "MIT",
      file: "hono-middleware.txt",
      sources: [
        "https://github.com/honojs/middleware/tree/bc7d9e67119f870b5275569b371676663c74c976/packages/zod-openapi",
        "https://github.com/honojs/node-server/blob/3b1dd6875812e0b5aee43ec3fac66c191fd6251f/LICENSE",
      ],
    },
  ],
  [
    "@hono/zod-validator@0.9.1",
    {
      license: "MIT",
      file: "hono-middleware.txt",
      sources: [
        "https://github.com/honojs/middleware/tree/da024821e3d1211f9a280b6cceca78654f99d26b/packages/zod-validator",
        "https://github.com/honojs/node-server/blob/3b1dd6875812e0b5aee43ec3fac66c191fd6251f/LICENSE",
      ],
    },
  ],
  [
    "@pnpm/config.env-replace@1.1.0",
    {
      license: "MIT",
      file: "pnpm-components.txt",
      sources: [
        "https://github.com/pnpm/components/blob/d8c73634415cb24b558c06990846a2d6045c1de7/LICENSE",
      ],
    },
  ],
  [
    "@pnpm/network.ca-file@1.0.2",
    {
      license: "MIT",
      file: "pnpm-components.txt",
      sources: [
        "https://github.com/pnpm/components/blob/4deec61c5389e232c6905e508db93b21ebf26816/LICENSE",
      ],
    },
  ],
  [
    "data-uri-to-buffer@4.0.1",
    {
      license: "MIT",
      file: "data-uri-to-buffer.txt",
      sources: [
        "https://github.com/TooTallNate/node-data-uri-to-buffer/blob/85cd8c854aefbf1bb636789d80364cfac8ea1583/README.md#license",
      ],
    },
  ],
  [
    "drizzle-orm@0.45.4",
    {
      license: "Apache-2.0",
      file: "drizzle-orm.txt",
      sources: [
        "https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/LICENSE",
      ],
    },
  ],
  [
    "eastasianwidth@0.2.0",
    {
      license: "MIT",
      file: "eastasianwidth.txt",
      sources: [
        "https://github.com/komagata/eastasianwidth/blob/b89f04d44dc786885615e94cd6e2ba1ef7866fa4/package.json",
        "https://spdx.org/licenses/MIT.html",
      ],
    },
  ],
]);
// Some packages declare one license in package.json but bundle a notice led by another.
// Prepend the missing declared-license notice while retaining the package's notice.
const reviewedLicenseConflicts = new Map([
  [
    "@pkgjs/parseargs@0.11.0",
    {
      license: "MIT",
      bundledLicense: "Apache-2.0",
      file: "pkgjs-parseargs.txt",
      sources: [
        "https://github.com/pkgjs/parseargs/blob/1e3a94a5f8fd42e7b56ac4a672adcb224ee3c9ff/package.json",
        "https://github.com/pkgjs/parseargs/blob/1e3a94a5f8fd42e7b56ac4a672adcb224ee3c9ff/LICENSE",
        "https://github.com/pkgjs/parseargs/blob/1e3a94a5f8fd42e7b56ac4a672adcb224ee3c9ff/internal/primordials.js",
      ],
    },
  ],
  [
    "@posthog/core@1.63.1",
    {
      license: "MIT",
      bundledLicense: "Apache-2.0",
      file: "posthog-core.txt",
      sources: [
        "https://github.com/PostHog/posthog-js/blob/5ce520f2e44c68ff782f4417840e37ef9642b029/packages/core/package.json",
        "https://github.com/PostHog/posthog-js/blob/5ce520f2e44c68ff782f4417840e37ef9642b029/LICENSE",
      ],
    },
  ],
  [
    "@posthog/types@1.419.0",
    {
      license: "MIT",
      bundledLicense: "Apache-2.0",
      file: "posthog-core.txt",
      sources: [
        "https://github.com/PostHog/posthog-js/blob/e1dc7f07f43bc80dfd135a70dd03e2c8eed1dade/packages/types/package.json",
        "https://github.com/PostHog/posthog-js/blob/e1dc7f07f43bc80dfd135a70dd03e2c8eed1dade/LICENSE",
      ],
    },
  ],
  [
    "posthog-node@5.61.2",
    {
      license: "MIT",
      bundledLicense: "Apache-2.0",
      file: "posthog-core.txt",
      sources: [
        "https://github.com/PostHog/posthog-js/blob/fb0c941cb11c3d6bc2d9b623e6db5f5bae55c122/packages/node/package.json",
        "https://github.com/PostHog/posthog-js/blob/fb0c941cb11c3d6bc2d9b623e6db5f5bae55c122/LICENSE",
      ],
    },
  ],
]);

const licenseSignatures = new Map([
  [
    "MIT",
    /Permission is hereby granted,\s+free of charge,\s+to any person\s+obtaining\s+(?:a\s+)?copy/i,
  ],
  ["Apache-2.0", /Apache License\s+Version 2\.0/i],
]);

function productionPackageKeys() {
  const result = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not read the production dependency licenses.");
  }

  const report = JSON.parse(result.stdout);
  return new Set(
    Object.values(report)
      .flat()
      .flatMap((entry) => entry.versions.map((version) => `${entry.name}@${version}`)),
  );
}

function installedPackages() {
  const packages = new Map();

  function addPackage(packagePath) {
    const manifestPath = path.join(packagePath, "package.json");
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name && manifest.version) {
      packages.set(`${manifest.name}@${manifest.version}`, { manifest, packagePath });
    }
    addModules(path.join(packagePath, "node_modules"));
  }

  function addModules(modulesPath) {
    if (!existsSync(modulesPath)) return;
    for (const entry of readdirSync(modulesPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const entryPath = path.join(modulesPath, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
          if (scopedEntry.isDirectory()) addPackage(path.join(entryPath, scopedEntry.name));
        }
      } else {
        addPackage(entryPath);
      }
    }
  }

  addModules(path.join(repositoryRoot, "node_modules"));
  return packages;
}

function packageLicenseFile(packagePath) {
  const fileName = readdirSync(packagePath)
    .filter((name) => /^(?:licen[cs]e|copying)(?:$|[._-])/i.test(name))
    .sort((left, right) => left.localeCompare(right))[0];
  if (!fileName) return undefined;
  return path.join(packagePath, fileName);
}

function readLicenseText(licensePath) {
  return readFileSync(licensePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function primaryLicense(text) {
  return [...licenseSignatures]
    .map(([license, signature]) => ({ license, index: text.search(signature) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index)[0]?.license;
}

function reviewedIncludedLicenseText(key, license, text) {
  const conflict = reviewedLicenseConflicts.get(key);
  if (!licenseSignatures.has(license)) {
    if (conflict) {
      throw new Error(
        `${key} now declares ${license}, but its reviewed exception expects ${conflict.license}. Review the package license before updating the exception.`,
      );
    }
    return text;
  }

  const bundledLicense = primaryLicense(text);
  if (!bundledLicense || bundledLicense === license) {
    if (conflict) {
      throw new Error(
        `${key} no longer has the reviewed ${license}/${conflict.bundledLicense} license conflict. Review the package and remove or update its exact-version exception.`,
      );
    }
    return text;
  }

  if (!conflict) {
    throw new Error(
      `${key} declares ${license}, but its bundled notice begins with ${bundledLicense}. Review both licenses and add an exact-version exception before generating notices.`,
    );
  }
  if (conflict.license !== license || conflict.bundledLicense !== bundledLicense) {
    throw new Error(
      `${key} now has a ${license}/${bundledLicense} license conflict, but its reviewed exception expects ${conflict.license}/${conflict.bundledLicense}. Review the package before updating the exception.`,
    );
  }

  const addition = readLicenseText(path.join(licenseFallbacksPath, conflict.file));
  const combinedText = [addition, text].filter(Boolean).join("\n\n");
  if (primaryLicense(combinedText) !== license) {
    throw new Error(
      `The reviewed license addition for ${key} does not contain its declared ${license} notice.`,
    );
  }
  return combinedText;
}

function reviewedLicenseText(key, license, installed) {
  const fallback = reviewedLicenseFallbacks.get(key);
  if (!fallback) {
    throw new Error(
      `${key} has no standalone license file or reviewed fallback. Review its license and add an exact-version fallback before generating notices.`,
    );
  }
  if (fallback.license !== license) {
    throw new Error(
      `${key} now declares ${license}, but its reviewed fallback expects ${fallback.license}. Review the package license before updating the fallback.`,
    );
  }

  const texts = [];
  if (fallback.file) {
    texts.push(readLicenseText(path.join(licenseFallbacksPath, fallback.file)));
  }

  if (fallback.package) {
    const sourcePackage = installed.get(fallback.package);
    const sourcePath = sourcePackage && packageLicenseFile(sourcePackage.packagePath);
    if (!sourcePath) {
      throw new Error(
        `The reviewed fallback for ${key} requires ${fallback.package} and its license file. Review the fallback before generating notices.`,
      );
    }
    texts.push(readLicenseText(sourcePath));
  }
  const text = texts.filter(Boolean).join("\n\n");
  if (!text) {
    throw new Error(
      `The reviewed fallback for ${key} has no license text. Add a fallback file or package before generating notices.`,
    );
  }
  return text;
}

function packageNameFromKey(key) {
  return key.slice(0, key.lastIndexOf("@"));
}

function packageLicense(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const licenses = value.map(packageLicense).filter((license) => license !== "Not specified");
    if (licenses.length) return licenses.join(" OR ");
  }
  if (value && typeof value === "object" && "type" in value) {
    return packageLicense(value.type);
  }
  return "Not specified";
}

function packageHomepage(manifest) {
  if (typeof manifest.homepage === "string") return manifest.homepage;
  if (typeof manifest.repository === "string") return manifest.repository;
  if (typeof manifest.repository?.url === "string") return manifest.repository.url;
  return undefined;
}

function productionPackages() {
  const packages = new Map();
  const installed = installedPackages();
  for (const key of productionPackageKeys()) {
    const packageName = packageNameFromKey(key);
    if (
      excludedPackages.has(packageName) ||
      packageName.startsWith("@fluxmail/") ||
      packagesCoveredByParentNotice.has(packageName)
    ) {
      continue;
    }

    const packageInfo = installed.get(key);
    if (!packageInfo) throw new Error(`${key} is missing from node_modules.`);
    const { manifest, packagePath } = packageInfo;
    if (!manifest.name || !manifest.version) continue;

    const licensePath = packageLicenseFile(packagePath);
    if (packages.has(key)) continue;
    const license = packageLicense(manifest.license);
    const includedLicenseText = licensePath && readLicenseText(licensePath);
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license,
      homepage: packageHomepage(manifest),
      text: includedLicenseText
        ? reviewedIncludedLicenseText(key, license, includedLicenseText)
        : reviewedLicenseText(key, license, installed),
    });
  }
  return [...packages.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

function renderNotices(packages) {
  const header = `# Third-party software notices

Fluxmail Desktop includes the packages listed below. Each entry names the license declared by the package and reproduces its bundled or reviewed license notices.

The separately licensed Fluxmail engine is documented in \`DISTRIBUTION_NOTICES.md\`. Its license is included in the application resources as \`LICENSE.md\`.

This file is generated by \`pnpm notices:generate\`. Do not edit it by hand.
  `;
  const entries = packages.map((entry) => {
    const project = entry.homepage ? `\nProject: ${entry.homepage}` : "";
    const licenseText = entry.text ? `\n\n${entry.text}` : "";
    return `## ${entry.name} ${entry.version}

Declared license: ${entry.license}${project}${licenseText}
`;
  });
  return `${header.trimEnd()}\n\n${entries.join("\n")}`;
}

writeFileSync(outputPath, renderNotices(productionPackages()));
mkdirSync(path.dirname(electronLicenseOutput), { recursive: true });
writeFileSync(electronLicenseOutput, readFileSync(electronLicenseSource, "utf8"));
