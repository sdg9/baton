# `baton-harness doctor` — design

Status: approved
Date: 2026-05-21
Scope: `packages/harness`

## Problem

The harness install matrix has several independent moving parts:

- A `harness.config.*` file in the consuming repo (7 supported extensions).
- An `openspec/` scaffold with `project.md`.
- An external `openspec` CLI (used for archive + validate) invoked via `npx`.
- An optional commit-msg git hook activated by `git config core.hooksPath = .githooks`.
- A Claude Code plugin (`baton-harness`) whose pinned `npx -p @baton-tools/harness@<version>` invocation must line up with the locally installed CLI version, if any.
- The four verify commands (`lint`, `typecheck`, `unit`, `e2e`) the consuming repo plugs in.

Users have no single command that tells them whether all of this is in place. Failures surface late — usually in the middle of a `/harness <story>` run — with errors that don't always point at the underlying setup problem.

## Goals

- One command, runnable from any consuming repo, that reports the state of the install.
- Diagnostic only — no auto-remediation. Each failure includes a remediation hint pointing at the existing fix path (typically `init` or a `/plugin` command).
- Stable JSON output for the workbench to consume as a "Health" panel.
- A clean separation: `init` scaffolds, `doctor` reports.

## Non-goals

- A `--fix` mode. Remediation flows through existing commands.
- A Claude Code slash command wrapper. If Claude Code itself is broken, a slash command can't help; the CLI is the right entry point.
- Actually executing the configured verify commands. Too slow, possible side effects. The doctor resolves their first token only.
- Validating openspec proposals. That is `baton-harness validate-specs`.

## Public surface

```
baton-harness doctor [--json] [--cwd <path>]
```

- `--json` — emit a structured report to stdout instead of the human renderer.
- `--cwd <path>` — operate against a directory other than `process.cwd()` (used by tests and the workbench).

Exit codes:

- `0` — no hard checks failed (warnings are non-fatal).
- `1` — at least one hard check failed.
- `2` — argument error.

## Architecture

### Module layout

| File | Role | Approx LOC |
|---|---|---|
| `src/doctor.ts` (new) | Pure engine. Exports `runDoctor(cwd, opts): Promise<DoctorReport>`. Defines `CheckResult`, `DoctorReport`, and the individual check functions. | 200–250 |
| `src/cli.ts` (edit) | Add `doctor` to the command map. Argument parsing, human/JSON rendering, exit-code mapping. | +50 |
| `src/index.ts` (edit) | Re-export `runDoctor`, `DoctorReport`, `CheckResult` for workbench consumption. | +3 |
| `src/doctor.test.ts` (new) | Vitest coverage per check + two integration tests. | 200–300 |
| `README.md` (edit) | Add `doctor` row to the CLI reference table. | +1 |

`src/doctor.ts` is split into:

1. A `DoctorContext` builder that resolves the config path with `discoverConfigPath(cwd)`, then attempts `loadConfig(absolutePath)` once and caches one of `{ kind: "ok", config }`, `{ kind: "missing" }`, or `{ kind: "error", message }`. The context also caches `cwd` and lazily-resolved tool versions.
2. A list of check functions of shape `(ctx) => Promise<CheckResult>`. Each is small, isolated, and individually testable.
3. `runDoctor(cwd, opts)` — orchestrates: builds context, runs checks sequentially in a declared order, returns the aggregated `DoctorReport`.

The CLI does only I/O concerns: argument parsing, formatting, exit code.

### Types

```ts
export type CheckTier = "hard" | "soft";
export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;          // stable identifier, e.g. "openspec-dir"
  tier: CheckTier;
  status: CheckStatus;
  message?: string;      // human-readable detail (path, version, etc.)
  hint?: string;         // remediation pointer
}

export interface DoctorReport {
  ok: boolean;           // false iff any hard check is "fail"
  cwd: string;
  summary: { pass: number; warn: number; fail: number };
  checks: CheckResult[]; // declared order, never reordered
}
```

### Check list

Order is the order of emission — keep it readable.

