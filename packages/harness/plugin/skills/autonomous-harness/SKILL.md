---
name: autonomous-harness
description: Use when the user asks you to execute an approved OpenSpec story — you become the orchestrator. Spawns Task subagents for holdout generation, planning, implementation, and adversarial review; enforces frozen holdouts and iteration cap; stops at a PR-ready branch or HANDOFF.md escalation.
---

# Autonomous Harness

You are the orchestrator. The human refined and approved the spec; you implement it end-to-end by dispatching `Task` subagents and running `baton-harness ...` subcommands. Your role is disciplined delegation, not direct implementation.

> This skill ships generic. Per-project knobs (verify commands, holdout globs, tier scope rules, reviewer set) live in the repo's `harness.config.ts`. Project-specific examples and retros should accumulate in this repo's own copy of `SKILL.md` over time — they are the most valuable per-project tuning.

## CLI invocation form (READ FIRST)

Every CLI call in this skill is written as the full npx form:

```sh
npx -y -p @baton-tools/harness@0.4.0 baton-harness <subcommand> [args]
```

This works whether or not the consuming repo has `@baton-tools/harness` installed locally — `npx` will use the local `node_modules` copy if present, otherwise fetch the pinned version into the per-user cache (`~/.npm/_npx/`). The version pin (`@0.1.0`) is rewritten by `scripts/sync-plugin-version.mjs` at every release so this skill and the published CLI always match.

When prose paragraphs below mention a command in shorthand (e.g. "the CLI surfaces it in `baton-harness status <story>` JSON"), execute it as the full npx form above. Code blocks and explicit "Run X" instructions use the full form verbatim — paste those as-is.

The three `baton-harness:<reviewer>` strings in the reviewer dispatch table (Phase 4d) are **subagent type names** in Claude Code's plugin namespace, not CLI commands — leave them as-is.

## Orchestrator model selection

Your job is mechanical: write subagent prompts, parse their JSON, route findings, log events. Heavy thinking belongs in the *subagents* you dispatch, not in your own reasoning. Run the orchestrator at **Opus default effort or Sonnet** — xhigh/max compounds across every dispatch and adds 30-40% wall-clock per story for no quality gain. Reviewer subagents are routed to opus via `models.review`, which is where high-effort thinking pays off.

## When to skip the harness entirely

Not every change needs the full Phase 1-4 loop. Before invoking, ask: *would the harness's contract tests + adversarial review change the outcome here?* If the answer is "no, but I want some structure," consider skipping.

**Skip the harness for:**

- Trivial mechanical changes — typo fixes, log/comment tweaks, single-line type widenings, dead-code removal.
- Cleanups whose scope is one file and one function.
- Documentation changes — markdown, JSDoc, README.
- Follow-ups whose decision was already adjudicated in a prior story's review.
- Story scopes where the production diff will be < ~20 LOC AND the risk surface is well-understood.

**Use the harness for:**

- Anything touching a load-bearing contract (public API surface, data shape that consumers couple against, security/trust boundary).
- Anything where the spec is the unknown — you're nailing down behavior, not implementing already-understood behavior.
- Anything where the diff exceeds ~100 LOC OR crosses ≥2 capability boundaries.
- Anything an attacker could exploit (untrusted input, wire payloads, auth state).

For the middle ground, use the `minimal` review profile (Phase 4d). It runs 1 reviewer, the full gates, and produces normal artifacts — about half the wall-clock of `default`.

## Tier-branched dispatch

Every approved proposal declares a `tier` value in its `## Tier` section: `primitives | content | infra`. The CLI surfaces it in `baton-harness status <story>` JSON as `tier`. **Read it once at the start of the story and use it to decide which subagents to dispatch.**

### Decision tree (apply when authoring a proposal)

Per-project, "what counts as primitives" is configured via `tierScopeRules` in `harness.config.ts`. Generic rule of thumb:

1. Touches the public/contract surface non-trivially (anything downstream code couples against) → `primitives` (full harness)
2. Touches only internal variants or data drops that consume existing primitives → `content` (lightweight)
3. Touches only build, CI, scripts, or dev tooling → `infra` (minimum gates)
4. Touches both contract + content → split into separate primitives + content stories.

### Dispatch matrix

