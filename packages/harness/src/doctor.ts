import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HarnessConfig } from "./types.js";
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

const HARD_CHECKS: Check[] = [
  checkGitRepo,
  checkNodeVersion,
  checkGitOnPath,
  checkConfigPresent,
  checkConfigParses,
];
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
