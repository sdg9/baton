import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function createWorktree(
  worktreeDir: string,
  branchPrefix: string,
  storyName: string,
  baseBranch: string,
): Promise<{ path: string; branch: string }> {
  const branch = `${branchPrefix}${storyName}`;
  const path = resolve(worktreeDir, storyName);
  await mkdir(worktreeDir, { recursive: true });

  if (existsSync(path)) {
    throw new Error(`Worktree already exists at ${path}. Remove it first.`);
  }

  await exec("git", ["fetch", "origin", baseBranch]).catch(() => {});
  await exec("git", ["worktree", "add", "-b", branch, path, baseBranch]);

  // Symlink node_modules from the parent checkout so verify-all gates work
  // immediately. Without this, `tsx`/`vitest`/etc. resolve to nothing and
  // CLI-spawning tests fail with phantom "module not found" errors.
  // Tradeoff: stories that change package.json deps will need a manual
  // `rm node_modules && npm install` inside the worktree.
  const repoRoot = process.cwd();
  const parentNodeModules = resolve(repoRoot, "node_modules");
  const worktreeNodeModules = join(path, "node_modules");
  if (existsSync(parentNodeModules) && !existsSync(worktreeNodeModules)) {
    await symlink(parentNodeModules, worktreeNodeModules, "dir").catch(() => {});
  }

  // `git worktree add` only materializes tracked files. Approved story folders
  // are sometimes authored locally before their specs/tasks are committed, so
  // carry just that story-local untracked content into the worktree.
  const storyDirRel = join("openspec", "changes", storyName);
  const { stdout: untrackedStoryFiles } = await exec(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", storyDirRel],
    { cwd: repoRoot },
  );
  for (const rel of untrackedStoryFiles.split("\n").filter(Boolean)) {
    const source = join(repoRoot, rel);
    const target = join(path, rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  return { path, branch };
}

export async function removeWorktree(path: string): Promise<void> {
  await exec("git", ["worktree", "remove", "--force", path]).catch(() => {});
}

export async function getDiff(cwd: string, baseBranch: string): Promise<string> {
  const { stdout } = await exec("git", ["diff", `${baseBranch}...HEAD`], {
    cwd,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

export async function getChangedFiles(cwd: string, baseBranch: string): Promise<string[]> {
  const { stdout } = await exec("git", ["diff", "--name-only", `${baseBranch}...HEAD`], { cwd });
  return stdout.split("\n").filter(Boolean);
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await exec("git", ["add", "-A"], { cwd });
  await exec("git", ["commit", "-m", message], { cwd });
}

export async function hasChanges(cwd: string): Promise<boolean> {
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd });
  return stdout.trim().length > 0;
}

export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return stdout.trim();
}

/**
 * Refuse to proceed if the main repo working tree has uncommitted changes.
 * Story sessions run in a separate worktree and must never leave dirty state
 * on the main checkout. Past incident: a session ran `git stash pop` against
 * main as a baseline-comparison hack, abandoned the conflict markers, and
 * main sat dirty for ~10 hours. Called at story boundaries (worktree-create,
 * result) so the next session refuses to start until the previous mess is
 * cleaned up.
 */
export async function assertMainClean(mainRepoRoot: string): Promise<void> {
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: mainRepoRoot });
  const dirty = stdout.trim();
  if (!dirty) return;

  const lines = dirty.split("\n");
  const fileList = lines.slice(0, 20).join("\n");
  const truncated = lines.length > 20 ? `\n  ... (${lines.length - 20} more)` : "";

  let conflictHint = "";
  try {
    const { stdout: diff } = await exec("git", ["diff", "--no-color", "-U0"], {
      cwd: mainRepoRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (/^<<<<<<< |^=======$|^>>>>>>> /m.test(diff)) {
      conflictHint =
        "\n\nUnresolved merge-conflict markers detected — likely a botched `git stash pop` or merge.";
    }
  } catch {
    /* best-effort hint only */
  }

  throw new Error(
    `main has uncommitted changes — story sessions must not leave main dirty.\n${fileList}${truncated}${conflictHint}\n\nResolve before continuing (commit intentional main-side work, or \`git restore --source=HEAD --worktree -- .\` to discard).`,
  );
}
