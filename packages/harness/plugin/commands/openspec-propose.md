---
description: Draft a new OpenSpec proposal — proposal.md + specs/*.delta.md + tasks.md — under openspec/changes/<name>/.
argument-hint: <short-name> [topic description]
---

The user wants to propose a new OpenSpec change.

If `$ARGUMENTS` contains a kebab-case name, use it as the change folder name; otherwise ask for one.

Scaffold the change under `openspec/changes/<name>/`:

1. `proposal.md` — sections: `## Why`, `## What changes`, `## Impact`, `## Tier` (one of `primitives | content | infra`).
2. `specs/<capability>/spec.md` — observable WHEN/THEN scenarios for each Requirement. **Phrase scenarios as observable state transitions, not "the system MUST register X."** A scenario should fail if the production code path is bypassed by an orphan helper.
3. `tasks.md` — numbered checklist of bite-sized tasks; include an `## Archive-time cleanup` section if any items need pruning when the story archives.
4. (optional) `design.md` — when a meaningful design choice or tradeoff exists.

After drafting, ask the user to review. Do NOT write the `approved` sentinel — the human does that.