**Hard checks** (a `fail` flips `ok` to `false` and exits 1):

| name | What it checks | Failure hint |
|---|---|---|
| `git-repo` | `git rev-parse --is-inside-work-tree` returns true. | `cd into a git repo or run 'git init'` |
| `node-version` | `process.versions.node` meets the minimum declared in `@baton-tools/harness/package.json` `engines.node` (currently `>=18.17.0`). The doctor reads its own package metadata via `import.meta.url`. | `upgrade node to >= <min>` |
| `git-on-path` | `git --version` resolves. | `install git` |
| `config-present` | `discoverConfigPath(cwd)` returns non-null. Reports the filename in `message`. The `DoctorContext` builder has already done the lookup; this check just consults the cached result. | `run 'npx -y @baton-tools/harness init'` |
| `config-parses` | The cached `loadConfig(absolutePath)` result is `kind: "ok"`. On `"error"`, the `HarnessConfigError` message goes into `message`. If `config-present` failed (no config file at all), this emits `status: "fail", message: "skipped: no config file"` so the JSON check list keeps a stable shape. | `fix the parse/validation error above` |
| `openspec-dir` | `<cwd>/<openspecDir>` exists and is a directory. | `run 'npx -y @baton-tools/harness init'` |
| `openspec-project-md` | `<openspecDir>/project.md` exists. | `run 'npx -y @baton-tools/harness init'` |
| `openspec-cli` | `npx --no-install @fission-ai/openspec --version` resolves (does not call any subcommand). | `npm i -D @fission-ai/openspec` or `npx -y @fission-ai/openspec ...` |
| `verify-lint` / `verify-typecheck` / `verify-unit` / `verify-e2e` | First token of each configured command resolves on PATH or in `<cwd>/node_modules/.bin`. Resolve only — never execute. | `install the missing tool or fix the verify config` |

If `config-parses` fails, every check below that depends on the config (`openspec-dir`, `openspec-project-md`, `verify-*`, gitignore checks, version-drift) emits `status: "fail"` (if hard) or `"warn"` (if soft) with `message: "skipped: config unavailable"`. They are never omitted from the report — the JSON shape stays stable for the workbench.

**Soft checks** (`warn` is informational, `fail` here is upgraded to `warn` rather than affecting exit):

| name | What it checks | Hint |
|---|---|---|
| `git-hook` | `<cwd>/.githooks/commit-msg` exists AND `git config --local --get core.hooksPath` returns `.githooks`. | `re-run 'init --with-hook'` |
| `gitignore-worktree` | `<cwd>/.gitignore` contains a line matching `worktreeDir`. | `echo '<worktreeDir>/' >> .gitignore` |
| `gitignore-logs` | `<cwd>/.gitignore` contains a line matching `logDir`. | `echo '<logDir>/' >> .gitignore` |
| `claude-on-path` | `claude --version` resolves. Informational — also reports the version in `message`. | `install Claude Code` |
| `plugin-installed` | Best-effort search of `~/.claude/plugins/` for a directory whose `plugin.json` declares the `baton-harness` plugin (any version). | `/plugin install baton-harness@baton` |
| `superpowers-installed` | Best-effort search of `~/.claude/plugins/` for `superpowers`. | `/plugin install superpowers@<source>` |
| `version-drift` | Compares two versions: (a) the running CLI's own `package.json#version` (read via `import.meta.url`), and (b) the version pinned in `plugin/skills/autonomous-harness/SKILL.md`, extracted by regex `@baton-tools/harness@([0-9]+\.[0-9]+\.[0-9]+[^ ]*)` from the first match in that file. Only emitted when a local CLI install is detected — defined as the existence of `<cwd>/node_modules/@baton-tools/harness/package.json`. When running purely via `npx -y` with no local install, the check is omitted. | `npm i -D @baton-tools/harness@<plugin-pinned-version>` or `/plugin update baton-harness` |

The `plugin-installed` and `superpowers-installed` checks are explicitly best-effort. If `~/.claude/plugins/` does not exist or its layout changes in a future Claude Code release, both emit `status: "warn"` with `message: "could not introspect ~/.claude/plugins"` rather than `"fail"`.

