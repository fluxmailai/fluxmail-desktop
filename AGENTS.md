# Working here

This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.

- Finish what you were asked to do before you end your turn. Work through ordinary obstacles, such as a failing command, a flaky test, a timeout or an empty result. Stop early only for a decision that belongs to the user, or before a step that needs their go-ahead.
- You don't need approval to edit files in your worktree, install the locked dependencies, run tests and builds, start the development app in a worktree set up as described under Parallel sessions, or retry a command that is safe to repeat. Steps that need the user's go-ahead include publishing a release, pushing a `v*` tag (which starts one), force-pushing and merging a PR. The sections below and the repository's skills name more. Never send mail from, or change, a real account to verify a change.
- When a hook, a missing credential or another guardrail blocks you on purpose, do what it requires or ask the user. Don't work around it, for example by opening a PR through the API.
- A subagent with its own definition, such as `code-reviewer`, follows that definition where it differs from this section.
- In the final report, write for someone who didn't watch you work. Start with the outcome and list every change, including small ones such as new tests or a changed default. The verification section below says what else to include.

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

# Code review before pull requests

Before you open a pull request, start `code-reviewer` (`.claude/agents/code-reviewer.md`) without a model or effort override so its pinned settings apply, naming the repository and the base branch. It runs the code-review skill on the latest Opus at `high` over everything the pull request will contain, including uncommitted and untracked files, and only reports findings. `REVIEW.md` lists the paths that also get a security review, and names the failures that matter most in this repository. Fix every issue it reports yourself. If you leave a finding unfixed on purpose, tell the user which one and why. Then record the review with `node .claude/hooks/require-code-review.mjs --mark` and open the pull request. A hook in `.claude/settings.json` blocks `gh pr create` until the recorded review matches the current files. Run anything that changes files, such as a formatter, in its own Bash command before `gh pr create`, because the hook checks the files before the command runs. If you cannot start the agent, or it says no review happened, follow the steps in `.claude/agents/code-reviewer.md` for `REVIEW.md` and the security review yourself (its read-only rules and its reply rules are for the agent only): run `/code-review high`, using the base's `REVIEW.md` as well when it differs, and add a security review when `REVIEW.md` calls for one. If your session isn't on the model `code-reviewer.md` pins, tell the user which model ran the review. Do the same security review when only the agent's didn't run. `/security-review` reviews its own diff of the current directory against `origin/HEAD`, so apply its criteria to the branch's full diff and untracked files, as the agent definition describes. If no review can run, tell the user instead of recording one.

Review again before you push a significant change to an open pull request, such as new behavior, a redesign or a large refactor. Small follow-ups, such as fixes for review comments or CI, formatting and copy edits, do not need another review.
