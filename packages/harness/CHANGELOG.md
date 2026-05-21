# @baton-tools/harness

## 0.4.0

### Minor Changes

- Add a `/polish-proposal <change-name>` slash command that drives up to 3 rounds of review → triage → apply on an OpenSpec change directory. Minor edits on a narrow whitelist (typos, missing required sections, heading-order, intra-doc references, placeholder fill-in, terminology consistency) auto-apply with one git commit per round so any round can be reverted; critical or off-whitelist findings escalate to the user in-chat with a recommended answer pre-filled. Edits are bounded to `openspec/changes/<name>/`; every round appends to `polish-log.md` for an auditable convergence trail. Sister to `/openspec-propose` — that one creates the input, this one polishes it before `/harness` picks it up for implementation.

## 0.3.0

### Minor Changes

- Remove the INBOX.md / BACKLOG.md concept. Follow-up tracking now lives in OpenSpec primitives (changes, proposals) — one source of truth, no parallel queue file.

  **Harness:** `init` no longer writes an `INBOX.md` placeholder. `finishPostProcess` no longer prunes backlog entries (and the `prunedBacklogEntries` field is removed from `PostProcessReport`). The autopilot report drops the `backlogChurn` section (which was never populated in practice). Tasks-template's archive-time cleanup section is gone.

  **Workbench:** drops the Inbox view-mode + tab from the UI, removes `/api/projects/:id/inbox` and `/inbox/start` routes, and removes the inbox file-watcher startup loop.

## 0.2.1

### Patch Changes

- `baton-harness doctor` polish: colorize PASS/FAIL/WARN tags in TTY output (no color when piped or when `NO_COLOR` is set), and fix plugin detection to find `.claude-plugin/plugin.json` at the actual nesting depth used by Claude Code 2.x.

## 0.2.0

### Minor Changes

- Add `baton-harness doctor` command that verifies the install: config discovery + parse, openspec scaffold, external CLIs (git, node, openspec), four configurable verify commands (resolves the binary on PATH or in workspace `node_modules/.bin` without executing), plus best-effort detection of the Claude Code plugin and superpowers. Supports `--json` for stable structured output and `--cwd=<path>` for non-`process.cwd()` invocation. Exit 0 unless any hard check fails; exit 1 on hard fail; exit 2 on arg error. Exposes `runDoctor`, `DoctorReport`, `CheckResult` from the package entry for programmatic consumers.
