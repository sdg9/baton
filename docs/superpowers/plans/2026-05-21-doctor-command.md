# `baton-harness doctor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `baton-harness doctor` subcommand that verifies the consuming repo's install (config, openspec scaffold, external CLIs, verify commands) plus best-effort detection of the Claude Code plugin and superpowers. Outputs human-readable text by default and a stable JSON schema with `--json`.

**Architecture:** A pure engine in `src/doctor.ts` exposes `runDoctor(cwd, opts): Promise<DoctorReport>`. Each check is an isolated async function returning a `CheckResult`. The CLI shim parses args, renders human or JSON output, and maps exit codes (0 unless any hard check fails). All filesystem state is read from the passed-in cwd — no `process.chdir()` ever — so tests run cleanly in parallel.

**Tech Stack:** TypeScript (ESM), Vitest, Node ≥18.17.0, tsx (already a runtime dep). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-21-doctor-command-design.md`

---

## File structure

| File | Action | Purpose |
|---|---|---|
| `packages/harness/src/doctor.ts` | Create | Engine: types, `DoctorContext` builder, individual check functions, `runDoctor()` orchestrator. |
| `packages/harness/src/cli.ts` | Modify | Add `doctor` to the command map. Implement the CLI shim (arg parsing, human renderer, JSON renderer, exit-code mapping). |
| `packages/harness/src/index.ts` | Modify | Re-export `runDoctor`, `DoctorReport`, `CheckResult`, `CheckStatus`, `CheckTier`. |
| `packages/harness/src/doctor.test.ts` | Create | Per-check unit tests + integration tests (healthy + broken scaffold) + JSON shape. |
| `packages/harness/README.md` | Modify | Add a `doctor` row to the CLI reference table. |

**Key conventions (from existing code):**
- ESM imports use the `.js` extension even for `.ts` source.
- Vitest tests use `mkdtempSync(join(tmpdir(), "harness-..."))` for isolation.
- Never call `process.chdir()` in tests — pass cwd explicitly. (`tsx`'s persistent worker dislikes inter-test chdir.)
- Errors that should surface through the CLI exit non-zero use a documented exit code (0 ok, 1 fail, 2 arg error).

---

## Task 1: Scaffold engine, types, and first check (git-repo) end-to-end through the CLI

This task proves the whole vertical: types, context, the runDoctor orchestrator, one trivial check, the CLI command, and the human renderer. Everything else is additive after this lands.

**Files:**
- Create: `packages/harness/src/doctor.ts`
- Modify: `packages/harness/src/cli.ts` (add `doctor` to command map + shim)
- Test: `packages/harness/src/doctor.test.ts`

- [ ] **Step 1.1: Write the failing test for `runDoctor` with one check (git-repo) in a non-git tmp dir**

Create `packages/harness/src/doctor.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "./doctor.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-doctor-test-"));
}

describe("runDoctor — git-repo check", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a fail result when cwd is not a git repo", async () => {
    const report = await runDoctor(dir);
    const gitRepo = report.checks.find((c) => c.name === "git-repo");
    expect(gitRepo).toBeDefined();
    expect(gitRepo?.tier).toBe("hard");
    expect(gitRepo?.status).toBe("fail");
    expect(report.ok).toBe(false);
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
  });

  it("emits a pass result when cwd is a git repo", async () => {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    const report = await runDoctor(dir);
    const gitRepo = report.checks.find((c) => c.name === "git-repo");
    expect(gitRepo?.status).toBe("pass");
  });
});
```

- [ ] **Step 1.2: Run the test — confirm it fails because `doctor.ts` does not exist**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: FAIL with a module-not-found error for `./doctor.js`.

- [ ] **Step 1.3: Create `packages/harness/src/doctor.ts` with types, context builder, runDoctor, and the git-repo check**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Public types ---------------------------------------------------------------

export type CheckTier = "hard" | "soft";
export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;
  tier: CheckTier;
  status: CheckStatus;
  message?: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  cwd: string;
  summary: { pass: number; warn: number; fail: number };
  checks: CheckResult[];
}

export interface RunDoctorOptions {
  // Reserved for future flags (e.g. skipping plugin detection in CI).
  // Empty for now — kept on the signature so adding flags later is a
  // non-breaking change.
}

// Internal context ----------------------------------------------------------

interface DoctorContext {
  cwd: string;
}

async function buildContext(cwd: string): Promise<DoctorContext> {
  return { cwd };
}

// Check functions ----------------------------------------------------------

type Check = (ctx: DoctorContext) => Promise<CheckResult>;

async function checkGitRepo(ctx: DoctorContext): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: ctx.cwd },
    );
    if (stdout.trim() === "true") {
      return { name: "git-repo", tier: "hard", status: "pass" };
    }
    return {
      name: "git-repo",
      tier: "hard",
      status: "fail",
      message: "not inside a git working tree",
      hint: "cd into a git repo or run `git init`",
    };
  } catch (err) {
    return {
      name: "git-repo",
      tier: "hard",
      status: "fail",
      message: err instanceof Error ? err.message.split("\n")[0] : String(err),
      hint: "cd into a git repo or run `git init`",
    };
  }
}

const HARD_CHECKS: Check[] = [checkGitRepo];
const SOFT_CHECKS: Check[] = [];

// Orchestrator -------------------------------------------------------------

export async function runDoctor(
  cwd: string,
  _opts: RunDoctorOptions = {},
): Promise<DoctorReport> {
  const ctx = await buildContext(cwd);
  const checks: CheckResult[] = [];
  for (const check of [...HARD_CHECKS, ...SOFT_CHECKS]) {
    checks.push(await runOne(check, ctx));
  }
  const summary = summarize(checks);
  const ok = !checks.some((c) => c.tier === "hard" && c.status === "fail");
  return { ok, cwd, summary, checks };
}

async function runOne(check: Check, ctx: DoctorContext): Promise<CheckResult> {
  try {
    return await check(ctx);
  } catch (err) {
    // Belt-and-braces: a check that throws despite its own try/catch becomes
    // a hard fail with the exception message. Better than aborting the run.
    return {
      name: check.name || "unknown",
      tier: "hard",
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarize(checks: CheckResult[]) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  return summary;
}
```

- [ ] **Step 1.4: Run the test — confirm it passes**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS (both `git-repo` cases).

- [ ] **Step 1.5: Add `doctor` to the CLI command map**

Edit `packages/harness/src/cli.ts`. In the `commands` record (around line 27), add the entry — keep alphabetical-by-route grouping but slot it next to `diff` for visibility:

