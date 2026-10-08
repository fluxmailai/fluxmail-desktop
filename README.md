# Fluxmail Desktop

Fluxmail Desktop is a fast, local-first Gmail client for macOS. It uses Electron and calls the pinned Fluxmail npm package directly in the main process. There is no local REST server, MCP transport, or hosted web API between the interface and Gmail.

The first release focuses on the work people do every day: a unified inbox, account and folder navigation, search, conversations, attachments, bulk actions, drafts, compose, reply, reply all, and forward. It supports multiple Gmail accounts and keeps the normal macOS app process running for sync and notifications after its last window closes.

## Requirements

- macOS 13 or newer
- Node.js 22.22 or newer
- pnpm 11.9.0
- A Google OAuth desktop client for live Gmail use

## Set up the repository

Clone the repository and install its dependencies:

```sh
git clone git@github.com:fluxmailai/fluxmail-desktop.git
cd fluxmail-desktop
pnpm install
```

Fluxmail uses the OAuth app included in the installed package by default. To use a different Google OAuth desktop client, copy `.env.example` to `.env` and set `FLUXMAIL_DESKTOP_GOOGLE_CLIENT_ID` and `FLUXMAIL_DESKTOP_GOOGLE_CLIENT_SECRET`. Vite injects these overrides into the Electron main bundle only. They are not available to the renderer. The bundled client uses `gmail.modify`, while a custom client requests full Gmail access. Fluxmail shows permanent deletion only after Google grants that scope. Reconnect accounts that were added before the custom client was configured.

Private image relay is available with an active Pro, Team, or Enterprise license. It works with every supported mailbox provider and does not depend on the Google OAuth client. The desktop app exchanges its cached signed license lease for a relay token that lasts up to 24 hours. If the license is unavailable, expired, or in its grace period, Fluxmail leaves remote images blocked instead of loading them directly.

The image relay is operated by Fluxmail and remains a subscription service. The same applies to protected Fluxmail engine entitlements. The software licenses do not provide hosted-service access or paid license keys. See the [Fluxmail Terms](https://www.fluxmail.ai/terms) for subscription and service terms.

Start the app with:

```sh
pnpm dev
```

Fluxmail uses `~/.fluxmail` for accounts, encrypted credentials, licensing, configuration, the analytics preference, and the anonymous installation ID. A separately installed `fluxmail` CLI uses the same directory by default, so it sees the same accounts and settings. Desktop and CLI versions may differ when both support the stored data format. An incompatible version stops before changing the shared data and asks the user to update it.

`FLUXMAIL_DATA_DIR` changes the whole shared data directory, while `FLUXMAIL_DB_PATH` changes only the SQLite database path. Shell variables and `.env.local` or `.env` files in the CLI working directory take priority over settings saved in `~/.fluxmail/config.env`. These overrides can intentionally give the CLI a separate installation.

Desktop message metadata and interface preferences live in the app's macOS Application Support directory. Fluxmail encrypts opened message bodies in the desktop cache with a key derived from its credential encryption key, stored at `~/.fluxmail/encryption.key` by default.

## Useful commands

- `pnpm typecheck` checks the desktop TypeScript project.
- `pnpm lint` runs Oxlint.
- `pnpm format:check` checks formatting.
- `pnpm test` runs unit and privacy tests under Electron's Node runtime.
- `pnpm build` creates an ad hoc-signed app bundle for the current architecture.
- `pnpm make` creates the configured DMG and ZIP release files.

## Keyboard shortcuts

- `C` compose
- `Command K` or `/` focus search
- `J` and `K` move through conversations
- `R` reply
- `E` archive
- `#` move to Trash
- `S` star or unstar
- `U` toggle read or unread
- `Command R` refresh
- `Command Enter` send from the compose window

## Security model

The renderer is context isolated, sandboxed, and has no Node access. Its only privileged surface is the typed `window.fluxmail` bridge. Both sides of every IPC call validate requests and responses, and the main process rejects calls from unknown frames.

Email HTML is sanitized and rendered inside a scriptless sandboxed iframe with its own restrictive content security policy. Forms, scripts, nested frames, unsafe links, and tracking pixels from common email services are removed automatically. Remote images are off by default. CID images are resolved through the main process, and approved HTTPS or email links open in the system browser.

## Analytics

Packaged production builds send anonymous product, reliability, and performance events through the first-party Fluxmail PostHog endpoint. Development and test builds do not send analytics. The renderer never receives a PostHog client.

See [Desktop telemetry](docs/telemetry.md) for the event schema, prohibited data, installation ID details, and opt-out controls.

## Release configuration

Releases use the OAuth app bundled with the Fluxmail package. These GitHub secrets can override it:

- `FLUXMAIL_DESKTOP_GOOGLE_CLIENT_ID`
- `FLUXMAIL_DESKTOP_GOOGLE_CLIENT_SECRET`

Set the Google client ID and client secret together, or leave both unset.

Code signing is optional. A persistent self-signed identity requires these three GitHub secrets:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`

The workflow uses the same certificate for every release. Keep an encrypted backup of the P12 and its password outside GitHub. A self-signed certificate does not make the app trusted by Gatekeeper and cannot be notarized.

Developer ID signing and notarization also require these three secrets:

- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Leave all Apple secrets unset to build with ad hoc signatures. Set only the signing group for persistent self-signed releases. Set both complete groups for Developer ID signing, hardened runtime, and notarization. The workflow rejects partial groups. macOS requires users to approve both ad hoc and self-signed apps before opening them.

The workflow attaches both architectures to the GitHub Release that matches the pushed tag. Unnotarized releases include a warning in their release notes.

## License

Files owned by Fluxmail in this repository are licensed under the [Mozilla Public License 2.0](LICENSE). Source code for released versions is available from this repository and its tags.

Fluxmail Desktop bundles the Fluxmail engine as a separate component. The engine packages keep their own license and source files, and their code is not copied into Desktop-owned source files. Other bundled software remains subject to its own license.

See [Distribution notices](DISTRIBUTION_NOTICES.md) for the component boundaries, source repositories, software licenses, and third-party notice locations.
