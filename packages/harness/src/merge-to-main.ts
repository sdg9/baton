/**
 * mergeToMain — merge a story branch into the configured base branch with:
 * - dirty-tree check
 * - currently-on-base-branch check
 * - --no-ff merge
 * - allow-listed conflict auto-resolution (root-level filenames only)
 * - post-merge verify-all (rollback on failure)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FullVerificationTriggers, StoryTier, TierScopeRules } from "./types.js";

const exec = promisify(execFile);

export interface GuardrailResult {
  ok: boolean;
  offendingPaths: string[];
  reason?: string;
}

const DEFAULT_FULL_VERIFICATION: Required<FullVerificationTriggers> = {
  exactPaths: ["harness.config.ts", "package.json", "package-lock.json", "tsconfig.json"],
  prefixes: [],
};

/**
 * Tier/diff-scope guardrail. Returns `ok: true` if the diff scope is
 * compatible with the tier; otherwise returns the offending paths and a
 * reason. Rules come from `harness.config.ts` (`tierScopeRules`). When no
 * rules are configured the guardrail is a no-op (always ok). `primitives` is
 * never restricted.
 */
export function checkDiffScope(
  tier: StoryTier,
  diffPaths: readonly string[],
  rules?: TierScopeRules,
): GuardrailResult {
  if (tier === "primitives" || !rules) {
    return { ok: true, offendingPaths: [] };
  }
  const rule = tier === "content" ? rules.content : rules.infra;
  if (!rule || rule.forbiddenPrefixes.length === 0) {
    return { ok: true, offendingPaths: [] };
  }
  const offending = diffPaths.filter((p) =>
    rule.forbiddenPrefixes.some((pre) => p.startsWith(pre)),
  );
  if (offending.length === 0) {
    return { ok: true, offendingPaths: [] };
  }
  const list = rule.forbiddenPrefixes.map((p) => `\`${p}\``).join(", ");
  return {
    ok: false,
    offendingPaths: offending,
    reason: `\`${tier}\`-tier stories MUST NOT modify files under ${list}. Re-tag the proposal (likely \`primitives\`) or split the story.`,
  };
}

/**
 * Whether the diff touches paths that force `verify-all --full` even when
 * `--fast` was requested. Holdout files (`*.holdout.test.*`, `*.holdout.spec.*`)
 * always trigger full verification.
 */
export function requiresFullVerification(
  diffPaths: readonly string[],
  triggers: FullVerificationTriggers = DEFAULT_FULL_VERIFICATION,
): boolean {
  const exact = new Set(triggers.exactPaths ?? DEFAULT_FULL_VERIFICATION.exactPaths);
  const prefixes = triggers.prefixes ?? DEFAULT_FULL_VERIFICATION.prefixes;
  return diffPaths.some((path) => {
    if (exact.has(path)) return true;
    if (prefixes.some((prefix) => path.startsWith(prefix))) return true;
    return /\.holdout\.(test|spec)\.[mc]?[tj]sx?$/.test(path);
  });
}

const ALLOW_LISTED = new Set([
  "diff-summaries.json",
  "review-summary.json",
  "HARNESS_RESULT.md",
  "holdout-validation.json",
]);

export interface MergeToMainOpts {
  story: string;
  repoRoot: string;
  runVerifyAll: () => Promise<{ success: boolean; failedGates: string[] }>;
  /** Base branch to merge into (e.g. "main"). */
  baseBranch: string;
  /** Story branch name (already prefixed, e.g. "story/<name>"). */
  branch: string;
  /**
   * Optional tier for the diff-scope guardrail. When provided alongside
   * `tierScopeRules`, the merge inspects the diff vs base and aborts if the
   * scope is incompatible. Omit either to disable the check.
   */
  tier?: StoryTier;
  tierScopeRules?: TierScopeRules;
}