```ts
const commands: Record<string, Command> = {
  init: initCmd,
  status,
  approve,
  unapprove,
  "worktree-create": worktreeCreate,
  "worktree-remove": worktreeRemove,
  "verify-all": verifyAll,
  verify,
  diff,
  doctor: doctorCmd,                    // NEW
  "holdout-check": holdoutCheck,
  "holdout-validate": holdoutValidateCmd,
  "log-event": logEvent,
  result,
  handoff,
  "validate-specs": validateSpecs,
  finish,
  accept,
  review,
  "run-queue": runQueueCmd,
  "verify-escalation": verifyEscalationCmd,
  "merge-to-main": mergeToMainCmd,
  help,
};
```

Then add the implementation. Place near the other lazy-loaded subcommand wrappers (after `runQueueCmd` around line 60):

```ts
async function doctorCmd(args: string[]): Promise<number> {
  let cwd = process.cwd();
  let asJson = false;
  for (const arg of args) {
    if (arg === "--json") {
      asJson = true;
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      cwd = arg.slice("--cwd=".length);
      continue;
    }
    if (arg === "--cwd") {
      process.stderr.write("doctor: --cwd requires a value (use --cwd=<path>)\n");
      return 2;
    }
    process.stderr.write(`doctor: unknown argument "${arg}"\n`);
    return 2;
  }

  const { runDoctor, renderHuman, renderJson } = await import("./doctor.js");
  const report = await runDoctor(cwd);
  if (asJson) {
    process.stdout.write(`${renderJson(report)}\n`);
  } else {
    process.stdout.write(`${renderHuman(report)}\n`);
  }
  return report.ok ? 0 : 1;
}
```

- [ ] **Step 1.6: Add `renderHuman` and `renderJson` to `doctor.ts`**

Append to `packages/harness/src/doctor.ts`:

```ts
// Renderers ----------------------------------------------------------------

export function renderJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderHuman(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`baton-harness doctor — ${report.cwd}`);
  lines.push("");
  lines.push("Hard checks");
  for (const c of report.checks.filter((c) => c.tier === "hard")) {
    lines.push(formatRow(c));
    if (c.hint) lines.push(`        hint: ${c.hint}`);
  }
  const soft = report.checks.filter((c) => c.tier === "soft");
  if (soft.length > 0) {
    lines.push("");
    lines.push("Soft checks");
    for (const c of soft) {
      lines.push(formatRow(c));
      if (c.hint) lines.push(`        hint: ${c.hint}`);
    }
  }
  lines.push("");
  lines.push(
    `Result: ${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.pass} pass.`,
  );
  return lines.join("\n");
}

function formatRow(c: CheckResult): string {
  const tag = c.status.toUpperCase().padEnd(4);
  const name = c.name.padEnd(28);
  const detail = c.message ? `  ${c.message}` : "";
  return `  ${tag}  ${name}${detail}`;
}
```

- [ ] **Step 1.7: Add a smoke test that the renderer produces non-empty output and JSON parses**

Append to `packages/harness/src/doctor.test.ts`:

