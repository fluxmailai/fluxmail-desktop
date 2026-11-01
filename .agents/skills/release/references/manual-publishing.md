# Manual publishing and release repair

Use this path only when GitHub Actions is unavailable for an infrastructure reason and the user has approved manual publishing, or when the user explicitly asks to replace assets on an existing release. For a failed tag that has no GitHub Release, return to the main skill and follow the separate tag-recovery procedure.

## Contents

- [Preconditions](#preconditions)
- [Build both architectures](#build-both-architectures)
- [Verify the app bundles](#verify-the-app-bundles)
- [Verify the archives](#verify-the-archives)
- [Diagnose macOS launch failures](#diagnose-macos-launch-failures)
- [Publish a new release manually](#publish-a-new-release-manually)
- [Replace an existing release](#replace-an-existing-release)
- [Verify GitHub after publishing](#verify-github-after-publishing)

## Preconditions

Require the complete local release preflight to pass. Do not use manual publishing to work around failing tests, broken packaging, branch protection, or missing permissions.

Build from the exact recorded release SHA. Require a clean separation between release changes and unrelated user work. Confirm the tag resolves to that SHA before publishing.

Prepare and commit the Common Changelog entry described in the main skill. Confirm the signing mode before building:

- Use Developer ID signing, hardened runtime, and notarization when all Apple credentials are configured.
- Use the persistent Fluxmail self-signed certificate without hardened runtime or notarization when only the signing credentials are configured.
- Use ad hoc signing without hardened runtime or notarization when Apple credentials are absent.

## Build both architectures

Build both `arm64` and `x64` DMGs and ZIPs. Do not assume that passing a JavaScript build proves the native dependencies have the requested architecture.

On Apple Silicon, build the native module for each target before running Forge:

```sh
pnpm exec electron-rebuild -f -w better-sqlite3 --arch=arm64
pnpm exec electron-forge make --arch=arm64

pnpm exec electron-rebuild -f -w better-sqlite3 --arch=x64
NODE_OPTIONS=--max-old-space-size=4096 \
  pnpm exec electron-forge make --arch=x64
```

If the x64 rebuild invokes an arm64 Node process, use an official x64 Node toolchain matching the repository's pinned Node version for the rebuild. Run it under Rosetta if needed. Verify any manually acquired toolchain against the publisher's checksum.

Forge's packaged dependencies may include separate architecture packages such as `@node-rs/argon2-darwin-x64`. Confirm the requested package exists before building. Do not copy an unverified native binary from another project.

The root `better-sqlite3` binary changes architecture during this process. Restore it to the host architecture after producing both targets so the workspace remains usable.

## Verify the app bundles

For each packaged app, inspect the executable and unpacked native modules:

```sh
file out/Fluxmail-darwin-<arch>/Fluxmail.app/Contents/MacOS/Fluxmail
rg --files --hidden --no-ignore \
  out/Fluxmail-darwin-<arch>/Fluxmail.app/Contents/Resources \
  | rg '(better_sqlite3|argon2\.[^/]+)\.node$'
codesign --verify --deep --strict \
  out/Fluxmail-darwin-<arch>/Fluxmail.app
```

Run `file` on the executable, `better_sqlite3.node`, and the target-specific `argon2-darwin-<arch>` binary. Require `arm64` for the Apple Silicon target and `x86_64` for the Intel target. The bundle may contain an unused Argon2 package for the other architecture; do not treat that extra package as the module Electron will load.

Inspect the outer app and the Electron framework:

```sh
codesign -dv --verbose=4 \
  out/Fluxmail-darwin-<arch>/Fluxmail.app
codesign -dv --verbose=4 \
  "out/Fluxmail-darwin-<arch>/Fluxmail.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
```

For an ad hoc build, require all of the following:

- `Signature=adhoc`
- `TeamIdentifier=not set`
- `CodeDirectory` flags contain `adhoc` but not `runtime`
- The outer app and nested frameworks use the same signing mode

For a self-signed build, require all of the following:

- `Authority=Fluxmail Self-Signed Code Signing`
- `TeamIdentifier=not set`
- `CodeDirectory` flags do not contain `adhoc` or `runtime`
- The outer app and nested frameworks use the same certificate
- `codesign -d -r-` contains the bundle identifier and the persistent certificate hash
- The designated requirement is identical across `arm64` and `x64` builds

Do not replace the persistent certificate when rebuilding. A new private key changes the designated requirement, so installed apps reject the update and macOS Keychain treats the app as a different program.

Launch each packaged app with isolated temporary data and user-data directories. Keep it running long enough to detect an immediate dyld or native-module crash, then terminate it cleanly. On Apple Silicon, confirm Rosetta is available before testing the x64 app:

```sh
arch -x86_64 uname -m
```

Do not substitute `open Fluxmail.app` for the packaged app smoke test. Launch the executable directly so its exit status and logs can be inspected.

## Verify the archives

Generate the update manifests, then run the bundled verifier against all six artifacts before uploading:

```sh
node scripts/update-manifests.mjs "<tag>" out/make
.agents/skills/release/scripts/verify-release-artifacts.sh \
  "<version>" out/make "<signing-mode>"
```

The verifier mounts each DMG and extracts each ZIP before checking the app's architecture, native modules, signing metadata, designated requirement, and launch behavior. It also records the SHA-256 digest and byte size of every file. Upload the canonical filenames without suffixes such as `-fixed`, `-adhoc`, or `-retry`.

## Diagnose macOS launch failures

Treat "Fluxmail is damaged and can't be opened" as a signing, bundle-integrity, or quarantine signal until proven otherwise. Inspect:

```sh
codesign --verify --deep --strict --verbose=4 Fluxmail.app
spctl --assess --type execute --verbose=4 Fluxmail.app
xattr -lr Fluxmail.app
```

Treat "Fluxmail cannot be opened because of a problem" as a likely launch crash. Read the newest Fluxmail report under `~/Library/Logs/DiagnosticReports/`. Check dyld messages, native-module architecture, and signing metadata.

If dyld reports different Team IDs between the app and Electron Framework, the ad hoc build probably retained hardened runtime on one or more nested files. Fix the Forge signing configuration with `optionsForFile: () => ({ hardenedRuntime: false })`, rebuild from scratch, and verify the outer app and Electron Framework again.

Do not publish instructions to strip quarantine as the release fix. Removing quarantine is useful only as a diagnostic comparison. Ad hoc and self-signed apps still require manual approval in macOS and cannot be notarized.

## Publish a new release manually

Confirm the remote tag and its peeled commit one final time. Render the committed changelog entry to a temporary file, then create the release with the six verified files:

```sh
notes_path=$(mktemp)
trap 'rm -f "$notes_path"' EXIT
pnpm release:notes "<version>" > "$notes_path"

gh release create "<tag>" \
  out/make/Fluxmail-<version>-arm64.dmg \
  out/make/Fluxmail-<version>-x64.dmg \
  out/make/zip/darwin/arm64/Fluxmail-darwin-arm64-<version>.zip \
  out/make/zip/darwin/x64/Fluxmail-darwin-x64-<version>.zip \
  out/make/RELEASES-darwin-arm64.json \
  out/make/RELEASES-darwin-x64.json \
  --verify-tag \
  --notes-file "$notes_path"
```

Do not use `--generate-notes`. It does not produce the required Common Changelog body and may add contributor sections.

## Replace an existing release

Require an explicit request to replace the release or its assets. Preserve the release record and tag. Do not delete the release, delete the tag, recreate the tag, or move it.

Before replacement:

1. Record the local tag commit, remote tag object, and remote peeled commit.
2. Read the release body and asset metadata.
3. Verify the six local replacements and their canonical filenames.
4. Prepare and commit the updated Common Changelog entry, including the correct signing notice.

Replace all six artifacts together so the release has one consistent signing and packaging policy:

```sh
gh release upload "<tag>" \
  out/make/Fluxmail-<version>-arm64.dmg \
  out/make/Fluxmail-<version>-x64.dmg \
  out/make/zip/darwin/arm64/Fluxmail-darwin-arm64-<version>.zip \
  out/make/zip/darwin/x64/Fluxmail-darwin-x64-<version>.zip \
  out/make/RELEASES-darwin-arm64.json \
  out/make/RELEASES-darwin-x64.json \
  --clobber

notes_path=$(mktemp)
trap 'rm -f "$notes_path"' EXIT
pnpm release:notes "<version>" > "$notes_path"
gh release edit "<tag>" --notes-file "$notes_path"
```

## Verify GitHub after publishing

Read the final release metadata. Require exactly six uploaded assets with the expected names:

```sh
gh release view "<tag>" \
  --json tagName,url,isDraft,isPrerelease,body,assets
```

Compare each GitHub `assets[].digest` value with the local SHA-256 value. Confirm the body exactly matches `pnpm release:notes "<version>"`.

Read the remote tag object and peeled commit again. For replacement releases, compare them with the values recorded before `--clobber`. Stop and report any mismatch.
