# Testing

GitHub CI runs formatting, lint, type checks, unit tests, and the Electron end-to-end suite.

Run `pnpm test:e2e` locally before finishing changes that affect user flows, Electron integration, or app packaging.

# Parallel sessions

Other sessions may be using the main checkout, so don't switch its branch, stash its changes or edit its files. Do each task in its own worktree: start Claude with `claude --worktree <name>`, or call `EnterWorktree` before you change anything. The hooks in `.claude/settings.json` install dependencies in a new worktree and set `FLUXMAIL_DESKTOP_TEST_DATA_DIR` and `FLUXMAIL_DATA_DIR` for every Bash command in it. `pnpm dev` then uses the worktree's own app profile and data instead of `~/.fluxmail`, and another session's app doesn't hold its single-instance lock. To set up a worktree you created with `git worktree add`, run `bash scripts/worktree-setup.sh` in it.

Rex tabs and panes start from your login shell, so a development app you start in one doesn't get these variables. Load them in the command, for example `rex window new -s "$REX_SESSION" App -c "$PWD" --keep-open --focus=false -- sh -c 'eval "$(bash scripts/worktree-setup.sh --env "$PWD")" && exec pnpm dev'`.

# Verifying changes

Before reporting a change as finished, run the app and confirm it works. Passing tests and type checks don't show that a screen renders, a flow completes, or a fix solves the reported problem.

- Reproduce a bug before fixing it, then repeat the same steps after the fix.
- For a user-facing change, record a video of the affected flow before and after it. Record the before video on `origin/main`, in a separate worktree or before you edit anything.
- For a new feature, record every case a user can reach: the main path, empty, loading and error states, offline or failed provider requests, and light and dark appearance when styling changes.
- Record with Playwright. Build with `pnpm exec electron-forge package`, then launch the app the way `tests/e2e/` does, with `FLUXMAIL_DESKTOP_FAKE_MAIL=1`, and pass `recordVideo: { dir, size: { width: 1440, height: 900 } }` to `electron.launch` so the video matches the window. Save videos as MP4, because WebM doesn't play in every viewer. Playwright only writes WebM, so convert its videos with `ffmpeg -i <path>.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart <path>.mp4`. Save recordings and screenshots under `.context/verification/` and don't commit them.
- Verify with fake mail or a synthetic mailbox. Never send mail from, or change, a real account to verify a change.
- In the final report, say what you checked and how, link each recording, and list anything you couldn't verify and why, such as signed builds, auto-update or OS integration that needs a release build.

# Dependency updates

Renovate opens the dependency PRs. CI and packaging run `pnpm notices:generate`, which writes `THIRD_PARTY_NOTICES.md` and `licenses/ELECTRON_LICENSE`. Git ignores both files. If the script stops on a package, review its license and update the exact-version exception in `scripts/generate-third-party-notices.mjs`.

# Commit messages

Use Conventional Commits for commit messages and PR titles: `type(scope): description`. The scope is optional. Use `feat` for features, `fix` for bug fixes, and `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`, or `revert` as appropriate. Write a short, imperative description, such as `fix(cloud): handle Gmail timeouts`. Mark breaking changes with `!` before the colon, such as `feat(api)!: require a mailbox ID`.

# Code review before commits

Before each commit, run `/code-review high --fix` on all uncommitted changes, including new untracked files, and fix every issue it flags. If you leave a finding unfixed on purpose, tell the user which one and why. Then record the review with `node .claude/hooks/require-code-review.mjs --mark` and commit. A hook in `.claude/settings.json` blocks `git commit` until the recorded review matches the current files, so an edit made after the review needs another review. Run anything that changes files, such as a formatter, in its own Bash command before the commit, because the hook checks the files before the command runs.
