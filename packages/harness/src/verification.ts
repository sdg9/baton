import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { HarnessConfig, VerificationKind, VerificationResult } from "./types.js";

export interface VerificationOptions {
  /**
   * Run the full unit suite (`verification.unitFull`) instead of the
   * fast per-gate command. Used at merge time so slow CLI-integration
   * tests still gate before code lands on main. Falls back to `unit`
   * when `unitFull` is unset.
   */
  full?: boolean;
}

export async function runVerification(
  kind: VerificationKind,
  config: HarnessConfig,
  cwd: string,
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  const command =
    kind === "unit" && options.full && config.verification.unitFull
      ? config.verification.unitFull
      : config.verification[kind];
  const started = performance.now();
  const result = await execCapture(command, cwd);
  const durationMs = performance.now() - started;
  return {
    kind,
    passed: result.exitCode === 0,
    durationMs,
    output: result.output,
    exitCode: result.exitCode,
  };
}

export async function runAllVerifications(
  config: HarnessConfig,
  cwd: string,
  options: VerificationOptions = {},
): Promise<VerificationResult[]> {
  const kinds: VerificationKind[] = ["lint", "typecheck", "unit", "e2e"];
  const results: VerificationResult[] = [];
  for (const kind of kinds) {
    results.push(await runVerification(kind, config, cwd, options));
  }
  return results;
}

function execCapture(
  command: string,
  cwd: string,
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d.toString();
    });
    child.stderr.on("data", (d) => {
      output += d.toString();
    });
    child.on("close", (exitCode) => resolve({ output, exitCode }));
    child.on("error", (err) => resolve({ output: `${output}\n${err.message}`, exitCode: 1 }));
  });
}
