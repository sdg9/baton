/**
 * Path resolution for `holdout-validate`.
 *
 * `repo` scope: every tracked file matching `holdoutPaths` (the existing,
 * pre-`--scope` behavior).
 *
 * `story` scope: the intersection of (tracked files matching `holdoutPaths`)
 * with (files added or modified on the current branch relative to
 * `baseBranch`, computed via `git diff --name-only --diff-filter=AMR
 * <baseBranch>...HEAD`). This filters out legacy violations on holdout files
 * unchanged by the story branch — the story owns only the diff it produced.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ResolveHoldoutPathsOpts {
  /** Working directory to run `git` from (worktree or repo root). */
  cwd: string;
  /** Glob patterns from `config.holdouts.paths`. */
  holdoutPaths: readonly string[];
  /** `repo` or `story`. */
  scope: "repo" | "story";
  /** Configured base branch (`config.git.baseBranch`). Required for `story`. */
  baseBranch: string;
}

/**
 * Returns absolute paths to holdout files to validate, deduplicated.
 *
 * For `story` scope, returns an empty array if the branch's diff against
 * `baseBranch` contains no files matching any glob in `holdoutPaths`. The
 * caller is responsible for treating the empty result as a pass.
 */
export async function resolveHoldoutPaths(opts: ResolveHoldoutPathsOpts): Promise<string[]> {
  const { cwd, holdoutPaths, scope, baseBranch } = opts;

  // Enumerate all tracked files matching the holdout globs (repo-relative).
  const tracked = new Set<string>();
  for (const pat of holdoutPaths) {
    try {
      const { stdout } = await exec("git", ["ls-files", "--", pat], { cwd });
      for (const rel of stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        tracked.add(rel);
      }
    } catch {
      /* ignore — pattern with no matches yields a non-fatal empty list */
    }
  }

  if (scope === "repo") {
    return absPaths(cwd, [...tracked]);
  }

  // story scope: intersect with branch-modified files.
  const changed = await listBranchChanges(cwd, baseBranch);
  const intersect = [...tracked].filter((p) => changed.has(p));
  return absPaths(cwd, intersect);
}

function absPaths(cwd: string, rel: readonly string[]): string[] {
  return rel.map((p) => join(cwd, p));
}

/**
 * Repo-relative paths added/modified/renamed on the current branch relative to
 * `baseBranch`, via `git diff --name-only --diff-filter=AMR <base>...HEAD`.
 *
 * Three-dot form: includes commits reachable from HEAD but not from base —
 * i.e. work done on the story branch since divergence, not files that drifted
 * on base afterward.
 *
 * Returns an empty set if the diff fails (e.g. base branch unknown in this
 * worktree). Caller treats empty as "no story-scoped holdouts," not as an
 * error — the validator is a defense-in-depth gate, not the only line.
 */
async function listBranchChanges(cwd: string, baseBranch: string): Promise<Set<string>> {
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "--name-only", "--diff-filter=AMR", `${baseBranch}...HEAD`],
      { cwd },
    );
    return new Set(
      stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}
