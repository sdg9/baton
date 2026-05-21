# Baton — repo notes for Claude

This is a pnpm monorepo containing two related packages for spec-driven autonomous development:

- `packages/harness` (`@baton-tools/harness` on npm) — CLI + Claude Code plugin.
- `packages/workbench` (`@baton-tools/workbench` on npm) — local-first kanban dashboard.

Each package has its own README. Per-package context (e.g. workbench architecture rules) lives in `packages/<name>/CLAUDE.md` when present.

## Working in this repo

- Package manager: **pnpm** (workspaces). Always `pnpm install`, never `npm install` at the root.
- Tests: `pnpm test` (workspace-wide) or `pnpm --filter <package-name> test`.
- Build: `pnpm build`.
- Typecheck: `pnpm typecheck`.
- The workbench depends on the harness via `workspace:*` — local edits to harness are picked up immediately by the workbench (no rebuild needed for type changes; vite handles runtime).

## Releasing to npm

**See [`RELEASING.md`](./RELEASING.md) for the full recipe.** That file is designed to be followed end-to-end without interactive prompts — write a changeset file directly, run `pnpm version-packages`, commit, `pnpm release`, push with tags.

Quick reference for the most common request ("publish a patch of the harness"):

```bash
# 1. Write a changeset file (replaces interactive `pnpm changeset`)
cat > .changeset/<slug>.md <<'EOF'
---
"@baton-tools/harness": patch
---
<one-line summary>
EOF

# 2. Apply versions
pnpm version-packages

# 3. Commit
git add .changeset packages/*/package.json packages/*/CHANGELOG.md pnpm-lock.yaml
git commit -m "release: @baton-tools/harness@<new-version>"

# 4. Build + publish
pnpm release

# 5. Push commit + tags
git push --follow-tags
```

Note the workbench will *cascade* a patch bump whenever the harness is bumped (because of `updateInternalDependencies: patch` in `.changeset/config.json`). That's intentional.

## Repo conventions

- New work goes on a feature branch off `main`, then merges back via `git merge --no-ff`. Direct commits to `main` are reserved for tiny doc/release commits.
- Commits follow Conventional Commits prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `release:`, etc.
- Build outputs (`packages/*/dist/`) are gitignored. Don't commit them.
- The monorepo migration history is documented in `docs/superpowers/plans/2026-05-20-monorepo-migration.md` (historical; uses pre-rename names).
