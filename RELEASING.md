# Releasing

How to publish a new version of `@baton-tools/harness` and/or `@baton-tools/workbench` to npm.

This recipe is designed to be **fully scriptable** — no interactive prompts. An LLM agent or human following it end-to-end should land at a published package without needing to answer any "yes/no" mid-flight.

---

## Prerequisites (one-time)

- [ ] Logged into npm as a member of the `baton-tools` org: `npm whoami` should print a username that appears in `npm org ls baton-tools`. If not, `npm login`.
- [ ] On a clean `main` branch, up to date with origin: `git status` clean, `git pull --ff-only` no-op.
- [ ] All tests pass: `pnpm test`.

If any of those fail, fix before continuing. Never publish from a dirty tree or a non-passing build.

---

## The decision before you start

Two axes:

1. **Which packages?** `@baton-tools/harness`, `@baton-tools/workbench`, or both.
2. **What bump?** `patch` (bug fix), `minor` (additive feature), `major` (breaking change).

**Cascading bumps:** the workbench depends on the harness via `workspace:*`. Because `.changeset/config.json` has `"updateInternalDependencies": "patch"`, **any harness bump auto-generates a patch bump on the workbench** to track the new dep version. This is intentional. If you bump the harness, expect the workbench to also publish a new patch version.

---

## The recipe

### Step 1 — Write the changeset file directly

The interactive `pnpm changeset` prompt is for humans; for scripted runs, write the file by hand. Pick a short kebab-case slug describing what changed.

For a **single-package patch** (example: harness only):

```bash
mkdir -p .changeset
cat > .changeset/<slug>.md <<'EOF'
---
"@baton-tools/harness": patch
---

<One-line summary of what changed. This becomes the CHANGELOG entry.>
EOF
```

For a **two-package release** (example: minor bump to both):

```bash
cat > .changeset/<slug>.md <<'EOF'
---
"@baton-tools/harness": minor
"@baton-tools/workbench": minor
---

<Summary that applies to both. Or write separate changeset files if the changes are unrelated.>
EOF
```

Bump levels: `patch` | `minor` | `major`. Use semver discipline — `major` for ANY breaking change to a public export, CLI flag, or config schema.

### Step 2 — Apply versions and generate changelogs

```bash
pnpm version-packages
```

This runs `changeset version` and then `node scripts/sync-plugin-version.mjs`, which together:
- Bump version in `packages/harness/package.json` and/or `packages/workbench/package.json` as your changeset(s) declared.
- Cascade the workspace-internal dep bump to the workbench (per `updateInternalDependencies: patch`).
- Write/append a `CHANGELOG.md` in each bumped package.
- **Delete the changeset file(s)** you wrote in Step 1.
- Update `pnpm-lock.yaml`.
- Mirror the new harness version into `packages/harness/plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` so the Claude Code plugin and marketplace manifest stay in lockstep with the npm version. The sync runs unconditionally; if no harness bump happened, it's a no-op write of the same version.

### Step 3 — Commit the version bump

```bash
git add .changeset packages/*/package.json packages/*/CHANGELOG.md pnpm-lock.yaml \
  packages/harness/plugin/.claude-plugin/plugin.json \
  .claude-plugin/marketplace.json
git status   # sanity check — only the above files should be staged
git commit -m "release: <package(s)>@<version(s)>"
```

Example commit message: `release: @baton-tools/harness@0.2.0 (+ workbench@1.0.1 cascade)`.

### Step 4 — Build and publish

```bash
pnpm release
```

This runs `pnpm -r build && changeset publish`. `changeset publish` only publishes packages whose version was bumped since the last published version (so the workbench publishes only if its version changed in Step 2). For each bumped package, it:
- Runs the package's `prepublishOnly` hook (the harness runs `npm run build` again as a safety net).
- Publishes to npm with `--access public` (per `.changeset/config.json`).
- Creates a git tag like `@baton-tools/harness@0.2.0`.

### Step 5 — Push the commit and the tag(s)

```bash
git push --follow-tags
```

`--follow-tags` ensures the package-version tags created by `changeset publish` go up to GitHub alongside the commit.

### Step 6 — Sanity-verify

```bash
npm view @baton-tools/harness version
npm view @baton-tools/workbench version
```

Both should print the version you just published. If `npm view` returns a stale version, give the npm CDN ~60 seconds and retry.

---

## Dry-run (no real publish)

To validate the whole flow without publishing:

```bash
# Steps 1-3 as above (write changeset, version, commit on a throwaway branch)
git checkout -b release-dry-run

# Then dry-run the publish step
pnpm -r build
pnpm --filter @baton-tools/harness exec npm publish --dry-run --access public
pnpm --filter @baton-tools/workbench exec npm publish --dry-run --access public

# Back out
git checkout main && git branch -D release-dry-run
```

---

## Common LLM-friendly invocations

The user typically asks one of these — each maps to a specific recipe path.

| User says                                          | Recipe                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "publish a patch of the harness"                   | Single-package changeset for `@baton-tools/harness` at `patch`. Workbench will cascade.          |
| "publish a minor of both"                          | Two-package changeset, both at `minor`.                                                          |
| "ship the workbench (minor) but not the harness"   | Single-package changeset for `@baton-tools/workbench` at `minor`. Harness untouched.             |
| "bump major on the harness, breaking change is X"  | Single-package changeset for `@baton-tools/harness` at `major`, with X in the summary body.      |
| "release whatever's been staged"                   | Skip Step 1, jump to Step 2. Existing changeset files in `.changeset/` are applied.              |
| "dry-run the next release"                         | Use the dry-run section above.                                                                    |

---

## Troubleshooting

**`ENEEDAUTH` / "need auth"** — Run `npm login`. Then `npm whoami` to confirm.

**`E403` or "you don't have permission to publish"** — You're logged in as a user who isn't in the `baton-tools` org. `npm org ls baton-tools` to confirm membership.

**`prepublishOnly` script failed** — The harness's pre-publish hook runs `npm run build`. If build is failing, fix the build first; do NOT bypass with `--ignore-scripts`.

**`pnpm version-packages` produced no changes** — You forgot to write a changeset file in Step 1, or all the changeset files have already been consumed by a prior `version-packages` run. Check `.changeset/` for `.md` files.

**Wrong version got bumped** — Don't try to fix by re-running `version-packages`. Revert the commit (`git reset --hard HEAD~1`), re-write the changeset file correctly, and start over from Step 2. The unpublished version bump is recoverable; the published version is not.

**Published the wrong version** — npm allows `npm unpublish` only within 72 hours of publication, and only for packages with no dependents. Avoid this; the correct fix is almost always to publish a new patch with the intended content.

---

## Why we use changesets (vs. `npm version`)

- Per-package versioning in a monorepo without manual coordination.
- Automatic cascading of workspace deps (`workspace:*` reference resolution at publish time).
- Auto-generated CHANGELOG.md per package, structured by changeset summaries.
- Atomic git tags per package, distinguishable from arbitrary commit tags.

The cost: one extra step (write the changeset file). The recipe above makes that scriptable.
