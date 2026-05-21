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
