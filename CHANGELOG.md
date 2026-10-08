# Changelog

Fluxmail Desktop records user-facing changes in this file. The format follows [Common Changelog](https://common-changelog.org/).

## [Unreleased](https://github.com/fluxmailai/fluxmail-desktop/compare/v0.5.1...HEAD)

### Fixed

- Stop the macOS Keychain password prompt when opening a message after an update.

## [0.5.1](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.5.1) - 2026-09-27

_These artifacts use Fluxmail's self-signed certificate and have not been notarized by Apple, so macOS will require approval before opening the app._

### Fixed

- Stop repeated background checks after a message loads to reduce CPU use while reading it ([#65](https://github.com/fluxmailai/fluxmail-desktop/pull/65))

## [0.5.0](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.5.0) - 2026-09-25

_These artifacts use Fluxmail's self-signed certificate and have not been notarized by Apple, so macOS will require approval before opening the app._

### Changed

- Back up the shared Fluxmail data directory before opening Desktop: the bundled Fluxmail 0.11.0 engine moves it to format 5, which older CLI versions cannot read ([upgrade guide](https://fluxmail.ai/docs/upgrades/0.11.0/))

### Fixed

- Stop older inbox messages from triggering new-mail notifications when they appear after archiving ([#62](https://github.com/fluxmailai/fluxmail-desktop/pull/62))
- Size email content before remote images finish loading so messages remain readable ([#63](https://github.com/fluxmailai/fluxmail-desktop/pull/63))
- Reuse proxy connections for Gmail sign-in and mail requests to avoid repeated connection delays ([#99](https://github.com/fluxmailai/fluxmail/pull/99), [#100](https://github.com/fluxmailai/fluxmail/pull/100))

## [0.4.2](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.4.2) - 2026-09-16

_These artifacts use Fluxmail's self-signed certificate and have not been notarized by Apple, so macOS will require approval before opening the app._

### Fixed

- Open messages even when a sender includes a malformed header address, and show invalid reply recipients so they can be corrected before sending ([#57](https://github.com/fluxmailai/fluxmail-desktop/pull/57))
- Preserve original message formatting when reopening an undone reply, and keep the reply linked to the message it answers ([#58](https://github.com/fluxmailai/fluxmail-desktop/pull/58))
- Turn off private image relay when the active license no longer includes it ([#59](https://github.com/fluxmailai/fluxmail-desktop/pull/59))

## [0.4.1](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.4.1) - 2026-08-04

_These artifacts use Fluxmail's self-signed certificate and have not been notarized by Apple, so macOS will require approval before opening the app._

### Fixed

- Show Undo Send messages immediately in Sent and keep their content visible while delivery is pending ([#54](https://github.com/fluxmailai/fluxmail-desktop/pull/54))
- Restore bullets, numbers, and indentation for lists in compose and quick reply ([#55](https://github.com/fluxmailai/fluxmail-desktop/pull/55))

## [0.4.0](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.4.0) - 2026-07-25

_These artifacts use Fluxmail's self-signed certificate and have not been notarized by Apple, so macOS will require approval before opening the app._

### Changed

- License Fluxmail Desktop under the Mozilla Public License 2.0 and link to its source, software notices, and service terms from Settings ([#48](https://github.com/fluxmailai/fluxmail-desktop/pull/48), [#49](https://github.com/fluxmailai/fluxmail-desktop/pull/49))
- Open saved drafts in the reading pane with their recipients, body, reply context, and attachments restored ([#37](https://github.com/fluxmailai/fluxmail-desktop/pull/37))
- Open the next visible conversation after archiving, with a Behavior setting to turn this off ([#38](https://github.com/fluxmailai/fluxmail-desktop/pull/38))
- Show To, CC, and BCC email addresses in message headers ([#45](https://github.com/fluxmailai/fluxmail-desktop/pull/45))

### Added

- Schedule messages for later, manage them in the Scheduled mailbox, and configure Undo Send for compose, reply, and forward ([#41](https://github.com/fluxmailai/fluxmail-desktop/pull/41))
- Undo read, star, archive, trash, move, and label actions from the toast or with Command-Z ([#40](https://github.com/fluxmailai/fluxmail-desktop/pull/40))
- Find text across an open conversation with Command-F and move between every visible match ([#39](https://github.com/fluxmailai/fluxmail-desktop/pull/39))

### Fixed

- Keep late-loading images and fonts from clipping message content and preserve responsive newsletter styles ([#42](https://github.com/fluxmailai/fluxmail-desktop/pull/42))

## [0.3.0](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.3.0) - 2026-07-21

_These artifacts use Fluxmail's self-signed certificate and have not been notarized by Apple, so macOS will require approval before opening the app._

### Changed

- Include the original message and citation in replies, restore reply drafts, and attach referenced inline images ([#32](https://github.com/fluxmailai/fluxmail-desktop/pull/32))
- Use an overlay scrollbar in the sidebar to match the thread list and reading pane ([#31](https://github.com/fluxmailai/fluxmail-desktop/pull/31))

### Added

- Search mail with Boolean expressions and filters for people, folders, labels, dates, attachments, files, and accounts, with autocomplete for filters and known values ([#35](https://github.com/fluxmailai/fluxmail-desktop/pull/35))
- Compose replies and forwards in the reading pane, use R, A, and F shortcuts, and confirm before replacing an unsent message ([#30](https://github.com/fluxmailai/fluxmail-desktop/pull/30))

### Fixed

- Start the app when the local Fluxmail data store uses the latest format ([#28](https://github.com/fluxmailai/fluxmail-desktop/pull/28))
- Open a conversation from any non-action area of its thread row ([#33](https://github.com/fluxmailai/fluxmail-desktop/pull/33))

## [0.2.0](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.2.0) - 2026-07-20

_These artifacts use Fluxmail's self-signed certificate and have not been notarized by Apple, so macOS will require approval before opening the app._

### Changed

- Use Fluxmail artwork and center the installer layout ([#19](https://github.com/fluxmailai/fluxmail-desktop/pull/19))
- Keep email headers on the standard arrow cursor ([#21](https://github.com/fluxmailai/fluxmail-desktop/pull/21))

### Added

- Block email tracking pixels before rendering messages and show the blocked domains and reasons ([#22](https://github.com/fluxmailai/fluxmail-desktop/pull/22))
- Relay remote images through Fluxmail for active Pro, Team and Enterprise licenses ([#20](https://github.com/fluxmailai/fluxmail-desktop/pull/20))
- Activate license keys from Desktop Settings and share activated licenses with compatible CLI and MCP apps ([#25](https://github.com/fluxmailai/fluxmail-desktop/pull/25))
- Block remote images by default, with per-message controls and an opt-out preference ([#18](https://github.com/fluxmailai/fluxmail-desktop/pull/18))

### Fixed

- Keep messages readable without caching their bodies when Keychain access is unavailable ([#19](https://github.com/fluxmailai/fluxmail-desktop/pull/19))
- Open DevTools at the bottom and preserve draggable title-bar areas in the empty conversation pane ([#23](https://github.com/fluxmailai/fluxmail-desktop/pull/23))

## [0.1.0](https://github.com/fluxmailai/fluxmail-desktop/releases/tag/v0.1.0) - 2026-07-18

_First release; these artifacts use Fluxmail's self-signed certificate and have not been notarized by Apple, so macOS will require approval before opening the app._

### Added

- Add a macOS Gmail client with inbox navigation, search, threads, compose, drafts, attachments, notifications and mailbox actions ([#1](https://github.com/fluxmailai/fluxmail-desktop/pull/1))
- Encrypt opened messages in the local cache, require approval before loading remote images and provide anonymous telemetry controls ([#1](https://github.com/fluxmailai/fluxmail-desktop/pull/1))
- Load cached mailboxes before refreshing and prevent stale requests from replacing newer views or selections ([#2](https://github.com/fluxmailai/fluxmail-desktop/pull/2), [#7](https://github.com/fluxmailai/fluxmail-desktop/pull/7), [#13](https://github.com/fluxmailai/fluxmail-desktop/pull/13), [#15](https://github.com/fluxmailai/fluxmail-desktop/pull/15))
- Share `~/.fluxmail` data with compatible CLI versions and back up stores before migrations ([#5](https://github.com/fluxmailai/fluxmail-desktop/pull/5))
- Open HTTP, HTTPS and mailto links from rendered messages ([#3](https://github.com/fluxmailai/fluxmail-desktop/pull/3))
- Convert sender colors, backgrounds, gradients and borders for readable messages in dark mode ([#16](https://github.com/fluxmailai/fluxmail-desktop/pull/16))
- Keep mailbox shortcuts working while a message is focused and preserve focus during archive actions ([#4](https://github.com/fluxmailai/fluxmail-desktop/pull/4), [#10](https://github.com/fluxmailai/fluxmail-desktop/pull/10))
- Keep Settings usable at minimum window sizes and simplify the About details ([#11](https://github.com/fluxmailai/fluxmail-desktop/pull/11))
- Streamline the first-run Gmail connection screen ([#12](https://github.com/fluxmailai/fluxmail-desktop/pull/12))
- Bundle Fluxmail 0.5.0, use the built-in Google OAuth client and hide permanent deletion unless an account grants the required scope ([#9](https://github.com/fluxmailai/fluxmail-desktop/pull/9), [#14](https://github.com/fluxmailai/fluxmail-desktop/pull/14), [#17](https://github.com/fluxmailai/fluxmail-desktop/pull/17))