```ts
import { renderHuman, renderJson } from "./doctor.js";

describe("renderers", () => {
  it("renderHuman includes the section headers and result line", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const out = renderHuman(report);
      expect(out).toContain("baton-harness doctor");
      expect(out).toContain("Hard checks");
      expect(out).toContain("Result:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renderJson produces parseable JSON with summary + checks", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const parsed = JSON.parse(renderJson(report));
      expect(parsed.ok).toBe(false);
      expect(parsed.summary).toMatchObject({ pass: expect.any(Number) });
      expect(Array.isArray(parsed.checks)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 1.8: Run all doctor tests — confirm they pass**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 1.9: Smoke-test the CLI end-to-end**

Run from the repo root:

```bash
cd packages/harness
node --import tsx ./src/cli.ts doctor --cwd="$(mktemp -d)"
```

Expected: human-readable output with `FAIL  git-repo` (no git init in that tmp dir) and `Result: 1 fail, 0 warn, 0 pass.` Exit code: 1.

Then run:

```bash
node --import tsx ./src/cli.ts doctor --json --cwd="$(mktemp -d)" | jq .
```

Expected: well-formed JSON with `ok: false` and a single check entry.

- [ ] **Step 1.10: Commit**

```bash
git add packages/harness/src/doctor.ts packages/harness/src/doctor.test.ts packages/harness/src/cli.ts
git commit -m "feat(harness): scaffold \`doctor\` engine + CLI with git-repo check"
```

---

## Task 2: Hard environment checks — `node-version` and `git-on-path`

These are environment-only — no config needed. Add both checks behind a common pattern, then wire into `HARD_CHECKS`.

**Files:**
- Modify: `packages/harness/src/doctor.ts`
- Test: `packages/harness/src/doctor.test.ts`

- [ ] **Step 2.1: Write failing tests**

Append to `packages/harness/src/doctor.test.ts`:

```ts
describe("runDoctor — environment checks", () => {
  it("emits a pass result for node-version on a supported runtime", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const node = report.checks.find((c) => c.name === "node-version");
      expect(node).toBeDefined();
      expect(node?.tier).toBe("hard");
      // We assume the host running tests has node >=18.17.0 (the engines floor).
      // If the floor changes, update this expectation.
      expect(node?.status).toBe("pass");
      expect(node?.message).toMatch(/\d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a pass result for git-on-path when git is installed", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const git = report.checks.find((c) => c.name === "git-on-path");
      expect(git).toBeDefined();
      expect(git?.tier).toBe("hard");
      // CI hosts and dev machines invariably have git on PATH.
      expect(git?.status).toBe("pass");
      expect(git?.message).toMatch(/git version/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2.2: Run the test — confirm it fails**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts -t "environment checks"`
Expected: FAIL (`node-version` and `git-on-path` checks are not emitted yet).

- [ ] **Step 2.3: Implement `checkNodeVersion` and `checkGitOnPath`, wire them in**

In `packages/harness/src/doctor.ts`, add at the top under existing imports:

```ts
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
```

Add the two check functions before the `HARD_CHECKS` array:

```ts
async function checkNodeVersion(_ctx: DoctorContext): Promise<CheckResult> {
  // Read the engines.node floor from this package's own package.json.
  // `import.meta.url` resolves to dist/doctor.js when published, src/doctor.ts
  // when running via tsx; in both cases the package.json is one or two levels
  // up. Walk a small fixed number of levels to find it.
  const here = dirname(fileURLToPath(import.meta.url));
  let pkgPath: string | null = null;
  let dir = here;
  for (let i = 0; i < 4; i++) {
    const candidate = resolve(dir, "package.json");
    try {
      const text = await readFile(candidate, "utf8");
      const parsed = JSON.parse(text) as { name?: string; engines?: { node?: string } };
      if (parsed.name === "@baton-tools/harness") {
        pkgPath = candidate;
        break;
      }
    } catch {
      // not a package.json, or wrong package — keep walking
    }
    dir = dirname(dir);
  }

  const running = process.versions.node;
  if (!pkgPath) {
    // Engine metadata unavailable — still report the running version, but
    // can't check the floor.
    return {
      name: "node-version",
      tier: "hard",
      status: "pass",
      message: `${running} (engines.node unavailable — could not locate @baton-tools/harness package.json)`,
    };
  }

  const text = await readFile(pkgPath, "utf8");
  const parsed = JSON.parse(text) as { engines?: { node?: string } };
  const floor = parsed.engines?.node ?? ">=0.0.0";
  const required = floor.replace(/^>=\s*/, "").trim();

  if (compareSemver(running, required) >= 0) {
    return {
      name: "node-version",
      tier: "hard",
      status: "pass",
      message: `${running} (>= ${required})`,
    };
  }
  return {
    name: "node-version",
    tier: "hard",
    status: "fail",
    message: `${running} (< ${required})`,
    hint: `upgrade node to >= ${required}`,
  };
}

async function checkGitOnPath(_ctx: DoctorContext): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    return {
      name: "git-on-path",
      tier: "hard",
      status: "pass",
      message: stdout.trim(),
    };
  } catch (err) {
    return {
      name: "git-on-path",
      tier: "hard",
      status: "fail",
      message: err instanceof Error ? err.message.split("\n")[0] : String(err),
      hint: "install git",
    };
  }
}

// Tiny semver comparator: returns -1/0/1 for a vs b.
// Handles the "X.Y.Z" shape we get from `process.versions.node` and engines.
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}
```

Update `HARD_CHECKS` to:

```ts
const HARD_CHECKS: Check[] = [checkGitRepo, checkNodeVersion, checkGitOnPath];
```

- [ ] **Step 2.4: Run the tests — confirm they pass**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS, all tests.

- [ ] **Step 2.5: Commit**

```bash
git add packages/harness/src/doctor.ts packages/harness/src/doctor.test.ts
git commit -m "feat(harness): doctor — add node-version + git-on-path checks"
```

---

## Task 3: Hard config checks — `config-present` and `config-parses`

The context builder now does the config discovery/parse once and caches the result. The two checks read from the cache. Downstream config-dependent checks (added in later tasks) will read from the same cache.

**Files:**
- Modify: `packages/harness/src/doctor.ts`
- Test: `packages/harness/src/doctor.test.ts`

- [ ] **Step 3.1: Write failing tests**

Append to `packages/harness/src/doctor.test.ts`:

```ts
import { writeFileSync } from "node:fs";

const VALID_CONFIG_JSON = JSON.stringify({
  openspecDir: "openspec",
  worktreeDir: ".claude/worktrees",
  logDir: ".claude/harness-logs",
  verification: {
    lint: "echo lint",
    typecheck: "echo typecheck",
    unit: "echo unit",
    e2e: "echo e2e",
  },
  holdouts: { paths: ["src/**/*.holdout.test.ts"], markerComment: "// @openspec-holdout" },
  iteration: { maxAttempts: 3 },
  git: { baseBranch: "main", branchPrefix: "story/", forbidPushToBase: true, blockNoVerify: true },
  tierScopeRules: {},
  fullVerificationTriggers: { exactPaths: [], prefixes: [] },
});

describe("runDoctor — config checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits config-present fail and config-parses fail (skipped) when no config exists", async () => {
    const report = await runDoctor(dir);
    const present = report.checks.find((c) => c.name === "config-present");
    const parses = report.checks.find((c) => c.name === "config-parses");
    expect(present?.status).toBe("fail");
    expect(parses?.status).toBe("fail");
    expect(parses?.message).toMatch(/no config file/i);
  });

  it("emits both passes when a valid harness.config.json is present", async () => {
    writeFileSync(join(dir, "harness.config.json"), VALID_CONFIG_JSON);
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "config-present")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "config-parses")?.status).toBe("pass");
  });

  it("emits config-present pass but config-parses fail when the file is malformed", async () => {
    writeFileSync(join(dir, "harness.config.json"), "{ this is not valid json");
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "config-present")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "config-parses")?.status).toBe("fail");
  });
});
```

- [ ] **Step 3.2: Run the test — confirm it fails**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts -t "config checks"`
Expected: FAIL — config-present and config-parses are not yet emitted.

- [ ] **Step 3.3: Extend `DoctorContext` with cached config state and add the two checks**

In `packages/harness/src/doctor.ts`, replace the existing context block with:

```ts
import type { HarnessConfig } from "./types.js";
import { HarnessConfigError } from "./types.js";

// Internal context ----------------------------------------------------------

type ConfigState =
  | { kind: "ok"; config: HarnessConfig; path: string }
  | { kind: "missing" }
  | { kind: "error"; message: string; path: string };

interface DoctorContext {
  cwd: string;
  configState: ConfigState;
}

async function buildContext(cwd: string): Promise<DoctorContext> {
  return { cwd, configState: await resolveConfigState(cwd) };
}

async function resolveConfigState(cwd: string): Promise<ConfigState> {
  // We re-implement discovery here instead of importing the private
  // discoverConfigPath from config-loader.ts. Two reasons: the list is short
  // (7 names) so duplication cost is tiny, and not importing private symbols
  // keeps config-loader's surface stable.
  const filenames = [
    "harness.config.ts",
    "harness.config.mts",
    "harness.config.mjs",
    "harness.config.js",
    "harness.config.cjs",
    "harness.config.jsonc",
    "harness.config.json",
  ];
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  let path: string | null = null;
  for (const name of filenames) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) {
      path = candidate;
      break;
    }
  }
  if (!path) return { kind: "missing" };

  try {
    const { loadConfig } = await import("./config-loader.js");
    const config = await loadConfig(path);
    return { kind: "ok", config, path };
  } catch (err) {
    const message =
      err instanceof HarnessConfigError || err instanceof Error
        ? err.message
        : String(err);
    return { kind: "error", message, path };
  }
}
```

Now add the two check functions before `HARD_CHECKS`:

```ts
async function checkConfigPresent(ctx: DoctorContext): Promise<CheckResult> {
  if (ctx.configState.kind === "missing") {
    return {
      name: "config-present",
      tier: "hard",
      status: "fail",
      message: "no harness.config.* found in cwd",
      hint: "run `npx -y @baton-tools/harness init`",
    };
  }
  // Both "ok" and "error" mean a file exists.
  const path = ctx.configState.kind === "ok" ? ctx.configState.path : ctx.configState.path;
  const filename = path.split("/").pop() ?? path;
  return {
    name: "config-present",
    tier: "hard",
    status: "pass",
    message: filename,
  };
}

async function checkConfigParses(ctx: DoctorContext): Promise<CheckResult> {
  if (ctx.configState.kind === "ok") {
    return { name: "config-parses", tier: "hard", status: "pass" };
  }
  if (ctx.configState.kind === "missing") {
    return {
      name: "config-parses",
      tier: "hard",
      status: "fail",
      message: "skipped: no config file",
    };
  }
  return {
    name: "config-parses",
    tier: "hard",
    status: "fail",
    message: ctx.configState.message.split("\n")[0],
    hint: "fix the parse/validation error above",
  };
}
```

