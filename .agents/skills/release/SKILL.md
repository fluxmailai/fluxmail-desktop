---
name: release
description: Cut, publish, repair, or replace a Fluxmail Desktop GitHub release from the repository's main branch. Use when the user invokes $release, asks to choose or bump a version, cut or publish a release, push a Fluxmail version tag, run the full preflight, handle the pull request, merge, tag, GitHub Actions, and artifact verification workflow, or rebuild or replace existing release assets.
---

# Release

Choose the release version only from user-visible changes since the latest published release unless the user supplies a version. Update the root `package.json` when the selected version differs. Treat an invocation of this skill as authorization to inspect the release, edit release files, run checks, commit the prepared changes, push the workspace branch, open or update its pull request, and monitor pull request checks. It does not authorize merging the release pull request, pushing a version tag, or publishing a GitHub Release. Request explicit approval with the complete written changelog before any of those actions.

Do not expose secret values, force-push, or bypass branch protection. Treat existing tags as immutable during the normal release workflow. Stop when a required review, credential, or repository permission needs the user. Require a separate explicit request before replacing assets on an existing release or recovering a failed tag.

## 1. Inspect the release state

Run these checks before changing anything:

```sh
git status --short --branch
git status --porcelain=v1 --untracked-files=all
git remote -v
git fetch origin --prune --tags
git log -1 --oneline --decorate
git diff --check
node -p "require('./package.json').version"
gh repo view --json nameWithOwner,defaultBranchRef,url
gh secret list --app actions
```

Require the porcelain status command to return no output before continuing. Treat staged changes, unstaged changes, and untracked files as blockers. Stop and report the affected paths. Do not stash, discard, commit, or include pre-existing work in the release. After this check passes, only edits made by the release workflow may dirty the worktree.

Require the default branch to be `main` and use `origin/main` as the release source. Do not switch or rename the current Conductor workspace branch.

Use an explicitly requested version when provided. Otherwise, find the latest published, non-prerelease GitHub Release whose tag is an ancestor of `origin/main`. Require its tag to contain a valid semantic version, then inspect the complete first-parent log and diff from that tag through `origin/main`:

```sh
git log --first-parent --oneline "<baseline-tag>..origin/main"
git diff "<baseline-tag>..origin/main"
```

For the first release, when no eligible baseline exists, audit the full history and use the valid, unclaimed version in `package.json`.

Review behavior that users can observe while installing, configuring, or using Fluxmail. Treat a change as release-worthy only when it changes that experience. Ignore internal refactors, tests, internal documentation, CI and release tooling, dependency churn, and code-only changes that leave user-visible behavior unchanged. Do not infer user impact from the size or complexity of an implementation.

Choose the minimum compatible semantic version from the user-visible changes:

- At `1.0.0` or later, use a major bump for a breaking public contract.
- Before `1.0.0`, use a minor bump for a breaking public contract.
- Use a minor bump for backward-compatible functionality.
- Use a patch bump for backward-compatible fixes only.
- Ignore public contract changes that no supported user workflow or integration can observe.

Choose the version without asking when the evidence is clear. Report the baseline, audited range, user-visible compatibility findings, excluded internal work, and selected version before editing files. Stop if there is no user-visible change to release. Ask only when the compatibility impact is genuinely ambiguous.

Normalize the selected tag to `v<version>` and require a valid semantic version. If the selected version differs from `package.json`, update the manifest with:

```sh
pnpm version <version> --no-git-tag-version
```

Include the version change in the release pull request. A remote tag or published release matching the current package version is the release baseline, not a reason to ask for a version. Never select a version that already has a local tag, remote tag, or GitHub Release.

Check local tags, remote tags, and GitHub Releases:

```sh
git tag --list "<tag>"
git ls-remote --tags origin "refs/tags/<tag>" "refs/tags/<tag>^{}"
gh release view "<tag>" --json tagName,url,isDraft,isPrerelease,body,assets
```

Stop a new-release workflow if the target tag exists. Handle an existing tag according to its state:

- If a GitHub Release exists, never move the tag. With a separate explicit request, replace its assets by following [manual publishing and release repair](references/manual-publishing.md).
- If no GitHub Release exists, prefer fixing the problem and choosing a new version. Reuse the version only when the user separately and explicitly authorizes destructive tag recovery after reviewing the old and replacement commits. Follow [failed tag recovery](references/tag-recovery.md).

Record the tag object, peeled commit, release metadata, asset names, and digests before any repair.

## 2. Validate credentials and signing mode

Read secret names only. Never request or print their values.

Google OAuth overrides are optional. Accept either none or both of these:

- `FLUXMAIL_DESKTOP_GOOGLE_CLIENT_ID`
- `FLUXMAIL_DESKTOP_GOOGLE_CLIENT_SECRET`

With neither Google secret, use the OAuth app included in the pinned Fluxmail npm package. Confirm that `package.json` and the lockfile resolve a published version with default OAuth support. A pending change in the Fluxmail repository is not enough. Stop if only one Google override is configured or if the installed package still requires manual Google credentials.

Apple certificate signing is optional. Treat these as the signing group:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`

Treat these as the notarization group:

- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Accept one of three modes:

- With neither group, require ad hoc signing and no notarization.
- With the complete signing group only, require the persistent self-signed Fluxmail identity, no hardened runtime, and no notarization.
- With both complete groups, require Developer ID signing, hardened runtime, and notarization.

Stop if either group is partial or the notarization group is present without the signing group. Never create a new self-signed identity during a release. Reuse the encrypted P12 so each version keeps the same certificate and designated requirement. The maintainer confirmed on 2026-09-16 that a private backup of the current P12 and its password exists outside GitHub. Do not ask for this confirmation again during routine releases. If the signing identity or P12 secrets are replaced, confirm that the replacement has a private backup before releasing because repository secrets cannot be downloaded later.

Do not describe fallback builds as unsigned. For ad hoc signing in `forge.config.ts`, use an explicit identity and disable hardened runtime and timestamping for every signed file:

```ts
osxSign: {
  identity: "-",
  identityValidation: false,
  optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
},
osxNotarize: undefined,
```

Do not use `osxSign: true` for this fallback. It searches for a signing identity. Do not rely on a top-level `hardenedRuntime: false`; use `optionsForFile` so nested Electron frameworks receive the same setting. Add or retain a config test that checks this behavior.

For a self-signed build, set `APPLE_SIGNING_IDENTITY`, set `identityValidation: false`, disable hardened runtime and timestamping for every signed file, and leave notarization undefined. `@electron/osx-sign` otherwise searches the generic identity policy, which does not return this code-signing-only identity. Keep `continueOnError: false` so Forge cannot silently emit a broken fallback bundle. The default designated requirement must contain the stable bundle identifier and the self-signed certificate hash. Verify that requirement on both architectures with `codesign -d -r-`. Do not add `anchor trusted`; recipients do not trust a private certificate.

## 3. Prepare the release notes

Keep release notes in the tracked root `CHANGELOG.md`. Move the user-visible changes for the release from `Unreleased` into a dated version entry and update the `Unreleased` comparison link. Follow [Common Changelog](https://common-changelog.org/):

```markdown
# Changelog

## [Unreleased](https://github.com/fluxmailai/fluxmail-desktop/compare/v<version>...HEAD)

## [<version>](<release-url>) - YYYY-MM-DD

_<Signing and notarization notice, when needed>_

### Added