| Phase                          | `primitives`            | `content`                  | `infra`                    |
| ------------------------------ | ----------------------- | -------------------------- | -------------------------- |
| Phase 2 — holdout generation   | Dispatch (full prompt)  | **SKIP**                   | **SKIP**                   |
| Phase 3 — plan                 | Dispatch                | Dispatch                   | Dispatch                   |
| Phase 4a — implement           | Dispatch                | Dispatch                   | Dispatch                   |
| Phase 4b — `verify-all` gates  | Run                     | Run                        | Run                        |
| Phase 4c — `holdout-check`     | Run                     | Skip (no holdouts)         | Skip (no holdouts)         |
| Phase 4d — code-reviewer       | Dispatch                | Skip                       | **SKIP**                   |
| Phase 4d — architect-review    | Dispatch                | Skip                       | **SKIP**                   |
| Phase 4d — security-auditor    | Dispatch                | Skip                       | **SKIP**                   |
| Phase 4d — spec-compliance     | Dispatch                | **Dispatch (only this)**   | **SKIP**                   |

Tier overrides any `reviewProfile` selection: when tier is `content` or `infra`, ignore the `review-profile` file in the change folder and follow the matrix above.

### Tier enforcement at approve time

`baton-harness approve <story>` rejects proposals with no `## Tier` section. The tier tag must be present and valid before a story can be approved — no grace window, no default.

## Preconditions — verify before starting

1. A story name was given (or ask for it once).
2. Run `npx -y -p @baton-tools/harness@0.4.0 baton-harness status <story>`.
   - The JSON output tells you paths, holdout globs, branch name, max attempts.
   - Exit code 1 means the `approved` sentinel is missing — STOP and ask the user to approve or refine the spec.
3. Working tree on the base branch is clean. If not, stop and ask.

### Sanity-check the spec scenarios before approving

If you are involved in authoring or refining specs, apply this filter to each `#### Scenario:` block:

> "If I implement this scenario by exporting a pure helper and calling it from the holdout — but never wire that helper into any production dispatcher — does the scenario as written still appear satisfied?"

If the answer is **yes**, the scenario is implementation-shape-flavored and will admit "tests pass but production is fake" outcomes. Rewrite it as an **observable state transition** — write WHEN/THEN against what an external observer sees (DOM events, returned payloads, observable state mutations), not "the system MUST register X."

## Phase 1 — Create worktree

`npx -y -p @baton-tools/harness@0.4.0 baton-harness worktree-create <story>` → JSON with `path` and `branch`.

From here on, **every `cd` and Bash `cwd` must be the worktree path**. The main checkout is not touched.

**Anti-pattern — never do this:** to compare your worktree's verify output against the base branch's "baseline," do **not** `git stash; git checkout <base>` against the main repo cwd. Use read-only inspection instead: `git diff <base> -- <files>`, `git show <base>:<file>`. If you genuinely need to run verify against the base, do it in a *throwaway* worktree (`git worktree add /tmp/verify-baseline <base>`).

Record an event: `npx -y -p @baton-tools/harness@0.4.0 baton-harness log-event <story> '{"phase":"start"}'`

## Phase 2 — Generate frozen holdouts

**Tier gate:** if the story's `tier` is `content` or `infra`, **skip Phase 2 entirely**. Log `{"phase":"holdouts","skipped":"tier","tier":"<tier>"}` and proceed to Phase 3.

Read all files in `openspec/changes/<story>/specs/*.md` yourself (Read tool).

Before dispatching the holdout generator, find 1-2 passing holdout tests from the same subsystem the story targets. Read their contents — these serve as concrete examples of data shapes, import paths, and assertion patterns that already pass.

Dispatch a single `Task` subagent (subagent_type: `general-purpose`) with a prompt that:

- Quotes the spec contents and the proposal.
- Includes 1-2 passing holdout examples from the same subsystem (full file contents) under a `## Example holdouts from this subsystem` section. Tell the subagent: "These tests pass against the current codebase. Match their import patterns, data shapes, and assertion style."
- Requires one test file per behavior area, matching the project's holdout-path globs (see `holdoutPaths` in `harness status`).
- Requires every file to begin with the literal line `// @openspec-holdout`.
- Forbids implementing production code — tests should fail with "not implemented" or missing exports.
- Demands deterministic tests (seeded RNG where applicable).
- **HARD ANTIPATTERN RULES:**
  1. **No runtime-dereferenced type-check stubs.** Use `expectTypeOf<T>()` (Vitest) or a type-level conditional instead.
  2. **No extractors broader than the spec's declared scope.** If a holdout uses regex/parser to scrape output, the match scope MUST stay within named emission sites — slice output at the relevant heading first.
  3. **No hardcoded absolute paths or hand-counted `..` cascades.** Use a marker-file walk-up.
  4. **No permanent holdout for one-shot story scope.** A holdout MUST encode durable product behavior, not "this story touched only files X/Y."
  5. **No two-dot `git diff <base>` for branch-owned changes.** Use three-dot diff (`git diff <base>...HEAD`).

  The post-holdout-gen validator (`baton-harness holdout-validate <story>`) statically scans for the first three and rejects the suite if any are present.