Update `HARD_CHECKS`:

```ts
const HARD_CHECKS: Check[] = [
  checkGitRepo,
  checkNodeVersion,
  checkGitOnPath,
  checkConfigPresent,
  checkConfigParses,
];
```

- [ ] **Step 3.4: Run the tests — confirm they pass**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS, all tests.

- [ ] **Step 3.5: Commit**

```bash
git add packages/harness/src/doctor.ts packages/harness/src/doctor.test.ts
git commit -m "feat(harness): doctor — add config-present + config-parses checks"
```

---

## Task 4: Hard openspec checks — `openspec-dir`, `openspec-project-md`, `openspec-cli`

The first two depend on the parsed config (the `openspecDir` path). The third is environment-level.

**Files:**
- Modify: `packages/harness/src/doctor.ts`
- Test: `packages/harness/src/doctor.test.ts`

- [ ] **Step 4.1: Write failing tests**

Append to `packages/harness/src/doctor.test.ts`:

```ts
import { mkdirSync } from "node:fs";

describe("runDoctor — openspec checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    // Every test in this block has a valid config — write it once.
    writeFileSync(join(dir, "harness.config.json"), VALID_CONFIG_JSON);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("openspec-dir fails when openspec/ does not exist", async () => {
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "openspec-dir")?.status).toBe("fail");
  });

  it("openspec-dir passes when openspec/ exists", async () => {
    mkdirSync(join(dir, "openspec"));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "openspec-dir")?.status).toBe("pass");
  });

  it("openspec-project-md fails when openspec/ exists but project.md does not", async () => {
    mkdirSync(join(dir, "openspec"));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "openspec-project-md")?.status).toBe("fail");
  });

  it("openspec-project-md passes when openspec/project.md exists", async () => {
    mkdirSync(join(dir, "openspec"));
    writeFileSync(join(dir, "openspec", "project.md"), "# Project\n");
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "openspec-project-md")?.status).toBe("pass");
  });

  it("openspec-dir is skipped (fail) when config is unavailable", async () => {
    rmSync(join(dir, "harness.config.json"));
    const report = await runDoctor(dir);
    const check = report.checks.find((c) => c.name === "openspec-dir");
    expect(check?.status).toBe("fail");
    expect(check?.message).toMatch(/skipped: config unavailable/i);
  });
});

describe("runDoctor — openspec-cli check", () => {
  it("emits a hard check named 'openspec-cli' with a status of pass, warn, or fail", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const cli = report.checks.find((c) => c.name === "openspec-cli");
      expect(cli).toBeDefined();
      expect(cli?.tier).toBe("hard");
      expect(["pass", "warn", "fail"]).toContain(cli?.status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

(The openspec-cli check's status is environment-dependent — we test only that it emits a well-formed result. Integration tests in Task 9 will exercise the pass path explicitly when openspec is in node_modules.)

- [ ] **Step 4.2: Run the test — confirm it fails**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts -t "openspec"`
Expected: FAIL — openspec checks are not yet emitted.

- [ ] **Step 4.3: Add the three check functions and wire them in**

In `packages/harness/src/doctor.ts`, add before `HARD_CHECKS`:

```ts
async function checkOpenspecDir(ctx: DoctorContext): Promise<CheckResult> {
  if (ctx.configState.kind !== "ok") {
    return {
      name: "openspec-dir",
      tier: "hard",
      status: "fail",
      message: "skipped: config unavailable",
    };
  }
  const { existsSync, statSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const dir = resolve(ctx.cwd, ctx.configState.config.openspecDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return {
      name: "openspec-dir",
      tier: "hard",
      status: "fail",
      message: `${ctx.configState.config.openspecDir}/ not found`,
      hint: "run `npx -y @baton-tools/harness init`",
    };
  }
  return {
    name: "openspec-dir",
    tier: "hard",
    status: "pass",
    message: ctx.configState.config.openspecDir,
  };
}

async function checkOpenspecProjectMd(ctx: DoctorContext): Promise<CheckResult> {
  if (ctx.configState.kind !== "ok") {
    return {
      name: "openspec-project-md",
      tier: "hard",
      status: "fail",
      message: "skipped: config unavailable",
    };
  }
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const path = resolve(ctx.cwd, ctx.configState.config.openspecDir, "project.md");
  if (!existsSync(path)) {
    return {
      name: "openspec-project-md",
      tier: "hard",
      status: "fail",
      message: `${ctx.configState.config.openspecDir}/project.md not found`,
      hint: "run `npx -y @baton-tools/harness init`",
    };
  }
  return { name: "openspec-project-md", tier: "hard", status: "pass" };
}

async function checkOpenspecCli(_ctx: DoctorContext): Promise<CheckResult> {
  // `npx --no-install` fails (non-zero exit) when the package is neither in
  // node_modules nor in the npx cache — exactly the signal we want.
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["--no-install", "@fission-ai/openspec", "--version"],
      { timeout: 15_000 },
    );
    return {
      name: "openspec-cli",
      tier: "hard",
      status: "pass",
      message: stdout.trim().split("\n").pop() || "available",
    };
  } catch (err) {
    return {
      name: "openspec-cli",
      tier: "hard",
      status: "fail",
      message: err instanceof Error ? err.message.split("\n")[0] : String(err),
      hint: "run `npx -y @fission-ai/openspec --version` once to warm the cache, or `npm i -D @fission-ai/openspec`",
    };
  }
}
```

Update `HARD_CHECKS`:

```ts
const HARD_CHECKS: Check[] = [
  checkGitRepo,
  checkNodeVersion,
  checkGitOnPath,
  checkConfigPresent,
  checkConfigParses,
  checkOpenspecDir,
  checkOpenspecProjectMd,
  checkOpenspecCli,
];
```

- [ ] **Step 4.4: Run the tests — confirm they pass**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS, all tests.

- [ ] **Step 4.5: Commit**

```bash
git add packages/harness/src/doctor.ts packages/harness/src/doctor.test.ts
git commit -m "feat(harness): doctor — add openspec-dir, openspec-project-md, openspec-cli checks"
```

---

## Task 5: Hard verify-command checks — `verify-lint`, `verify-typecheck`, `verify-unit`, `verify-e2e`