- Describe a user-visible change ([#123](<pull-request-url>))
```

Include only changes that users can observe. Omit refactors, implementation details, tests, internal documentation, CI work, release tooling, and dependency or code-only changes with no user-visible effect. Describe what changes for the user, not how the code changed. If a changelog entry cannot state a concrete user-facing effect, omit it.

Use only relevant Common Changelog sections, in this order: `Changed`, `Added`, `Removed`, and `Fixed`. Write each change as one self-describing line that starts with a present-tense imperative verb. Put linked pull requests or commits at the end of the same line. Sort changes by importance.

Use at most one single-sentence notice before the change groups. Do not add `Contributors`, `New contributors`, or similar credit sections. Do not use GitHub's generated notes as the final release body. Render the exact GitHub Release body from the committed changelog entry:

```sh
pnpm release:notes "<version>"
```

Require this command to succeed. The release workflow reads the same entry from the tagged commit and validates its signing notice against the configured signing mode.

For an ad hoc-signed release, include this notice:

> First release; these artifacts use ad hoc signatures and have not been notarized by Apple, so macOS will require approval before opening the app.

Adjust `First release` for later versions. Do not claim that ad hoc signing prevents all Gatekeeper prompts.

For a self-signed release, replace `ad hoc signatures` with `Fluxmail's self-signed certificate`. State that Apple has not notarized the artifacts and macOS will still require approval. Do not claim that a self-signed certificate makes Gatekeeper trust the app. Note during handoff that the first self-signed build may prompt once for existing Keychain items before later builds inherit access.

## 4. Run the release preflight

Build the exact candidate tree in a temporary clean clone before running tests. This prevents an existing `node_modules` directory or an earlier Electron invocation from hiding an incomplete install:

```sh
pnpm install --frozen-lockfile
.agents/skills/release/scripts/verify-clean-install.sh
pnpm notices:check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm release:notes "<version>"
pnpm test:e2e
```

The clean-install script copies the current tracked and untracked candidate files into a temporary clone, applies the complete worktree diff, installs with the frozen lockfile, checks Electron's installed resources, and runs `pnpm make` before any test can invoke Electron. Require it to produce a DMG and ZIP for the host architecture.

Run `pnpm test:e2e` because every release affects the packaged Electron application.

If a check fails, diagnose it. Fix failures caused by release-related changes, rerun the narrow check, then rerun the full preflight. Do not absorb unrelated user changes into the release.

## 5. Prepare the release pull request

Review the changes made by the release workflow before committing them:

```sh
git status --short
git diff --stat HEAD
git diff HEAD
git diff --check
```

Require every reported change to have been created by this release workflow and to belong in the release pull request. If any other change appears, stop and report it.

If the workflow created release-related changes, including the version update and `CHANGELOG.md` entry:

1. Stage only the intended files.
2. Commit with a concise message that describes the change.

After committing, run `git status --porcelain=v1 --untracked-files=all` again and require no output. Stop and report anything left in the worktree. Then compare the committed pull request content from the merge base:

```sh
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
git log --oneline origin/main..HEAD
```

If the branch contains release-related changes that are not on `origin/main`:

1. Push the current branch without renaming it.
2. Create or reuse a pull request targeting `main`.
3. Watch all pull request checks to completion.

Use `gh pr status`, `gh pr view`, and `gh pr checks --watch` as appropriate. Do not merge the pull request in this step. If branch protection requires human review, report the pull request URL and wait instead of bypassing it.

If pull request checks cannot run because of billing, quota, or a service outage, confirm that the jobs did not start and that the full local preflight passed. Carry the local fallback as a separate request in the approval packet. Do not treat an infrastructure failure as a passing check.

## 6. Request publication approval

After the complete changelog is written, the full local preflight passes, the worktree is clean, and all pull request checks pass, present an approval packet. If pull request checks were blocked by a confirmed infrastructure failure, present the packet only after the full local preflight passes and identify the proposed local fallback.

Include:

- The selected version and its user-visible compatibility reasoning.
- The complete output of `pnpm release:notes "<version>"` exactly as it will appear on GitHub, including the signing notice.
- A concise list of audited changes excluded because users cannot observe them.
- The pull request URL, a concise summary of its committed diff, and its check results.
- The proposed tag and signing mode.
- Any request to substitute local checks or local publishing for unavailable GitHub Actions.

Paste the complete changelog into the approval request instead of linking only to the file. Ask the user to approve or reject that exact release. Do not merge the pull request, push the tag, dispatch a release workflow, create a GitHub Release, or upload assets before clear approval. A new invocation of this skill is not publication approval. Treat a direct response such as `approve` as authorization to merge and publish the reviewed release.

Approval expires if the version, changelog, pull request diff, or signing mode changes. Present the revised approval packet and ask again before continuing.

## 7. Merge the approved release

After approval, confirm that the pull request diff, head SHA, and rendered changelog entry still match the approval packet and that all required checks still pass. Merge with the repository's allowed method. Prefer squash merge for this repository and do not delete the workspace branch.

Use `gh pr view` and `gh pr merge --squash` as appropriate. If branch protection requires human review, report the pull request URL and wait instead of bypassing it.

After merging, fetch `origin/main` again. Wait for the `CI` workflow on the exact release commit to pass. Record the full release SHA:

```sh
git fetch origin --prune --tags
release_sha=$(git rev-parse origin/main)
```

Do not tag a commit while its main-branch CI run is pending or failing because of code or tests. If GitHub Actions cannot run because of billing, quota, or a service outage, distinguish that infrastructure failure from a test failure. After the complete local preflight passes, ask for explicit authorization to substitute local CI and publish manually unless the approved release packet already named that fallback. Follow [manual publishing and release repair](references/manual-publishing.md) only after the user approves that fallback.

## 8. Create the release tag

Create an annotated tag on the recorded `origin/main` SHA, then verify it before pushing:

```sh
git tag -a "<tag>" "$release_sha" -m "Fluxmail <tag>"
git rev-list -n 1 "<tag>"
git push origin "<tag>"
```

The tag push is the release event. The workflow at `.github/workflows/release.yml` builds Apple Silicon and Intel artifacts, renders the release notes from the tagged `CHANGELOG.md`, and publishes the matching GitHub Release.

## 9. Monitor the release workflow

Find the `Release` workflow run for both the target tag and recorded SHA. Do not assume the newest run belongs to this release. Watch it until completion:

```sh
gh run list --workflow release.yml --limit 20 \
  --json databaseId,headBranch,headSha,status,conclusion,url
gh run watch <run-id> --exit-status
```

If the run fails, inspect it with `gh run view <run-id> --log-failed`. Rerun failed jobs once only when the failure is clearly transient. DNS resolution errors, connection resets, timeouts while fetching GitHub-hosted dependencies, and runner startup failures qualify. Missing files, invalid configuration, signing failures, architecture mismatches, and reproducible packaging errors do not. Do not rerun a deterministic failure without a fix.

If code, configuration, signing, or packaging caused the failure, fix it through a new pull request and choose a new version. Only reuse the failed version through the separately authorized [failed tag recovery](references/tag-recovery.md) procedure.

If the workflow cannot run because of billing, quota, or a service outage, and the user authorizes a manual release, follow [manual publishing and release repair](references/manual-publishing.md). A manual release must meet the same architecture, signing, packaging, notes, and verification requirements as the workflow.

## 10. Verify the published release

Render the expected notes from the release commit and read the published body:

```sh
expected_notes=$(pnpm --silent release:notes "<version>")
published_notes=$(gh release view "<tag>" --json body --jq .body)
test "$published_notes" = "$expected_notes"
gh release view "<tag>" \
  --json tagName,url,isDraft,isPrerelease,body,assets

release_assets=$(mktemp -d)
trap 'rm -rf "$release_assets"' EXIT
gh release download "<tag>" --dir "$release_assets"
.agents/skills/release/scripts/verify-release-artifacts.sh \
  "<version>" "$release_assets" "<signing-mode>" "<tag>"
```

Confirm:

- The tag matches the requested version and still resolves to the recorded release SHA.
- The release is published, not a draft or prerelease.
- The body exactly matches the committed Common Changelog entry and has no contributor sections.
- There are two DMGs and two ZIPs.
- Both `arm64` and `x64` artifacts are present.
- Every asset has a nonzero size and an uploaded state.
- The artifact verifier passes archive integrity, architecture, signing, designated-requirement, and isolated launch checks for both architectures.
- GitHub's asset SHA-256 digests and byte sizes match the downloaded files.
- The signing notice matches Developer ID, self-signed, or ad hoc signing.

Finish with the version, release SHA, workflow or manual-publish result, release URL, signing status, artifact names, and verification summary. If the process stops early, give the exact blocker and completed steps. Do not claim that a release exists until `gh release view` confirms it.
