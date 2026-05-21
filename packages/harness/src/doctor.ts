import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HarnessConfig, VerificationKind } from "./types.js";
import { HarnessConfigError } from "./types.js";

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
      const parsed = JSON.parse(text) as {
        name?: string;
        engines?: { node?: string };
      };
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

async function checkOpenspecDir(ctx: DoctorContext): Promise<CheckResult> {
  const gate = requireConfig("openspec-dir", ctx);
  if ("skip" in gate) return gate.skip;
  const { config } = gate;
  const { existsSync, statSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const dir = resolve(ctx.cwd, config.openspecDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return {
      name: "openspec-dir",
      tier: "hard",
      status: "fail",
      message: `${config.openspecDir}/ not found`,
      hint: "run `npx -y @baton-tools/harness init`",
    };
  }
  return {
    name: "openspec-dir",
    tier: "hard",
    status: "pass",
    message: config.openspecDir,
  };
}

async function checkOpenspecProjectMd(ctx: DoctorContext): Promise<CheckResult> {
  const gate = requireConfig("openspec-project-md", ctx);
  if ("skip" in gate) return gate.skip;
  const { config } = gate;
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const path = resolve(ctx.cwd, config.openspecDir, "project.md");
  if (!existsSync(path)) {
    return {
      name: "openspec-project-md",
      tier: "hard",
      status: "fail",
      message: `${config.openspecDir}/project.md not found`,
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

function makeVerifyCheck(kind: VerificationKind): Check {
  const name = `verify-${kind}`;
  const fn = async (ctx: DoctorContext): Promise<CheckResult> => {
    const gate = requireConfig(name, ctx);
    if ("skip" in gate) return gate.skip;
    const { config } = gate;
    const cmd = config.verification?.[kind];
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
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
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
  const { resolve, dirname } = await import("node:path");

  // 1. Absolute or cwd-relative path with separators — accept if executable.
  if (token.includes("/") || token.includes("\\")) {
    const abs = resolve(cwd, token);
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
    return null;
  }

  // 2. Walk up from cwd looking for node_modules/.bin/<token>. Handles pnpm/
  //    Yarn workspaces where binaries are hoisted to the repo root.
  let dir = resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const local = resolve(dir, "node_modules", ".bin", token);
    if (existsSync(local)) return local;
    if (existsSync(`${local}.cmd`)) return `${local}.cmd`;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

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

/**
 * Gate for config-dependent checks. Returns a skip CheckResult when config
 * isn't `ok` so the caller can early-return; otherwise returns the cached
 * HarnessConfig for the check to use.
 *
 * The skip message is the stable JSON contract "skipped: config unavailable" —
 * do not change it without updating the workbench consumer.
 */
function requireConfig(
  name: string,
  ctx: DoctorContext,
): { skip: CheckResult } | { config: HarnessConfig } {
  if (ctx.configState.kind !== "ok") {
    return {
      skip: { name, tier: "hard", status: "fail", message: "skipped: config unavailable" },
    };
  }
  return { config: ctx.configState.config };
}

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