Four sibling checks. Each resolves the first token of the configured command string against PATH or `<cwd>/node_modules/.bin`. Never executes the command.

**Files:**
- Modify: `packages/harness/src/doctor.ts`
- Test: `packages/harness/src/doctor.test.ts`

- [ ] **Step 5.1: Write failing tests**

Append to `packages/harness/src/doctor.test.ts`:

```ts
describe("runDoctor — verify-command checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("verify-lint passes when the first token resolves on PATH (node)", async () => {
    const cfg = JSON.parse(VALID_CONFIG_JSON);
    cfg.verification.lint = "node --version";
    writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "verify-lint")?.status).toBe("pass");
  });

  it("verify-typecheck fails when the first token cannot be resolved", async () => {
    const cfg = JSON.parse(VALID_CONFIG_JSON);
    cfg.verification.typecheck = "definitely-not-a-real-binary-xyz123 --check";
    writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "verify-typecheck")?.status).toBe("fail");
  });

  it("verify-unit passes when the first token resolves in cwd/node_modules/.bin", async () => {
    const cfg = JSON.parse(VALID_CONFIG_JSON);
    cfg.verification.unit = "my-fake-runner --watch=false";
    writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    // Create an executable shim — content doesn't matter; the check resolves only.
    writeFileSync(join(dir, "node_modules", ".bin", "my-fake-runner"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "verify-unit")?.status).toBe("pass");
  });

  it("all four verify-* checks are skipped when config is unavailable", async () => {
    const report = await runDoctor(dir);
    for (const name of ["verify-lint", "verify-typecheck", "verify-unit", "verify-e2e"]) {
      const check = report.checks.find((c) => c.name === name);
      expect(check?.status).toBe("fail");
      expect(check?.message).toMatch(/skipped: config unavailable/i);
    }
  });
});
```

- [ ] **Step 5.2: Run the tests — confirm they fail**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts -t "verify-command"`
Expected: FAIL — verify-* checks not yet emitted.

- [ ] **Step 5.3: Implement `checkVerifyCommand` (factory) and wire four instances**

In `packages/harness/src/doctor.ts`, first add this to the existing `import type { HarnessConfig } from "./types.js"` line so it imports `VerificationKind` too:

```ts
import type { HarnessConfig, VerificationKind } from "./types.js";
```

Then add the factory function before `HARD_CHECKS`:

```ts
function makeVerifyCheck(kind: VerificationKind): Check {
  const name = `verify-${kind}`;
  const fn = async (ctx: DoctorContext): Promise<CheckResult> => {
    if (ctx.configState.kind !== "ok") {
      return { name, tier: "hard", status: "fail", message: "skipped: config unavailable" };
    }
    const cmd = ctx.configState.config.verification?.[kind];
    if (!cmd || typeof cmd !== "string" || cmd.trim() === "") {
      return {
        name,
        tier: "hard",
        status: "fail",
        message: `verification.${kind} is not set`,
        hint: `set verification.${kind} in your harness.config`,
      };
    }
    // First token = the binary. Strip any leading env-var assignments like
    // `FOO=bar cmd` for robustness against common patterns.
    const tokens = cmd.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i] ?? "")) i++;
    const firstToken = tokens[i];
    if (!firstToken) {
      return {
        name,
        tier: "hard",
        status: "fail",
        message: `could not extract a binary token from "${cmd}"`,
      };
    }

    const resolved = await resolveBinary(firstToken, ctx.cwd);
    if (!resolved) {
      return {
        name,
        tier: "hard",
        status: "fail",
        message: `binary "${firstToken}" not found on PATH or in node_modules/.bin`,
        hint: "install the missing tool or fix the verify command",
      };
    }
    return { name, tier: "hard", status: "pass", message: `${firstToken} → ${resolved}` };
  };
  // Give the function a real name so the runOne fallback can report it.
  Object.defineProperty(fn, "name", { value: `checkVerify_${kind}` });
  return fn;
}

async function resolveBinary(token: string, cwd: string): Promise<string | null> {
  const { existsSync, statSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // 1. Absolute or cwd-relative path with separators — accept if executable.
  if (token.includes("/") || token.includes("\\")) {
    const abs = resolve(cwd, token);
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
    return null;
  }

  // 2. cwd/node_modules/.bin/<token>
  const local = resolve(cwd, "node_modules", ".bin", token);
  if (existsSync(local)) return local;
  // Also check Windows-style .cmd/.ps1 variants.
  if (existsSync(`${local}.cmd`)) return `${local}.cmd`;

  // 3. PATH lookup — defer to `which`/`where`. Both return non-zero when not
  // found; we treat any non-zero as "not resolved".
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(lookup, [token]);
    const first = stdout.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}
```

Update `HARD_CHECKS`:

```ts
const HARD_CHECKS: Check[] = [
  checkGitRepo,
  checkNodeVersion,
  checkGitOnPath,
  checkConfigPresent,
  checkConfigParses,
  checkOpenspecDir,
  checkOpenspecProjectMd,
  checkOpenspecCli,
  makeVerifyCheck("lint"),
  makeVerifyCheck("typecheck"),
  makeVerifyCheck("unit"),
  makeVerifyCheck("e2e"),
];
```

- [ ] **Step 5.4: Run the tests — confirm they pass**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5.5: Commit**

```bash
git add packages/harness/src/doctor.ts packages/harness/src/doctor.test.ts
git commit -m "feat(harness): doctor — add verify-{lint,typecheck,unit,e2e} resolution checks"
```

---

## Task 6: Soft filesystem checks — `git-hook`, `gitignore-worktree`, `gitignore-logs`

All three live in the consuming repo's working tree. Soft tier — never fail the run, just warn.

**Files:**
- Modify: `packages/harness/src/doctor.ts`
- Test: `packages/harness/src/doctor.test.ts`

- [ ] **Step 6.1: Write failing tests**

Append to `packages/harness/src/doctor.test.ts`:

```ts
describe("runDoctor — soft filesystem checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    writeFileSync(join(dir, "harness.config.json"), VALID_CONFIG_JSON);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("git-hook warns when .githooks/commit-msg is missing", async () => {
    const report = await runDoctor(dir);
    const hook = report.checks.find((c) => c.name === "git-hook");
    expect(hook?.tier).toBe("soft");
    expect(hook?.status).toBe("warn");
  });

  it("git-hook passes when .githooks/commit-msg exists and core.hooksPath is .githooks", async () => {
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(join(dir, ".githooks", "commit-msg"), "#!/bin/sh\n", { mode: 0o755 });
    execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: dir });
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "git-hook")?.status).toBe("pass");
  });

  it("gitignore-worktree warns when .gitignore does not cover worktreeDir", async () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "gitignore-worktree")?.status).toBe("warn");
  });

  it("gitignore-worktree passes when worktreeDir is covered", async () => {
    writeFileSync(join(dir, ".gitignore"), ".claude/worktrees/\n.claude/harness-logs/\n");
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "gitignore-worktree")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "gitignore-logs")?.status).toBe("pass");
  });
});
```

- [ ] **Step 6.2: Run the tests — confirm they fail**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts -t "soft filesystem"`
Expected: FAIL — these checks not yet emitted.

