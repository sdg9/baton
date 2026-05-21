---
description: Iteratively review-and-polish an OpenSpec proposal — up to 3 rounds, auto-applying narrow minor fixes (with one git commit per round so any round can be reverted) and escalating critical decisions to the user in-chat.
argument-hint: <change-name>
---

The user wants to polish OpenSpec change `$ARGUMENTS`. If `$ARGUMENTS` is empty, ask once for the change name and stop until they answer.

## Setup

Resolve the change directory: `openspec/changes/$ARGUMENTS/`. If it doesn't exist, stop and report. If the working tree under that directory is dirty before you start, stop and ask the user to commit or stash — every round's edits need a clean per-round commit boundary so reverts work.

## Loop

Run up to **3 rounds**. Stop early when a round produces **zero auto-apply edits AND zero escalations**, or when the user types `done` at an escalation prompt.

Each round is four steps. Do not interleave them.

### Step 1 — Review

Read every file under the change directory:

- `proposal.md`
- `design.md` (if present)
- `tasks.md`
- `specs/**/spec.md`
- `specs/**/*.delta.md`

Produce a structured findings list. For each finding record:

- `severity`: `critical` | `minor` | `nit`
- `file`: path relative to the change dir
- `location`: section heading or line range
- `issue`: 1–2 sentence description of what's wrong
- `suggested-fix`: the concrete change you'd make

Do not edit any files yet.

### Step 2 — Triage

Classify each finding into **auto-apply** or **escalate**.

**Auto-apply** — only `minor` or `nit` findings that match one of:

- Typos, grammar, punctuation.
- Missing required section in a known template: `proposal.md` missing `## Why` / `## What changes` / `## Impact` / `## Tier`; `spec.md` missing a Requirement or Scenarios block; `tasks.md` missing the `## Archive-time cleanup` section when items would orphan.
- Heading or section-order normalization to match the OpenSpec template.
- Cross-file terminology consistency where one canonical choice is obvious (e.g., two files use different names for the same concept; pick the one used in the most authoritative file, usually `proposal.md`).
- Broken intra-doc references (a link or section reference that no longer resolves).
- Filling in a placeholder (`<TBD>`, `TODO:`, `???`) when another section in the same change already gives the answer.

**Escalate** — everything else, including any `critical` finding. In particular escalate:

- New requirements that the user did not author.
- Behavioral choices (sync vs async, push vs pull, single-writer vs multi, error vs silent skip).
- Scope expansion suggestions ("you should also handle X").
- Architectural choices (transport, schema shape, data ownership, retry semantics).
- Terminology where neither choice is obviously canonical.
- Any finding that would require a change *outside* the change directory.

**When in doubt, escalate.** A liberal classifier drifts the proposal silently across rounds — that's the failure mode this command is designed to avoid.

### Step 3 — Apply auto-apply edits

Edit the files in place using the Edit tool. After all edits in this round:

```sh
git add openspec/changes/$ARGUMENTS/
git commit -m "polish(<change>): round <N> auto-applied <count> minor edits"
```

In the commit body, list each edit one per line as `<file>: <short description>`. If there are no auto-apply edits in this round, do not commit anything in this step.

### Step 4 — Present escalations to the user

If there are no escalations, skip to the polish-log update (below) and start the next round.

Otherwise, print a numbered list to the user. For each escalation:

```
[N] <file> · <location>
    Issue: <one-line summary>
    Recommended: <the suggested-fix from the finding, phrased as a concrete action>
    Accept (a) / reject (r) / other (free text)?
```

Wait for the user's reply. Apply accepted recommendations as edits. For "other" answers, apply the user's text literally as the resolution (asking one clarifying follow-up only if the answer is genuinely ambiguous). For "reject", do nothing and record it.

After applying:

```sh
git add openspec/changes/$ARGUMENTS/
git commit -m "polish(<change>): round <N> applied <count> user-approved edits"
```

If the user typed `done` at any point in this step, stop the entire command after committing what was already approved.

### Step 5 — Append to `polish-log.md`

At the end of every round (even if both edit categories were empty — record the empty round so the convergence path is auditable), append a section to `openspec/changes/$ARGUMENTS/polish-log.md`. Create the file with `# Polish log` at the top if it doesn't exist yet.

```markdown
## Round <N> — <ISO 8601 date>

### Auto-applied
- <file>: <short description>
- ...

### Escalations
- **Issue**: ...
  **Recommended**: ...
  **User answer**: accepted | rejected | <verbatim custom text>
- ...
```

Use `(none)` for either subsection if empty. Commit the log update in the same commit as the round's edits — if both edit categories produced no commit, commit the polish-log update on its own with `polish(<change>): round <N> no edits (logged for audit)`.

## Boundary

Only edit files inside `openspec/changes/$ARGUMENTS/`. Never touch source code, `openspec/specs/` (the active spec snapshots), or any file outside the change dir. If a finding implies a code or out-of-scope change, escalate it with the suggested-fix wording exactly as the reviewer would have done — let the user decide.

## After stopping

Print a summary:

- Rounds run / rounds capped at 3.
- Stop reason: convergence (zero findings) / round cap / user `done`.
- Total auto-applied edits.
- Total escalations: accepted / rejected / other.
- The list of round commit SHAs in the order they were created.
- Anything you still feel uncertain about — phrased as a list of open questions the user should think about even though no round flagged them.
