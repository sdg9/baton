# @baton-tools/workbench

## 1.3.1

### Patch Changes

- Updated dependencies
  - @baton-tools/harness@0.4.0

## 1.3.0

### Minor Changes

- - Auto-register `process.cwd()` as a project when it contains an `openspec/` directory and no `config/projects.json` is present. Running `npx @baton-tools/workbench@latest` from a project root now shows that project's openspec changes on the board instead of an empty kanban.
  - Drop codex from the product surface. The add-card dropdown defaults to claude, the topbar copy says "Claude" not "Claude/Codex", the example configs and keywords no longer mention codex, and the codex notify-bridge script is removed.

## 1.2.1

### Patch Changes

- Ship the built client in the npm tarball and serve it from the package install directory, not `process.cwd()`. Fixes "Cannot GET /" when running `npx @baton-tools/workbench@latest` from outside the monorepo.

## 1.2.0

### Minor Changes

- `npx @baton-tools/workbench@latest` now boots with safe built-in defaults (claude as the only agent, tmux backend, `127.0.0.1` bind, auth + audit on, empty project list) when `config/agents.json` and `config/projects.json` are absent — no more `ENOENT agents.example.json`. Any file the user provides still takes precedence; a startup log line announces when a default is in use.

## 1.1.1

### Patch Changes

- Republish with `@baton-tools/harness` resolved to its concrete version in the published tarball. Prior versions (1.0.1, 1.0.2, 1.1.0) shipped with `"@baton-tools/harness": "workspace:*"` literally, causing `npx @baton-tools/workbench@latest` to fail with `unsupported URL type "workspace:": workspace:*`.

## 1.1.0

### Minor Changes

- Remove the INBOX.md / BACKLOG.md concept. Follow-up tracking now lives in OpenSpec primitives (changes, proposals) — one source of truth, no parallel queue file.

  **Harness:** `init` no longer writes an `INBOX.md` placeholder. `finishPostProcess` no longer prunes backlog entries (and the `prunedBacklogEntries` field is removed from `PostProcessReport`). The autopilot report drops the `backlogChurn` section (which was never populated in practice). Tasks-template's archive-time cleanup section is gone.

  **Workbench:** drops the Inbox view-mode + tab from the UI, removes `/api/projects/:id/inbox` and `/inbox/start` routes, and removes the inbox file-watcher startup loop.

### Patch Changes

- Updated dependencies
  - @baton-tools/harness@0.3.0

## 1.0.2

### Patch Changes

- Updated dependencies
  - @baton-tools/harness@0.2.1

## 1.0.1

### Patch Changes

- Updated dependencies
  - @baton-tools/harness@0.2.0