### Output

**Human (default).** Sections by tier, fixed-width status column, indented hint on a second line when present, trailing summary:

```
baton-harness doctor — /Users/you/project

Hard checks
  PASS  git-repo
  PASS  node-version              22.13.0 (>= 20)
  PASS  config-present            harness.config.ts
  FAIL  openspec-dir              openspec/ not found
        hint: run `npx -y @baton-tools/harness init`
  ...

Soft checks
  WARN  git-hook                  .githooks/commit-msg missing
        hint: re-run `init --with-hook`
  PASS  gitignore-worktree
  ...

Result: 1 fail, 2 warn, 12 pass.
```

**JSON (`--json`).** A single object with the schema above. No prose, no logging interleaved on stdout. stderr remains free for unexpected errors (which would still result in exit 1).

### Error handling

- Per-check try/catch in `runDoctor`. An unexpected exception in a check function becomes a `fail` (hard) / `warn` (soft) result with `message: "<exception message>"`. The run never aborts mid-list.
- An exception escaping `runDoctor` itself (e.g. cwd unreadable) is caught in the CLI shim, printed to stderr, and exits 1.

## Testing strategy

Vitest, following the pattern in `src/config-loader.test.ts` (tmp dirs, no test doubles for filesystem).

**Per-check unit tests** — each check function exercised with at least one pass and one fail/warn fixture:

- `git-repo`: a tmp dir with `git init` vs. one without.
- `config-present` / `config-parses`: scaffold via `init` vs. an empty dir vs. a deliberately broken config.
- `openspec-dir` / `openspec-project-md`: scaffold then delete the target.
- `verify-*`: configs pointing at `node` (resolves) vs. `does-not-exist-xyz`.
- `git-hook`: scaffold + `--with-hook` vs. scaffold without.
- `gitignore-*`: tmp dir with the expected line, missing, present-via-glob-pattern.
- `version-drift`: stub `SKILL.md` and `package.json` reads via the function's `readFile` injection point.

**Integration tests** — drive `runDoctor` end-to-end:

1. **Healthy scaffold**: `init` into a tmp dir, run `runDoctor`, assert `ok: true` and every hard check is `pass`. Soft checks for plugin detection are allowed to `warn` because the test environment may not have Claude Code's plugin cache.
2. **Broken scaffold**: tmp dir with no config and no openspec dir, run `runDoctor`, assert `ok: false` and the expected set of hard fails — including that downstream config-dependent checks emit the "skipped: config unavailable" sentinel.

**JSON output shape test** — invoke the CLI with `--json` via `tsx` (matching the pattern used elsewhere if any; otherwise via the built CLI) against the healthy scaffold and assert the output parses and contains every check name from the declared list.

## Risks and mitigations

- **Claude Code plugin cache layout drift.** The `plugin-installed` and `superpowers-installed` checks read a directory whose structure is outside our control. Mitigated by keeping these as best-effort soft checks and emitting "could not introspect" rather than spurious failures.
- **`npx --no-install @fission-ai/openspec --version`** can still hit the network on a cache miss the first time. Acceptable — it's a one-time cost and the doctor explicitly is about verifying the install. We do not call any openspec subcommand to avoid side effects.
- **Performance.** Sequential checks; total runtime dominated by the `npx` lookup and a handful of `which`-style PATH probes. Expected wall-clock: well under 5s on a warm cache. A cold `npx` cache for `@fission-ai/openspec` falls into the `--no-install` failure path (no network fetch) — so even cold, the openspec-cli check stays fast; the only path that pays the download is if the user has the package installed locally but not in the npx cache, which is rare.
- **Stale check list.** New verify gates, new template files, or new plugin-cache paths could add to the check list over time. The check-list table in this document is the source of truth; updates to it must be reflected in `doctor.ts` and `doctor.test.ts` in the same change.

## Open questions

None. The check list, output format, exit-code contract, and scope (no `--fix`, no slash command, no execution of verify commands) were all explicitly approved during brainstorming.
