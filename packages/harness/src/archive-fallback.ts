/**
 * Post-condition guard for `openspec archive <story>`.
 *
 * `npx @fission-ai/openspec archive` has been observed to exit 0 without
 * moving the change folder (silent no-op). Three stories shipped fully but their proposal
 * folders stayed under `openspec/changes/<story>/` with the `approved`
 * sentinel intact, making them look approved-but-unstarted on next read.
 *
 * `ensureChangeArchived` runs after the openspec CLI returns and verifies
 * the post-condition: the change folder is gone from `openspec/changes/`.
 * If it is still there, we fall back to a manual `git mv` into
 * `openspec/changes/archive/<YYYY-MM-DD>-<story>/`.
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

type ExecFn = (
  file: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export interface EnsureChangeArchivedOptions {
  readonly story: string;
  readonly openspecDir: string;
  readonly cwd: string;
  readonly exec: ExecFn;
  /** Injected for tests. Returns YYYY-MM-DD. */
  readonly today?: () => string;
  /** Injected for tests. Defaults to console.warn. */
  readonly warn?: (msg: string) => void;
}

export interface EnsureChangeArchivedResult {
  readonly status: "openspec-moved" | "fallback-moved";
  readonly archivedPath?: string;
}

export interface CleanupPostArchiveSourceOptions {
  readonly story: string;
  readonly openspecDir: string;
  readonly cwd: string;
  readonly exec: ExecFn;
}

export interface CleanupPostArchiveSourceResult {
  readonly status: "absent" | "cleaned";
  readonly path: string;
}

export async function ensureChangeArchived(
  opts: EnsureChangeArchivedOptions,
): Promise<EnsureChangeArchivedResult> {
  const { story, openspecDir, cwd, exec } = opts;
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  const warn = opts.warn ?? ((msg) => console.warn(msg));

  const changeDirRel = join(openspecDir, "changes", story);
  const changeDirAbs = join(cwd, changeDirRel);

  if (!existsSync(changeDirAbs)) {
    return { status: "openspec-moved" };
  }

  const archivedRel = join(openspecDir, "changes", "archive", `${today()}-${story}`);
  const archivedAbs = join(cwd, archivedRel);

  if (existsSync(archivedAbs)) {
    throw new Error(
      `archive fallback for ${story}: target ${archivedRel} already exists, ` +
        `but ${changeDirRel} is also still present. Resolve by hand.`,
    );
  }

  warn(
    `[WARN] openspec archive ${story} exited 0 but did not move the change folder. ` +
      `Falling back: git mv ${changeDirRel} ${archivedRel}`,
  );
  // git mv requires the destination's parent directory to exist. In production
  // openspec/changes/archive/ always has prior entries, but a fresh repo (or
  // a test fixture) may not.
  await mkdir(join(cwd, dirname(archivedRel)), { recursive: true });
  await exec("git", ["mv", changeDirRel, archivedRel], { cwd });

  return { status: "fallback-moved", archivedPath: archivedRel };
}

export async function cleanupPostArchiveSourceFolder(
  opts: CleanupPostArchiveSourceOptions,
): Promise<CleanupPostArchiveSourceResult> {
  const changeDirRel = join(opts.openspecDir, "changes", opts.story);
  const changeDirAbs = join(opts.cwd, changeDirRel);

  if (!existsSync(changeDirAbs)) {
    return { status: "absent", path: changeDirRel };
  }

  const { stdout } = await opts.exec("git", ["ls-files", "--", changeDirRel], {
    cwd: opts.cwd,
  });
  if (stdout.trim().length > 0) {
    throw new Error(
      `post-archive source folder ${changeDirRel} still contains tracked files; ` +
        "archive is half-applied and needs manual resolution.",
    );
  }

  await rm(changeDirAbs, { recursive: true, force: true });
  return { status: "cleaned", path: changeDirRel };
}
