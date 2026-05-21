// `baton-harness init` — scaffold a consuming repo.
//
// Copies templates/ into the current working directory so the consumer can
// edit a harness.config.ts, an openspec/ skeleton, and the commit-msg
// pre-commit hook without copy-paste boilerplate. Idempotent: skips files
// that already exist unless --force is passed.

import { execFileSync } from "node:child_process";
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

/**
 * Set the consuming repo's local `core.hooksPath` to `.githooks` so the
 * commit-msg hook fires on every commit. If the key is already set to
 * something other than `.githooks`, leave it alone and tell the user —
 * silently overwriting could break an existing hooks setup.
 */
function configureHooksPath(cwd: string): void {
  const desired = ".githooks";
  let current: string | null = null;
  try {
    current = execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // `git config --get` exits 1 when the key is unset, or when this isn't a
    // git repo at all. We disambiguate below by trying the `set` and checking
    // its error.
  }

  if (current === desired) {
    process.stdout.write(`  [skip] git config core.hooksPath (already ${desired})\n`);
    return;
  }
  if (current && current !== desired) {
    process.stdout.write(
      `\n  ⚠ git config core.hooksPath is set to "${current}" — leaving it alone.\n` +
        `    Set it to "${desired}" manually (or remove the existing value) to activate the hook.\n`,
    );
    return;
  }

  try {
    execFileSync("git", ["config", "--local", "core.hooksPath", desired], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(`  [config] git config core.hooksPath -> ${desired}\n`);
  } catch {
    process.stdout.write(
      `\n  ⚠ couldn't run \`git config --local core.hooksPath ${desired}\`.\n` +
        `    Not a git repo? Run \`git init\` first and then \`git config core.hooksPath ${desired}\`.\n`,
    );
  }
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

function parseFormat(args: string[]): "ts" | "json" {
  // Supports `--format ts|json` and `--format=ts|json`. Default: ts.
  const eq = args.find((a) => a.startsWith("--format="));
  if (eq) {
    const value = eq.slice("--format=".length);
    if (value !== "ts" && value !== "json") {
      throw new Error(`init: --format must be 'ts' or 'json' (got '${value}')`);
    }
    return value;
  }
  const idx = args.indexOf("--format");
  if (idx >= 0) {
    const value = args[idx + 1];
    if (value !== "ts" && value !== "json") {
      throw new Error(`init: --format must be 'ts' or 'json' (got '${value ?? "<missing>"}')`);
    }
    return value;
  }
  return "ts";
}

export async function init(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const format = parseFormat(args);
  const cwd = process.cwd();
  const templatesDir = locateTemplatesDir();

  process.stdout.write(`Initializing baton-harness in ${cwd}\n`);
  process.stdout.write(`(templates from ${templatesDir})\n\n`);

  // 1. Drop harness.config.{ts,json} at the repo root (if missing).
  //    Default is .ts (typed schema, comments, computation). JSON variant
  //    is opt-in via --format json and gets schema autocomplete via $schema.
  const configFile = format === "json" ? "harness.config.json" : "harness.config.ts";
  const configSrc = join(templatesDir, configFile);
  const configDest = join(cwd, configFile);
  if (existsSync(configDest) && !force) {
    process.stdout.write(`  [skip] ${configFile} (already exists)\n`);
  } else {
    await copyFile(configSrc, configDest);
    process.stdout.write(`  [write] ${configFile}\n`);
  }

  // 2. Scaffold openspec/ if missing.
  const openspecSrc = join(templatesDir, "openspec");
  const openspecDest = join(cwd, "openspec");
  await mkdir(openspecDest, { recursive: true });
  await copyRecursive(openspecSrc, openspecDest, force);
  await mkdir(join(openspecDest, "changes"), { recursive: true });

  // 3. .githooks/commit-msg hook (only if .githooks/ exists OR --with-hook).
  //
  // The hook itself is a plain POSIX shell script — no husky dependency. We
  // place it under .githooks/ and (when --with-hook is passed) point
  // core.hooksPath at that directory so the hook fires on every commit in
  // the consuming repo with no extra install steps.
  const gitHooksDir = join(cwd, ".githooks");
  const wantsHook = args.includes("--with-hook");
  if (existsSync(gitHooksDir) || wantsHook) {
    await mkdir(gitHooksDir, { recursive: true });
    const hookSrc = join(templatesDir, ".githooks", "commit-msg");
    const hookDest = join(gitHooksDir, "commit-msg");
    if (existsSync(hookDest) && !force) {
      process.stdout.write(
        `  [skip] .githooks/commit-msg (already exists — merge holdout-frozen check by hand)\n`,
      );
    } else {
      await copyFile(hookSrc, hookDest);
      try {
        await (await import("node:fs/promises")).chmod(hookDest, 0o755);
      } catch {
        /* ignore */
      }
      process.stdout.write(`  [write] .githooks/commit-msg (holdout-frozen check)\n`);
    }

    if (wantsHook) {
      configureHooksPath(cwd);
    }
  } else {
    process.stdout.write(
      "\n  Tip: re-run with --with-hook to install the holdout-frozen commit-msg hook (no husky required).\n",
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
  process.stdout.write(`  1. Edit ${configFile} — set verification commands + tier scope rules.\n`);
  process.stdout.write("  2. Edit openspec/project.md — record architectural invariants.\n");
  process.stdout.write("  3. Add to .gitignore:  .claude/worktrees/   .claude/harness-logs/\n");
  process.stdout.write("  4. Author your first proposal:  baton-harness ...  (see README).\n");
  await stat(templatesDir).catch(() => {});
  return 0;
}