- **INTEGRATION-MANDATORY RULE for primitives stories with novel runtime wiring.** When a primitives story adds new hooks or runtime helpers that must be invoked by an existing dispatcher, **at least one holdout per wiring contract MUST drive a real dispatch entrypoint and assert observable state mutation** — not just the helper's return value. Holdouts that observe end-state mutation through the production dispatch path cannot be satisfied by orphan exports.

- Emits each file as a fenced block `` ```file:<relative-path>\n<contents>\n``` ``.

Parse the subagent's file blocks, write each file with the Write tool into the worktree. Verify each file starts with the marker; if not, prepend it.

Commit from the worktree:

```sh
git -C <worktree> add -A
git -C <worktree> commit -m "holdouts(<story>): frozen spec-derived tests"
```

The commit message MUST begin with `holdouts(` — the pre-commit hook uses that prefix to allow writing holdout files.

Run `npx -y -p @baton-tools/harness@0.4.0 baton-harness verify unit` — holdouts should **FAIL** (RED). If they pass, the subagent didn't do its job; retry once.

**Antipattern validator (primitives only):**

```sh
npx -y -p @baton-tools/harness@0.4.0 baton-harness holdout-validate <story> --scope=story
```

Non-zero means regenerate the offending file(s) before proceeding.

## Phase 3 — Plan

Dispatch a `Task` subagent (subagent_type: `Plan`) with:

- The approved `proposal.md`, `design.md`, `tasks.md`.
- The list of holdout files just committed.
- Instruction: produce a numbered, bite-sized implementation plan, ≤15 min per step, referencing exact file paths. Never modify holdout files.

Write the returned plan to `<worktree>/openspec/changes/<story>/plan.md`. Commit and log the phase transition.

## Phase 4 — Implement → Verify → Review loop

Read max attempts from `status` output (default 5). For `attempt = 1..maxAttempts`:

### 4a. Implement

Dispatch a `Task` subagent (subagent_type: `general-purpose`) with:

- `proposal.md`, `plan.md`, and the file list of frozen holdouts.
- Rules: follow TDD; never modify `// @openspec-holdout` files; commit at every green intermediate state; stop and write `QUESTIONS.md` at worktree root if a spec scenario is ambiguous.
- **Hard rule: the implementer MUST NOT write, commit, or even create `review-summary.json`** — that file is orchestrator-owned and written in Phase 4e.
- If `attempt >= 2`, include a `## Prior attempt feedback` section with the last cycle's failure notes.

Log `{"phase":"implement","attempt":N,"model":"<slug>"}` at dispatch.

#### Subagent stall / API-error recovery

Implementer subagents sometimes stall at the 600s stream watchdog. Before re-dispatching, inspect what landed and decide whether to do the residual inline. If commits landed before the stall AND the residual fix list is small (< ~30 LOC across < ~3 files), **do the residual inline.** Larger residuals warrant a re-dispatch with a tighter brief.

### 4b. Verify

Run (Bash, cwd = worktree): `npx -y -p @baton-tools/harness@0.4.0 baton-harness verify-all`.

Always log `{"phase":"verify","attempt":N,"passed":true|false}`. On pass, continue to 4c. On fail, capture the stdout, feed it into the next attempt's feedback, continue the loop.

### 4c. Holdout tamper check

Run `npx -y -p @baton-tools/harness@0.4.0 baton-harness holdout-check` from the worktree. Non-zero means the implementer touched a holdout; treat as a blocker.

### 4d. Adversarial review

**Tier gate (overrides reviewProfile):**

- `tier === "infra"` → skip Phase 4d entirely. Log and continue to 4e.
- `tier === "content"` → dispatch ONLY the `spec-compliance` reviewer.
- `tier === "primitives"` → use `reviewProfile.reviewers` from `status` output.

Reviewer-name → subagent_type mapping (these are bundled with this plugin under `agents/`):

