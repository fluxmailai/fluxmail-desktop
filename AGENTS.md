# Testing

GitHub CI runs formatting, lint, type checks, and unit tests. It does not run the Electron end-to-end suite.

Run `pnpm test:e2e` locally before finishing changes that affect user flows, Electron integration, or app packaging.

# Commit messages

Use Conventional Commits for commit messages and PR titles: `type(scope): description`. The scope is optional. Allowed types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`. Use `!` before the colon for a breaking change, such as `feat(api)!: require a mailbox ID`.

`pnpm install` installs the commit-message hook for local development. CI checks PR titles, including title edits. GitHub uses the PR title for squash commits. Existing commits do not need to be rewritten. Keep the squash commit title in Conventional Commits format when merging.
