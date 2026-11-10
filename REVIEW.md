# Code review guide

The `code-reviewer` agent reads this file before it reviews a branch. Keep it short. When a bug ships that review should have caught, add its pattern to the list of failures below.

When a branch changes this file, review it under both the base's version and the branch's, and use whichever is stricter for each rule.

## Review depth

Use `low` when every changed file is `README.md` or a PNG image under `build/`, whatever the size of the change.

Otherwise, use `xhigh` when any changed file is in one of these paths:

- Process isolation and IPC: `src/main/index.ts`, `src/main/ipc-security.ts`, `src/preload.ts`, `src/preload/`, `src/shared/contracts.ts`, `index.html`
- Untrusted mail and links: `src/renderer/components/EmailHtml.tsx`, `src/renderer/email/`, `src/main/context-menu.ts`, `src/main/quoted-reply.ts`, `src/shared/quoted-reply.ts`, `src/shared/external-url.ts`, `src/shared/mailto.ts`
- Accounts, stored data and licensing: `src/main/oauth.ts`, `vite.main.config.ts`, `src/main/cache.ts`, `src/main/cache-cipher.ts`, `src/main/preferences.ts`, `src/main/fluxmail-runtime.ts`
- Website services and telemetry: `src/main/image-relay.ts`, `src/shared/image-relay.ts`, `src/main/analytics.ts`
- Updates, release and packaging: `src/main/updater.ts`, `.github/`, `.agents/skills/release/`, `forge.config.ts`, `build/entitlements.mac.plist`, `scripts/update-manifests.mjs`, `scripts/release-notes.mjs`, `scripts/generate-third-party-notices.mjs`, `package.json`, `pnpm-workspace.yaml`, `CHANGELOG.md`
- The review process: `REVIEW.md`, `.claude/agents/`, `.claude/hooks/`, `.claude/settings.json`

Also use `xhigh` when the branch adds and deletes more than 1,000 lines of text in total. Don't count binary files or the files listed under Skip.

Use `high` for everything else.

## Security review

Run a security review as well when the branch changes a file in the `xhigh` groups for process isolation and IPC, untrusted mail and links, and accounts, stored data and licensing, or in `src/main/updater.ts`, `src/main/image-relay.ts`, `src/shared/image-relay.ts`, `scripts/update-manifests.mjs`, `build/entitlements.mac.plist`, `.github/workflows/` or `forge.config.ts`.

Run one too when the diff anywhere renders mail content, opens a URL or file, adds an IPC channel, reads a credential or token, or loads remote content.

## Failures to look for

Report these as Important:

- A renderer that gets more reach than it needs: Node integration, a disabled sandbox or context isolation, a loosened Content Security Policy, or a preload or IPC channel that exposes general file, shell or network access. IPC handlers must check the sender and validate every argument.
- Mail content that can run script, load remote content the user didn't allow, leak the user's address or IP through tracking pixels, or navigate the app window. Treat every message, attachment name and link as hostile.
- A link or attachment opened without the URL scheme check in `src/shared/external-url.ts`.
- Credentials, tokens or cached mail written in plain text, logged, or sent anywhere other than the provider or Fluxmail service that needs them.
- A change to how the app calls Fluxmail's website services that released servers don't accept, such as the image-relay token and signing endpoints.
- Anything that lets someone use paid features or extra accounts without a valid license, or weakens a license check.
- An auto-update, signing or notarization change that could install an unsigned build or stop installed apps from updating.
- Telemetry that sends mail content, addresses, identifiers, file paths, search text or error messages. `docs/telemetry.md` lists what may be collected.
- A test that sends mail from, or changes, a real account.
- A `CHANGELOG.md` entry that `scripts/release-notes.mjs` can't parse, such as a heading or signing notice in the wrong format. The release fails after the tag is pushed.

## Skip

- `pnpm-lock.yaml`, `src/main/demo-fixtures/`, `scripts/third-party-license-fallbacks/` and binary files
- formatting and style that oxfmt, oxlint and TypeScript already check

## Reporting

Give a file and line for each finding and say what goes wrong and when. Tag each finding Important or Nit, and report at most three nits.