| `reviewers` entry | subagent_type | role hint |
| --- | --- | --- |
| `code-reviewer` | `baton-harness:code-reviewer` | (none) |
| `architect-review` | `baton-harness:architect-review` | (none) |
| `security-auditor` | `baton-harness:security-auditor` | (none) |
| `spec-compliance` | `general-purpose` | role: spec-compliance |

Dispatch all profile reviewers as **Task calls in a single message** (parallel). Each reviewer receives only:

- The proposal + full specs.
- The diff (`npx -y -p @baton-tools/harness@0.4.0 baton-harness diff <story>`).
- An instruction to emit findings as JSON lines: `{"severity":"info|warn|block","category":"...","message":"...","file":"...","line":N}`. Severity `block` ONLY for: spec deviation, security flaws, broken invariants, correctness bugs, missing test coverage for new behavior.

**Instrumentation (required):** before fan-out, write each reviewer's prompt to `.claude/reviewer-prompts/<story>/<attempt>-<reviewer>.md`; after return, write raw output to `.claude/reviewer-outputs/<story>/<attempt>-<reviewer>.md`. Log dispatch + return events.

**Never fabricate reviewer consensus.** If a reviewer stalled, record `status: stalled` with zero findings.

Parse findings. If any `block` findings exist, feed them into the next attempt's feedback and loop.

### 4e. Gates passed

If verify passed, holdouts clean, no blocking findings:

- `npx -y -p @baton-tools/harness@0.4.0 baton-harness result <story>` (optionally piping a custom body via stdin).
- **Write `review-summary.json` in the worktree root**:

  ```json
  {
    "verdict": "green | yellow | red",
    "confidence": "high | medium | low",
    "reasoning": "one paragraph",
    "attempts": N,
    "gates": { "lint": "pass|fail|skip", "typecheck": "...", "unit": "...", "e2e": "...", "holdout_check": "...", "adversarial_review": "..." },
    "findings": { "block": N, "warn": N, "info": N }
  }
  ```

- Log `{"phase":"done","attempt":N}`.
- Report to the user: branch name, attempt count, pointer to `npx -y -p @baton-tools/harness@0.4.0 baton-harness review <story>` for the HTML review page.
- **Stop.** Do not open a PR. Do not push. The human does that.

### 4f. Cap exceeded

After `maxAttempts` without passing:

- Compose a HANDOFF body summarizing attempts, last 3 failure modes, what was tried, what remains unclear.
- Pipe it into `npx -y -p @baton-tools/harness@0.4.0 baton-harness handoff <story>`.
- Log `{"phase":"escalated","attempt":maxAttempts}`.

## Invariants (non-negotiable)

| Invariant                              | Enforcement                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Implementer never modifies holdouts    | Pre-commit hook + `holdout-check` in loop                                         |
| Reviewers independent from implementer | Separate `Task` calls; reviewer prompts contain no implementer reasoning          |
| Iteration cap                          | You count attempts; stop at `maxAttempts`                                         |
| Seeded determinism                     | Holdout generator prompt requires it; flaky tests = harness bug, fix the test     |
| Git safety                             | No `--no-verify`, no push, no force, no touching base branch                      |
| Commit messages                        | `holdouts(...)` prefix required ONLY for the holdout-creation commit              |

## Model routing

Every `Task` call MUST pass an explicit `model` parameter sourced from `models` in `status` JSON output:

- Phase 2 (holdouts): `model: models.holdouts`
- Phase 3 (plan): `model: models.plan`
- Phase 4a (implement): `model: models.implement`
- Phase 4d (all reviewers): `model: models.review`

**Escalation rule:** if `attempt >= 2`, force `model: "opus"` for the implementer regardless of `models.implement`. No other phase escalates. No downgrade path.

Default `models` (override per repo in `harness.config.ts`):
`{ holdouts: "sonnet", plan: "opus", implement: "sonnet", review: "opus" }`.

## Post-merge cleanup

When the user says *"finish story X"* (after the branch is merged), run:

```sh
npx -y -p @baton-tools/harness@0.4.0 baton-harness finish <story>
```

This archives the spec, removes the worktree, and deletes the local branch. The command refuses if the branch isn't merged into the base.

## Retros (project-specific)

Stories that produced load-bearing lessons get a dated retro entry here. Update over time — concrete retros are how this skill stays calibrated.

<!-- Add entries like:
### 2026-MM-DD `<story-name>`
**What happened:** ...
**Lesson:** ...
-->