- [ ] **Step 6.3: Implement the three checks**

In `packages/harness/src/doctor.ts`, add before `SOFT_CHECKS`:

```ts
async function checkGitHook(ctx: DoctorContext): Promise<CheckResult> {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const hookPath = resolve(ctx.cwd, ".githooks", "commit-msg");
  if (!existsSync(hookPath)) {
    return {
      name: "git-hook",
      tier: "soft",
      status: "warn",
      message: ".githooks/commit-msg missing",
      hint: "re-run `init --with-hook`",
    };
  }
  // The hook will not fire unless core.hooksPath is set.
  let hooksPath: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["config", "--local", "--get", "core.hooksPath"],
      { cwd: ctx.cwd },
    );
    hooksPath = stdout.trim();
  } catch {
    // Key unset — git exits 1.
  }
  if (hooksPath !== ".githooks") {
    return {
      name: "git-hook",
      tier: "soft",
      status: "warn",
      message: `core.hooksPath is "${hooksPath ?? "(unset)"}" — hook will not fire`,
      hint: "git config --local core.hooksPath .githooks (or re-run `init --with-hook`)",
    };
  }
  return { name: "git-hook", tier: "soft", status: "pass" };
}

function makeGitignoreCheck(
  name: string,
  pickPath: (ctx: DoctorContext) => string | undefined,
  label: string,
): Check {
  const fn = async (ctx: DoctorContext): Promise<CheckResult> => {
    if (ctx.configState.kind !== "ok") {
      return { name, tier: "soft", status: "warn", message: "skipped: config unavailable" };
    }
    const target = pickPath(ctx);
    if (!target) {
      return { name, tier: "soft", status: "warn", message: `${label} not set in config` };
    }
    const { existsSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const gi = resolve(ctx.cwd, ".gitignore");
    if (!existsSync(gi)) {
      return {
        name,
        tier: "soft",
        status: "warn",
        message: ".gitignore not found",
        hint: `echo '${target}/' >> .gitignore`,
      };
    }
    const text = readFileSync(gi, "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Match any line that equals the target (with or without trailing slash).
    const normalized = target.replace(/\/$/, "");
    const matched = lines.some(
      (l) => l === normalized || l === `${normalized}/` || l === `/${normalized}` || l === `/${normalized}/`,
    );
    if (!matched) {
      return {
        name,
        tier: "soft",
        status: "warn",
        message: `${target} not in .gitignore`,
        hint: `echo '${target}/' >> .gitignore`,
      };
    }
    return { name, tier: "soft", status: "pass" };
  };
  Object.defineProperty(fn, "name", { value: name.replace(/-/g, "_") });
  return fn;
}
```

Update `SOFT_CHECKS`:

```ts
const SOFT_CHECKS: Check[] = [
  checkGitHook,
  makeGitignoreCheck(
    "gitignore-worktree",
    (ctx) => (ctx.configState.kind === "ok" ? ctx.configState.config.worktreeDir : undefined),
    "worktreeDir",
  ),
  makeGitignoreCheck(
    "gitignore-logs",
    (ctx) => (ctx.configState.kind === "ok" ? ctx.configState.config.logDir : undefined),
    "logDir",
  ),
];
```

- [ ] **Step 6.4: Run the tests — confirm they pass**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6.5: Commit**

```bash
git add packages/harness/src/doctor.ts packages/harness/src/doctor.test.ts
git commit -m "feat(harness): doctor — add git-hook + gitignore soft checks"
```

---

## Task 7: Soft environment/plugin checks — `claude-on-path`, `plugin-installed`, `superpowers-installed`, `version-drift`

Best-effort plugin detection plus a CLI/version sanity sweep. All four are soft.

**Files:**
- Modify: `packages/harness/src/doctor.ts`
- Test: `packages/harness/src/doctor.test.ts`

- [ ] **Step 7.1: Write failing tests**

Append to `packages/harness/src/doctor.test.ts`:

```ts
describe("runDoctor — soft env/plugin checks", () => {
  it("emits each soft env/plugin check with a well-formed result", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      for (const name of [
        "claude-on-path",
        "plugin-installed",
        "superpowers-installed",
      ]) {
        const c = report.checks.find((c) => c.name === name);
        expect(c).toBeDefined();
        expect(c?.tier).toBe("soft");
        expect(["pass", "warn"]).toContain(c?.status);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("version-drift is omitted when no local install exists", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const drift = report.checks.find((c) => c.name === "version-drift");
      expect(drift).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("version-drift warns on mismatch and passes on match", async () => {
    const dir = makeTempDir();
    try {
      // Fake a local install: cwd/node_modules/@baton-tools/harness/package.json
      const local = join(dir, "node_modules", "@baton-tools", "harness");
      mkdirSync(local, { recursive: true });
      writeFileSync(
        join(local, "package.json"),
        JSON.stringify({ name: "@baton-tools/harness", version: "9.9.9" }),
      );
      // Fake a SKILL.md pinning a different version.
      const skillsDir = join(local, "plugin", "skills", "autonomous-harness");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, "SKILL.md"),
        "Run `npx -y -p @baton-tools/harness@1.0.0 baton-harness status <story>`.\n",
      );
      const report = await runDoctor(dir);
      const drift = report.checks.find((c) => c.name === "version-drift");
      expect(drift?.tier).toBe("soft");
      expect(drift?.status).toBe("warn");
      expect(drift?.message).toMatch(/9\.9\.9.*1\.0\.0|1\.0\.0.*9\.9\.9/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 7.2: Run the tests — confirm they fail**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts -t "soft env/plugin"`
Expected: FAIL — these checks not yet emitted.

- [ ] **Step 7.3: Implement the four checks**

In `packages/harness/src/doctor.ts`, add before `SOFT_CHECKS`:

```ts
async function checkClaudeOnPath(_ctx: DoctorContext): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 5_000 });
    return {
      name: "claude-on-path",
      tier: "soft",
      status: "pass",
      message: stdout.trim().split("\n")[0],
    };
  } catch {
    return {
      name: "claude-on-path",
      tier: "soft",
      status: "warn",
      message: "claude CLI not found on PATH",
      hint: "install Claude Code (https://claude.com/claude-code)",
    };
  }
}

async function findPluginUnder(root: string, pluginName: string): Promise<string | null> {
  // Best-effort: walk a small subtree under ~/.claude/plugins/ looking for a
  // plugin.json whose `name` matches. Layout has changed across Claude Code
  // versions; we tolerate up to 4 levels of nesting.
  const { existsSync, readdirSync, statSync, readFileSync } = await import("node:fs");
  const { join: pjoin } = await import("node:path");
  if (!existsSync(root)) return null;
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }
    if (entries.includes("plugin.json")) {
      try {
        const json = JSON.parse(readFileSync(pjoin(path, "plugin.json"), "utf8")) as {
          name?: string;
        };
        if (json.name === pluginName) return path;
      } catch {
        // ignore
      }
    }
    if (depth < 4) {
      for (const name of entries) {
        const child = pjoin(path, name);
        try {
          if (statSync(child).isDirectory()) queue.push({ path: child, depth: depth + 1 });
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

async function checkPluginInstalled(_ctx: DoctorContext): Promise<CheckResult> {
  const { homedir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const root = pjoin(homedir(), ".claude", "plugins");
  if (!existsSync(root)) {
    return {
      name: "plugin-installed",
      tier: "soft",
      status: "warn",
      message: `could not introspect ${root}`,
      hint: "/plugin install baton-harness@baton",
    };
  }
  const found = await findPluginUnder(root, "baton-harness");
  if (found) {
    return { name: "plugin-installed", tier: "soft", status: "pass", message: found };
  }
  return {
    name: "plugin-installed",
    tier: "soft",
    status: "warn",
    message: `baton-harness plugin not found under ${root}`,
    hint: "/plugin install baton-harness@baton",
  };
}

async function checkSuperpowersInstalled(_ctx: DoctorContext): Promise<CheckResult> {
  const { homedir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const root = pjoin(homedir(), ".claude", "plugins");
  if (!existsSync(root)) {
    return {
      name: "superpowers-installed",
      tier: "soft",
      status: "warn",
      message: `could not introspect ${root}`,
    };
  }
  const found = await findPluginUnder(root, "superpowers");
  if (found) {
    return { name: "superpowers-installed", tier: "soft", status: "pass", message: found };
  }
  return {
    name: "superpowers-installed",
    tier: "soft",
    status: "warn",
    message: "superpowers plugin not detected",
  };
}

async function checkVersionDrift(ctx: DoctorContext): Promise<CheckResult | null> {
  // Returns null when no local install — caller filters nulls out.
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const localPkgPath = resolve(
    ctx.cwd,
    "node_modules",
    "@baton-tools",
    "harness",
    "package.json",
  );
  if (!existsSync(localPkgPath)) return null;

  let installedVersion: string;
  try {
    installedVersion = (JSON.parse(readFileSync(localPkgPath, "utf8")) as { version: string })
      .version;
  } catch {
    return {
      name: "version-drift",
      tier: "soft",
      status: "warn",
      message: "could not read local @baton-tools/harness package.json",
    };
  }

  // Read the pinned version from the plugin's SKILL.md.
  const skillPath = resolve(
    ctx.cwd,
    "node_modules",
    "@baton-tools",
    "harness",
    "plugin",
    "skills",
    "autonomous-harness",
    "SKILL.md",
  );
  if (!existsSync(skillPath)) {
    return {
      name: "version-drift",
      tier: "soft",
      status: "warn",
      message: `local install at ${installedVersion}, plugin SKILL.md not found — cannot compare`,
    };
  }
  const skill = readFileSync(skillPath, "utf8");
  const match = skill.match(/@baton-tools\/harness@([0-9]+\.[0-9]+\.[0-9]+[^ )]*)/);
  if (!match) {
    return {
      name: "version-drift",
      tier: "soft",
      status: "warn",
      message: `local install at ${installedVersion}, could not parse pinned version from SKILL.md`,
    };
  }
  const pinned = match[1];
  if (pinned === installedVersion) {
    return {
      name: "version-drift",
      tier: "soft",
      status: "pass",
      message: `${installedVersion} matches plugin pin`,
    };
  }
  return {
    name: "version-drift",
    tier: "soft",
    status: "warn",
    message: `installed ${installedVersion} vs plugin pin ${pinned}`,
    hint: `npm i -D @baton-tools/harness@${pinned} or /plugin update baton-harness`,
  };
}
```

Update `SOFT_CHECKS`:

```ts
const SOFT_CHECKS: Check[] = [
  checkGitHook,
  makeGitignoreCheck(
    "gitignore-worktree",
    (ctx) => (ctx.configState.kind === "ok" ? ctx.configState.config.worktreeDir : undefined),
    "worktreeDir",
  ),
  makeGitignoreCheck(
    "gitignore-logs",
    (ctx) => (ctx.configState.kind === "ok" ? ctx.configState.config.logDir : undefined),
    "logDir",
  ),
  checkClaudeOnPath,
  checkPluginInstalled,
  checkSuperpowersInstalled,
];
```

`version-drift` is special — it may return `null`. Update `runDoctor` to handle that:

Replace the orchestrator block with:

```ts
export async function runDoctor(
  cwd: string,
  _opts: RunDoctorOptions = {},
): Promise<DoctorReport> {
  const ctx = await buildContext(cwd);
  const checks: CheckResult[] = [];
  for (const check of [...HARD_CHECKS, ...SOFT_CHECKS]) {
    checks.push(await runOne(check, ctx));
  }
  // version-drift is conditional — emit only when a local install exists.
  const drift = await checkVersionDrift(ctx).catch((err: unknown) => ({
    name: "version-drift",
    tier: "soft" as CheckTier,
    status: "warn" as CheckStatus,
    message: err instanceof Error ? err.message : String(err),
  }));
  if (drift) checks.push(drift);

  const summary = summarize(checks);
  const ok = !checks.some((c) => c.tier === "hard" && c.status === "fail");
  return { ok, cwd, summary, checks };
}
```

- [ ] **Step 7.4: Run the tests — confirm they pass**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS, all tests.

- [ ] **Step 7.5: Commit**

```bash
git add packages/harness/src/doctor.ts packages/harness/src/doctor.test.ts
git commit -m "feat(harness): doctor — add claude-on-path, plugin detection, version-drift soft checks"
```

---

## Task 8: Integration tests — healthy and broken scaffolds, JSON shape

Tie everything together with two integration tests that exercise the full orchestrator.

**Files:**
- Test: `packages/harness/src/doctor.test.ts`

- [ ] **Step 8.1: Write the integration tests**

Append to `packages/harness/src/doctor.test.ts`:

```ts
describe("runDoctor — integration", () => {
  it("healthy scaffold: every hard check passes", async () => {
    const dir = makeTempDir();
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });
      writeFileSync(join(dir, "harness.config.json"), VALID_CONFIG_JSON);
      mkdirSync(join(dir, "openspec"));
      writeFileSync(join(dir, ".gitignore"), ".claude/worktrees/\n.claude/harness-logs/\n");
      writeFileSync(join(dir, "openspec", "project.md"), "# Project\n");
      mkdirSync(join(dir, ".githooks"));
      writeFileSync(join(dir, ".githooks", "commit-msg"), "#!/bin/sh\n", { mode: 0o755 });
      execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: dir });

      // The config's verify.* commands all use `echo`, which is always on PATH.
      // Override to use `node` which is also always on PATH (echo is a builtin
      // on some shells and may not have a resolvable binary).
      const cfg = JSON.parse(VALID_CONFIG_JSON);
      cfg.verification = {
        lint: "node --version",
        typecheck: "node --version",
        unit: "node --version",
        e2e: "node --version",
      };
      writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));

      const report = await runDoctor(dir);
      const hardFails = report.checks.filter((c) => c.tier === "hard" && c.status === "fail");
      // openspec-cli may legitimately fail in CI if @fission-ai/openspec isn't
      // in the npx cache. Allow that single check to fail without breaking
      // the test (it's still a real signal in practice).
      const acceptableFails = hardFails.filter((c) => c.name !== "openspec-cli");
      expect(acceptableFails).toHaveLength(0);
      // Soft checks may legitimately warn (no Claude Code on CI hosts).
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("broken scaffold: expected hard fails, JSON shape is stable", async () => {
    const dir = makeTempDir();
    try {
      // Empty dir: no git, no config, no openspec.
      const report = await runDoctor(dir);
      const failNames = report.checks.filter((c) => c.status === "fail").map((c) => c.name);
      expect(failNames).toContain("git-repo");
      expect(failNames).toContain("config-present");
      expect(failNames).toContain("config-parses");
      expect(failNames).toContain("openspec-dir");
      expect(failNames).toContain("openspec-project-md");

      // JSON shape: every expected check name is present, exactly once.
      const json = JSON.parse(renderJson(report));
      const names = (json.checks as Array<{ name: string }>).map((c) => c.name);
      const expectedHard = [
        "git-repo",
        "node-version",
        "git-on-path",
        "config-present",
        "config-parses",
        "openspec-dir",
        "openspec-project-md",
        "openspec-cli",
        "verify-lint",
        "verify-typecheck",
        "verify-unit",
        "verify-e2e",
      ];
      const expectedSoft = [
        "git-hook",
        "gitignore-worktree",
        "gitignore-logs",
        "claude-on-path",
        "plugin-installed",
        "superpowers-installed",
      ];
      for (const name of [...expectedHard, ...expectedSoft]) {
        expect(names.filter((n) => n === name)).toHaveLength(1);
      }
      // version-drift not emitted (no local install in tmp dir).
      expect(names).not.toContain("version-drift");
      expect(report.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 8.2: Run all tests — confirm they pass**

Run: `cd packages/harness && pnpm exec vitest run src/doctor.test.ts`
Expected: PASS, all tests.

- [ ] **Step 8.3: Commit**

```bash
git add packages/harness/src/doctor.test.ts
git commit -m "test(harness): doctor — healthy + broken scaffold integration"
```

---

## Task 9: Public surface (index re-exports) + README CLI reference row

Last step: expose the engine for the workbench, document the command.

**Files:**
- Modify: `packages/harness/src/index.ts`
- Modify: `packages/harness/README.md`

- [ ] **Step 9.1: Re-export from `index.ts`**

Edit `packages/harness/src/index.ts`. Append:

```ts
export { runDoctor, renderHuman, renderJson } from "./doctor.js";
export type {
  CheckResult,
  CheckStatus,
  CheckTier,
  DoctorReport,
  RunDoctorOptions,
} from "./doctor.js";
```

- [ ] **Step 9.2: Verify the re-exports compile and the workbench could import them**

Run: `cd packages/harness && pnpm typecheck`
Expected: PASS.

Run: `cd packages/harness && pnpm build`
Expected: PASS. (Confirms `dist/index.d.ts` carries the new exports.)

- [ ] **Step 9.3: Add `doctor` row to the README CLI reference table**

Edit `packages/harness/README.md`. In the CLI reference table (search for `## CLI reference`), insert the row alphabetically:

```markdown
| `doctor [--json] [--cwd=<path>]`         | Verify the install: config, openspec scaffold, external CLIs, verify commands, optional Claude Code plugin/superpowers detection. Exit 1 on any hard failure. |
```

Place it right after the `diff` row.

- [ ] **Step 9.4: Update `help` output in `cli.ts`**

Edit `packages/harness/src/cli.ts`. In the `help` function (around line 224), add a line after the `diff` row in the help-text array:

```ts
"  doctor [--json] [--cwd=<path>]",
"                            verify the install: config, openspec, external CLIs, verify cmds",
```

- [ ] **Step 9.5: Smoke-test the help output**

Run: `cd packages/harness && node --import tsx ./src/cli.ts help | grep -A1 doctor`
Expected: the new `doctor` line appears.

- [ ] **Step 9.6: Run the full test suite to confirm nothing regressed**

Run: `cd packages/harness && pnpm test`
Expected: PASS, all tests across the package.

- [ ] **Step 9.7: Commit**

```bash
git add packages/harness/src/index.ts packages/harness/src/cli.ts packages/harness/README.md
git commit -m "feat(harness): doctor — public re-exports, help text, README row"
```

---

## Self-review checklist (for the implementer)

Before declaring the feature done, walk this list:

- [ ] **Spec coverage:** All 9 hard checks and 7 soft checks from the spec table exist in `HARD_CHECKS`/`SOFT_CHECKS` (or as the conditional `checkVersionDrift`).
- [ ] **JSON shape stable:** A broken scaffold produces every expected check name except `version-drift`. (Covered by Task 8.2.)
- [ ] **Exit codes:** `doctor` exits 0 on healthy, 1 on any hard fail, 2 on unknown args. Verify by running the CLI against a tmp dir.
- [ ] **No `process.chdir()`** anywhere in `doctor.ts` or the tests. The cwd flows through `DoctorContext`.
- [ ] **No new runtime deps:** `package.json` deps unchanged. Confirm with `git diff packages/harness/package.json`.
- [ ] **Workbench-ready surface:** `dist/index.d.ts` exposes `runDoctor`, `DoctorReport`, `CheckResult`. Confirm with `grep -E "runDoctor|DoctorReport|CheckResult" packages/harness/dist/index.d.ts`.
