# Testing

GitHub CI runs formatting, lint, type checks, unit tests, and the Electron end-to-end suite.

Run `pnpm test:e2e` locally before finishing changes that affect user flows, Electron integration, or app packaging.

# Verifying changes

Before reporting a change as finished, run the app and confirm it works. Passing tests and type checks don't show that a screen renders, a flow completes, or a fix solves the reported problem.

- Reproduce a bug before fixing it, then repeat the same steps after the fix.
- For a user-facing change, record a video of the affected flow before and after it. Record the before video on `origin/main`, in a separate worktree or before you edit anything.
- For a new feature, record every case a user can reach: the main path, empty, loading and error states, offline or failed provider requests, and light and dark appearance when styling changes.
- Record with Playwright. Build with `pnpm exec electron-forge package`, then launch the app the way `tests/e2e/` does, with `FLUXMAIL_DESKTOP_FAKE_MAIL=1`, and pass `recordVideo: { dir, size: { width: 1440, height: 900 } }` to `electron.launch` so the video matches the window. Save recordings and screenshots under `.context/verification/` and don't commit them.
- Verify with fake mail or a synthetic mailbox. Never send mail from, or change, a real account to verify a change.
- In the final report, say what you checked and how, link each recording, and list anything you couldn't verify and why, such as signed builds, auto-update or OS integration that needs a release build.

# Dependency updates

Renovate opens the dependency PRs. CI and packaging run `pnpm notices:generate`, which writes `THIRD_PARTY_NOTICES.md` and `licenses/ELECTRON_LICENSE`. Git ignores both files. If the script stops on a package, review its license and update the exact-version exception in `scripts/generate-third-party-notices.mjs`.

# Commit messages

Use Conventional Commits for commit messages and PR titles: `type(scope): description`. The scope is optional. Use `feat` for features, `fix` for bug fixes, and `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`, or `revert` as appropriate. Write a short, imperative description, such as `fix(cloud): handle Gmail timeouts`. Mark breaking changes with `!` before the colon, such as `feat(api)!: require a mailbox ID`.