export interface MergeToMainResult {
  success: boolean;
  preMergeSha?: string;
  postMergeSha?: string;
  conflicts?: string[];
  failedGates?: string[];
  reason?: string;
  /** Paths that violated the tier scope guardrail (when applicable). */
  scopeViolations?: string[];
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

/**
 * Returns a list of conflicting file paths after a failed merge, using
 * `git diff --name-only --diff-filter=U`.
 */
async function getConflictingPaths(cwd: string): Promise<string[]> {
  try {
    const out = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * All conflicts must be in ALLOW_LISTED (root-level name only — no path
 * separators may appear in the string, so `subdir/diff-summaries.json`
 * would NOT be allow-listed).
 */
function allConflictsAllowListed(paths: string[]): boolean {
  return paths.every((p) => !p.includes("/") && ALLOW_LISTED.has(p));
}

export async function mergeToMain(opts: MergeToMainOpts): Promise<MergeToMainResult> {
  const { repoRoot, runVerifyAll, tier, tierScopeRules, baseBranch, branch } = opts;

  // 1. Clean working tree check.
  let statusOut: string;
  try {
    statusOut = await git(["status", "--porcelain"], repoRoot);
  } catch (err) {
    return { success: false, reason: `git status failed: ${String(err)}` };
  }
  if (statusOut.length > 0) {
    return { success: false, reason: "working tree is dirty" };
  }

  // 2. Must be on the configured base branch.
  let currentBranch: string;
  try {
    currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  } catch {
    currentBranch = "";
  }
  if (currentBranch !== baseBranch) {
    return { success: false, reason: `not on ${baseBranch} (currently on ${currentBranch})` };
  }

  // 2.5. Tier/diff-scope guardrail (before merge mutates anything).
  if (tier !== undefined && tierScopeRules) {
    let diffOut = "";
    try {
      diffOut = await git(["diff", "--name-only", `${baseBranch}...${branch}`], repoRoot);
    } catch (err) {
      return { success: false, reason: `git diff failed: ${String(err)}` };
    }
    const diffPaths = diffOut
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const guard = checkDiffScope(tier, diffPaths, tierScopeRules);
    if (!guard.ok) {
      return {
        success: false,
        reason: guard.reason,
        scopeViolations: guard.offendingPaths,
      };
    }
  }

  // 3. Record pre-merge SHA.
  const preMergeSha = await git(["rev-parse", "HEAD"], repoRoot);

  // 4. Attempt merge --no-ff.
  try {
    await exec("git", ["merge", "--no-ff", branch, "-m", `Merge branch '${branch}'`], {
      cwd: repoRoot,
    });
  } catch {
    // Merge conflict — inspect which files.
    const conflicts = await getConflictingPaths(repoRoot);

    if (conflicts.length === 0) {
      // Some other error — abort.
      try {
        await exec("git", ["merge", "--abort"], { cwd: repoRoot });
      } catch {
        /* ignore */
      }
      return { success: false, reason: "merge failed (no conflict paths found)", conflicts: [] };
    }

    if (!allConflictsAllowListed(conflicts)) {
      // Non-allow-listed conflict — abort.
      try {
        await exec("git", ["merge", "--abort"], { cwd: repoRoot });
      } catch {
        /* ignore */
      }
      return { success: false, conflicts, reason: "non-allow-listed conflicts" };
    }

    // All conflicts allow-listed — auto-resolve to "theirs" (the story branch version).
    for (const filePath of conflicts) {
      try {
        await exec("git", ["checkout", "--theirs", filePath], { cwd: repoRoot });
        await exec("git", ["add", filePath], { cwd: repoRoot });
      } catch (err) {
        try {
          await exec("git", ["merge", "--abort"], { cwd: repoRoot });
        } catch {
          /* ignore */
        }
        return {
          success: false,
          conflicts,
          reason: `failed to auto-resolve ${filePath}: ${String(err)}`,
        };
      }
    }

    // Commit the auto-resolved merge.
    try {
      await exec("git", ["commit", "--no-edit"], { cwd: repoRoot });
    } catch (err) {
      try {
        await exec("git", ["merge", "--abort"], { cwd: repoRoot });
      } catch {
        /* ignore */
      }
      return {
        success: false,
        conflicts,
        reason: `commit after conflict resolution failed: ${String(err)}`,
      };
    }

    const postMergeSha = await git(["rev-parse", "HEAD"], repoRoot);

    // Run verify-all.
    const verifyResult = await runVerifyAll();
    if (!verifyResult.success) {
      // Rollback.
      await exec("git", ["reset", "--hard", preMergeSha], { cwd: repoRoot });
      return {
        success: false,
        preMergeSha,
        conflicts,
        failedGates: verifyResult.failedGates,
        reason: "verify-all failed after conflict-resolved merge",
      };
    }

    return { success: true, preMergeSha, postMergeSha, conflicts };
  }

  // Clean merge succeeded.
  const postMergeSha = await git(["rev-parse", "HEAD"], repoRoot);

  // Run verify-all.
  const verifyResult = await runVerifyAll();
  if (!verifyResult.success) {
    await exec("git", ["reset", "--hard", preMergeSha], { cwd: repoRoot });
    return {
      success: false,
      preMergeSha,
      failedGates: verifyResult.failedGates,
      reason: "verify-all failed after merge",
    };
  }

  return { success: true, preMergeSha, postMergeSha, conflicts: [] };
}
