---
description: Run an approved OpenSpec story through the autonomous harness end-to-end (worktree → holdouts → plan → implement → verify → review).
argument-hint: <story-name>
---

The user wants to execute story `$ARGUMENTS` through the autonomous harness.

Invoke the `autonomous-harness` skill and run Phases 1-4 as documented there. If `$ARGUMENTS` is empty, ask the user once for a story name (or offer to scan `openspec/changes/` for approved stories).
