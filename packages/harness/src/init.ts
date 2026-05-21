// `baton-harness init` — scaffold a consuming repo.
//
// Copies templates/ into the current working directory so the consumer can
// edit a harness.config.ts, an openspec/ skeleton, and the commit-msg
// pre-commit hook without copy-paste boilerplate. Idempotent: skips files
// that already exist unless --force is passed.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * `dist/init.js` ships inside the published package; templates live one
 * level up from `dist/`. When invoked from source via tsx the layout is the
 * same (`src/init.ts` → repo root → `templates/`).
 */
function locateTemplatesDir(): string {
  const fromDist = resolve(__dirname, "..", "templates");
  if (existsSync(fromDist)) return fromDist;
  // Fallback: walk up looking for `templates/`. Useful in dev / monorepo.
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "templates");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("baton-harness init: could not locate templates/ directory");
}

async function copyRecursive(src: string, dest: string, force: boolean): Promise<string[]> {
  const written: string[] = [];
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      written.push(...(await copyRecursive(srcPath, destPath, force)));
    } else if (entry.isFile()) {
      if (existsSync(destPath) && !force) {
        process.stdout.write(`  [skip] ${relative(process.cwd(), destPath)} (already exists)\n`);
        continue;
      }
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      written.push(destPath);
      process.stdout.write(`  [write] ${relative(process.cwd(), destPath)}\n`);
    }
  }
  return written;
}

export async function init(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const cwd = process.cwd();
  const templatesDir = locateTemplatesDir();

  process.stdout.write(`Initializing baton-harness in ${cwd}\n`);
  process.stdout.write(`(templates from ${templatesDir})\n\n`);

  // 1. Drop harness.config.ts at the repo root (if missing).
  const configSrc = join(templatesDir, "harness.config.ts");
  const configDest = join(cwd, "harness.config.ts");
  if (existsSync(configDest) && !force) {
    process.stdout.write(`  [skip] harness.config.ts (already exists)\n`);
  } else {
    await copyFile(configSrc, configDest);
    process.stdout.write(`  [write] harness.config.ts\n`);
  }

  // 2. Scaffold openspec/ if missing.
  const openspecSrc = join(templatesDir, "openspec");
  const openspecDest = join(cwd, "openspec");
  await mkdir(openspecDest, { recursive: true });
  await copyRecursive(openspecSrc, openspecDest, force);
  await mkdir(join(openspecDest, "changes"), { recursive: true });

  // 3. .husky/commit-msg hook (only if .husky exists OR --with-husky).
  const huskyDir = join(cwd, ".husky");
  if (existsSync(huskyDir) || args.includes("--with-husky")) {
    await mkdir(huskyDir, { recursive: true });
    const hookSrc = join(templatesDir, ".husky", "commit-msg");
    const hookDest = join(huskyDir, "commit-msg");
    if (existsSync(hookDest) && !force) {
      process.stdout.write(
        `  [skip] .husky/commit-msg (already exists — merge holdout-frozen check by hand)\n`,
      );
    } else {
      await copyFile(hookSrc, hookDest);
      // chmod +x best-effort
      try {
        await (await import("node:fs/promises")).chmod(hookDest, 0o755);
      } catch {
        /* ignore */
      }
      process.stdout.write(`  [write] .husky/commit-msg (holdout-frozen check)\n`);
    }
  } else {
    process.stdout.write(
      "\n  Tip: install husky and re-run with --with-husky to add the holdout-frozen pre-commit hook.\n",
    );
  }

  // 4. INBOX.md placeholder (optional — the harness uses it for forward queue + post-archive pruning).
  const inboxPath = join(cwd, "INBOX.md");
  if (!existsSync(inboxPath)) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      inboxPath,
      "# INBOX\n\nForward queue of stories. Add entries under `## Open` with a `**Gating event:**` line each.\n\n## Open\n",
      "utf8",
    );
    process.stdout.write(`  [write] INBOX.md\n`);
  } else {
    process.stdout.write(`  [skip] INBOX.md (already exists)\n`);
  }

  process.stdout.write("\nNext steps:\n");
  process.stdout.write("  1. Edit harness.config.ts — set verification commands + tier scope rules.\n");
  process.stdout.write("  2. Edit openspec/project.md — record architectural invariants.\n");
  process.stdout.write("  3. Add to .gitignore:  .claude/worktrees/   .claude/harness-logs/\n");
  process.stdout.write("  4. Author your first proposal:  baton-harness ...  (see README).\n");
  await stat(templatesDir).catch(() => {});
  return 0;
}
