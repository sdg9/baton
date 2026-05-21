# @baton-tools/workbench

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
