# Testing

GitHub CI runs formatting, lint, type checks, and unit tests. It does not run the Electron end-to-end suite.

Run `pnpm test:e2e` locally before finishing changes that affect user flows, Electron integration, or app packaging.

# Dependency updates

Renovate opens the dependency PRs. CI and packaging run `pnpm notices:generate`, which writes `THIRD_PARTY_NOTICES.md` and `licenses/ELECTRON_LICENSE`. Git ignores both files. If the script stops on a package, review its license and update the exact-version exception in `scripts/generate-third-party-notices.mjs`.

Run `pnpm test:e2e` locally before merging a Renovate PR that updates Electron or Electron Forge.

# Commit messages

Use Conventional Commits for commit messages and PR titles: `type(scope): description`. The scope is optional. Use `feat` for features, `fix` for bug fixes, and `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`, or `revert` as appropriate. Write a short, imperative description, such as `fix(cloud): handle Gmail timeouts`. Mark breaking changes with `!` before the colon, such as `feat(api)!: require a mailbox ID`.
