/**
 * Unified harness CLI. The `autonomous-harness` skill drives the workflow;
 * these subcommands are the deterministic bits that belong in scripts
 * (git worktrees, verification, commits, structured logging, holdout tamper
 * checks) rather than in prompts.
 *
 * All commands exit non-zero on failure and print structured output to stdout.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanupPostArchiveSourceFolder, ensureChangeArchived } from "./archive-fallback.js";
import { loadConfig, loadMinimalConfig } from "./config-loader.js";
import { finishPostProcess } from "./finish-post-process.js";
import { assertMainClean, createWorktree, getDiff, removeWorktree } from "./git-worktree.js";
import { loadChange } from "./openspec.js";
import type { HarnessConfig, VerificationKind } from "./types.js";
import { runAllVerifications, runVerification } from "./verification.js";

const execFileAsync = promisify(execFile);

type Command = (args: string[]) => Promise<number>;

const commands: Record<string, Command> = {
  init: initCmd,
  status,
  approve,
  unapprove,
  "worktree-create": worktreeCreate,
  "worktree-remove": worktreeRemove,
  "verify-all": verifyAll,
  verify,
  diff,
  doctor: doctorCmd,
  "holdout-check": holdoutCheck,
  "holdout-validate": holdoutValidateCmd,
  "log-event": logEvent,
  result,
  handoff,
  "validate-specs": validateSpecs,
  finish,
  accept,
  review,
  "run-queue": runQueueCmd,
  "verify-escalation": verifyEscalationCmd,
  "merge-to-main": mergeToMainCmd,
  help,
};

async function initCmd(args: string[]): Promise<number> {
  const { init } = await import("./init.js");
  return init(args);
}

async function runQueueCmd(args: string[]): Promise<number> {
  const { runQueue } = await import("./run-queue.js");
  return runQueue(args);
}

async function doctorCmd(args: string[]): Promise<number> {
  let cwd = process.cwd();
  let asJson = false;
  // null = auto (TTY + no NO_COLOR), true/false = explicit override.
  let colorOverride: boolean | null = null;
  for (const arg of args) {
    if (arg === "--json") {
      asJson = true;
      continue;
    }
    if (arg === "--color") {
      colorOverride = true;
      continue;
    }
    if (arg === "--no-color") {
      colorOverride = false;
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      cwd = arg.slice("--cwd=".length);
      continue;
    }
    if (arg === "--cwd") {
      process.stderr.write("doctor: --cwd requires a value (use --cwd=<path>)\n");
      return 2;
    }
    process.stderr.write(`doctor: unknown argument "${arg}"\n`);
    return 2;
  }

  const { runDoctor, renderHuman, renderJson } = await import("./doctor.js");
  const report = await runDoctor(cwd);
  if (asJson) {
    process.stdout.write(`${renderJson(report)}\n`);
  } else {
    const colors = colorOverride ?? shouldUseColors();
    process.stdout.write(`${renderHuman(report, { colors })}\n`);
  }
  return report.ok ? 0 : 1;
}

/**
 * Decide whether to emit ANSI color escapes. Honors the de-facto standards:
 *   • NO_COLOR (any value) — disable, per https://no-color.org
 *   • FORCE_COLOR — enable even when not a TTY (e.g. CI logs that render ANSI)
 *   • otherwise enable only when stdout is a TTY
 */
function shouldUseColors(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY);
}

async function getChangedPaths(baseBranch: string, branch: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", `${baseBranch}...${branch}`],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
    },
  );
  return stdout
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
}

async function mergeToMainCmd(args: string[]): Promise<number> {
  const fast = args.includes("--fast");
  const story = args.find((arg) => !arg.startsWith("--"));
  if (!story) {
    process.stderr.write("usage: cli.ts merge-to-main <story> [--fast]\n");
    return 2;
  }
  const { mergeToMain, requiresFullVerification } = await import("./merge-to-main.js");
  const { spawn } = await import("node:child_process");

  let runFullVerification = !fast;
  // Load config once so we can both thread it into mergeToMain and use it to
  // build verifyAll. If loading fails, we still attempt the merge with no
  // tier guardrail (function exits early with a sensible error).
  const config = await loadConfig().catch(() => null);

  const runVerifyAll = () =>
    new Promise<{ success: boolean; failedGates: string[] }>((resolve) => {
      // Invoke the same CLI process (whatever node script is currently
      // running) to run verify-all. Works under `npx baton-harness`,
      // `tsx src/cli.ts`, and a packaged bin alike.
      const verifyArgs = [process.argv[1] ?? "", "verify-all"];
      if (runFullVerification) verifyArgs.push("--full");
      const child = spawn(process.execPath, verifyArgs, {
        stdio: "inherit",
        env: process.env,
      });
      child.on("close", (code) => {
        resolve({ success: code === 0, failedGates: code !== 0 ? ["verify-all"] : [] });
      });
    });

  let tier: import("./types.js").StoryTier | undefined;
  let branchName = story;
  let baseBranch = "main";
  let tierScopeRules: import("./types.js").TierScopeRules | undefined;
  try {
    if (!config) throw new Error("config unavailable");
    const change = await loadChange(config.openspecDir, story);
    tier = change.tier;
    branchName = `${config.git.branchPrefix}${story}`;
    baseBranch = config.git.baseBranch;
    tierScopeRules = config.tierScopeRules;
    if (fast) {
      const diffPaths = await getChangedPaths(baseBranch, branchName);
      if (requiresFullVerification(diffPaths, config.fullVerificationTriggers)) {
        runFullVerification = true;
        process.stderr.write(
          "[harness] --fast requested, but diff touches infrastructure paths; running verify-all --full\n",
        );
      } else {
        process.stderr.write(
          "[harness] --fast requested; running verify-all without slow CLI-integration projects\n",
        );
      }
    }
  } catch {
    if (fast) {
      runFullVerification = true;
      process.stderr.write(
        "[harness] --fast requested, but diff preflight failed; running verify-all --full\n",
      );
    }
    /* tier optional — guardrail simply skipped */
  }

  const result = await mergeToMain({
    story,
    repoRoot: process.cwd(),
    runVerifyAll,
    tier,
    tierScopeRules,
    baseBranch,
    branch: branchName,
  });

  if (!result.success) {
    if (result.failedGates && result.failedGates.length > 0) {
      process.stderr.write(
        `merge-to-main failed: verify-all gates: ${result.failedGates.join(", ")}\n`,
      );
    }
    if (result.conflicts && result.conflicts.length > 0) {
      process.stderr.write(`conflicting paths: ${result.conflicts.join(", ")}\n`);
    }
    if (result.scopeViolations && result.scopeViolations.length > 0) {
      process.stderr.write(
        `tier-scope guardrail blocked merge — offending paths:\n  ${result.scopeViolations.join("\n  ")}\n`,
      );
      process.stderr.write("Re-tag the proposal's `## Tier` value or split the story.\n");
    }
    if (result.reason) {
      process.stderr.write(`reason: ${result.reason}\n`);
    }
    return 1;
  }

  process.stdout.write(`merged ${branchName} into ${baseBranch}\n`);
  process.stdout.write(`pre-merge: ${result.preMergeSha ?? "?"}\n`);
  process.stdout.write(`post-merge: ${result.postMergeSha ?? "?"}\n`);
  return 0;
}

async function verifyEscalationCmd(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    process.stderr.write("usage: cli.ts verify-escalation <story>\n");
    return 2;
  }
  const config = await loadMinimalConfig();
  const logDir = config.logDir;
  const logPath = join(logDir, `${story}.jsonl`);
  if (!existsSync(logPath)) {
    process.stderr.write(`log file missing: ${logPath} (story: ${story})\n`);
    return 1;
  }
  const { verifyEscalation } = await import("./escalation-check.js");
  const report = verifyEscalation(logPath);
  if (report.passed) {
    process.stdout.write(
      `✓ ${story} escalation check passed (${report.implementEvents} events, 0 violations)\n`,
    );
    return 0;
  }
  for (const v of report.violations) {
    process.stdout.write(
      `  violation: attempt=${String(v.attempt)} model=${JSON.stringify(v.model)} reason=${v.reason}\n`,
    );
  }
  process.stdout.write(
    `✗ ${story} escalation check failed (${report.violations.length} violations)\n`,
  );
  return 1;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const run = cmd ? commands[cmd] : help;
  if (!run) {
    console.error(`unknown command: ${cmd}`);
    await help([]);
    process.exit(2);
  }
  const code = await run(rest);
  process.exit(code);
}

async function help(_args: string[] = []): Promise<number> {
  console.log(
    [
      "baton-harness subcommands:",
      "  init [--force] [--with-hook]",
      "                            scaffold harness.config.ts + openspec/ + commit-msg hook",
      "  status <story>            check spec + approval + holdouts readiness",
      "  approve <story>           mark story approved (writes approved sentinel)",
      "  unapprove <story>         remove approval sentinel",
      "  worktree-create <story>   create git worktree + branch for story",
      "  worktree-remove <story>   remove story worktree",
      "  verify-all                run lint, typecheck, unit, e2e",
      "  verify <kind>             run one of: lint typecheck unit e2e",
      "  diff <story>              print diff of story branch vs base",
      "  doctor [--json] [--cwd=<path>] [--color|--no-color]",
      "                            verify the install: config, openspec, external CLIs, verify cmds",
      "  holdout-check             refuse if uncommitted/staged diff touches a holdout",
      "  holdout-validate <story> [--scope=story|repo]",
      "                            static-scan holdouts for the 3 documented antipatterns",
      "                            (default --scope=story limits to branch-modified holdouts; --scope=repo audits all tracked holdouts)",
      "  log-event <story> <json>  append JSONL event to harness log",
      "  result <story>            write HARNESS_RESULT.md in worktree",
      "  handoff <story>           write HANDOFF.md in worktree (reads body from stdin)",
      "  validate-specs            run `openspec validate --strict` on every change folder",
      "  merge-to-main <story> [--fast]",
      "                            merge story branch; --fast skips slow unit projects unless infra changed",
      "  finish <story>            after merge: openspec archive + worktree-remove + branch -d",
      "  accept <story>            preflight + checkout main + merge --no-ff + finish (one-liner)",
      "  review <story>            generate static HTML review page and open in browser",
      "  run-queue <story...>      preflight all stories and print JSON plan",
      "  verify-escalation <story> check that implement-phase escalation rules were followed",
    ].join("\n"),
  );
  return 0;
}

async function accept(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts accept <story>");
    return 2;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { readFile } = await import("node:fs/promises");
  const config = await loadConfig();
  const branch = `${config.git.branchPrefix}${story}`;
  const worktreePath = join(config.worktreeDir, story);

  // Preflight — fail fast BEFORE mutating anything.
  const failures: string[] = [];

  // (1) working tree on the current branch must be clean.
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"]);
    if (stdout.trim().length > 0) {
      failures.push(
        "main-repo working tree is not clean. Commit or stash pending changes first:\n" +
          stdout
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
      );
    }
  } catch (err) {
    failures.push(`git status failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // (2) story branch must exist.
  const branchExists = await exec("git", ["rev-parse", "--verify", branch])
    .then(() => true)
    .catch(() => false);
  if (!branchExists) {
    failures.push(`branch ${branch} does not exist — nothing to accept`);
  }

  // (3) review-summary.json must exist and verdict must be green.
  const summaryPath = join(worktreePath, "review-summary.json");
  if (!existsSync(summaryPath)) {
    failures.push(
      `missing ${summaryPath}. Run the harness to completion, or manually write a review summary before accepting.`,
    );
  } else {
    try {
      const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
        verdict?: string;
      };
      if (summary.verdict !== "green") {
        failures.push(
          `review verdict is "${summary.verdict}" (not "green"). Address findings or override with --force (not implemented — bypass manually if needed).`,
        );
      }
    } catch (err) {
      failures.push(
        `could not parse ${summaryPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`accept refused for ${story}:`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }

  // Execute — each step prints status; bail on first failure.
  const baseBranch = config.git.baseBranch;
  const steps: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: `git checkout ${baseBranch}`,
      run: async () => {
        await exec("git", ["checkout", baseBranch]);
      },
    },
    {
      label: `git merge --no-ff ${branch}`,
      run: async () => {
        await exec("git", ["merge", "--no-ff", branch]);
      },
    },
    {
      label: `finish ${story}`,
      run: async () => {
        const code = await finish([story]);
        if (code !== 0) {
          throw new Error(`finish returned exit ${code}`);
        }
      },
    },
  ];

  for (const s of steps) {
    try {
      await s.run();
      console.log(`[OK] ${s.label}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[FAIL] ${s.label}: ${msg}`);
      return 1;
    }
  }
  console.log(`accepted ${story}`);
  return 0;
}

async function review(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts review <story>");
    return 2;
  }
  const { generateReview, openInBrowser } = await import("./review.js");
  const path = await generateReview(story);
  console.log(`review page: ${path}`);
  await openInBrowser(path);
  return 0;
}

async function finish(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts finish <story>");
    return 2;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const config = await loadConfig();
  const branch = `${config.git.branchPrefix}${story}`;
  const worktreePath = join(config.worktreeDir, story);

  // 1. Refuse if branch not merged into base.
  const merged = await branchMergedInto(branch, config.git.baseBranch);
  if (!merged) {
    console.error(
      `refusing to finish: branch ${branch} is not merged into ${config.git.baseBranch}. ` +
        `Merge first, then re-run.`,
    );
    return 1;
  }

  // 2. Refuse if the change folder is missing (already archived?).
  const changeDir = join(config.openspecDir, "changes", story);
  if (!existsSync(changeDir)) {
    console.error(`no change folder at ${changeDir} — already finished?`);
    return 1;
  }

  const steps: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: `openspec archive ${story}`,
      run: async () => {
        let archive: { stdout: string; stderr: string };
        try {
          archive = await exec("npx", ["--no-install", "openspec", "archive", story, "--yes"]);
        } catch (err) {
          const output = err as { stdout?: string; stderr?: string };
          if (output.stdout?.trim()) {
            console.log(`[openspec stdout]\n${output.stdout.trim()}`);
          }
          if (output.stderr?.trim()) {
            console.warn(`[openspec stderr]\n${output.stderr.trim()}`);
          }
          throw err;
        }
        if (archive.stdout.trim().length > 0) {
          console.log(`[openspec stdout]\n${archive.stdout.trim()}`);
        }
        if (archive.stderr.trim().length > 0) {
          console.warn(`[openspec stderr]\n${archive.stderr.trim()}`);
        }
        const result = await ensureChangeArchived({
          story,
          openspecDir: config.openspecDir,
          cwd: process.cwd(),
          exec,
        });
        if (result.status === "fallback-moved") {
          console.log(`[OK] archive fallback moved folder to ${result.archivedPath}`);
        }
      },
    },
    {
      label: `post-process archived specs for ${story}`,
      run: async () => {
        const report = await finishPostProcess({
          story,
          openspecDir: config.openspecDir,
          cwd: process.cwd(),
          exec,
        });
        for (const p of report.processedSpecs) {
          console.log(`[OK] post-processed ${p}`);
        }
        for (const a of report.deletedArtifacts) {
          console.log(`[OK] deleted ${a}`);
        }
        const cleanup = await cleanupPostArchiveSourceFolder({
          story,
          openspecDir: config.openspecDir,
          cwd: process.cwd(),
          exec,
        });
        if (cleanup.status === "cleaned") {
          console.log(`[OK] cleaned post-archive orphan source folder ${cleanup.path}`);
        }
      },
    },
    {
      label: `worktree-remove ${worktreePath}`,
      run: async () => {
        await removeWorktree(worktreePath);
      },
    },
    {
      label: `git branch -d ${branch}`,
      run: async () => {
        await exec("git", ["branch", "-d", branch]).catch(() => {});
      },
    },
  ];

  for (const s of steps) {
    try {
      await s.run();
      console.log(`[OK] ${s.label}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[FAIL] ${s.label}: ${msg}`);
      return 1;
    }
  }
  console.log(`finished ${story}`);
  return 0;
}

async function branchMergedInto(branch: string, base: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec("git", ["branch", "--merged", base]);
    return stdout
      .split("\n")
      .map((l) => l.replace(/^[*+]?\s+/, "").trim())
      .includes(branch);
  } catch {
    return false;
  }
}

async function validateSpecs(): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const config = await loadConfig();
  const changesDir = join(config.openspecDir, "changes");
  if (!existsSync(changesDir)) {
    console.log("no openspec/changes directory — nothing to validate");
    return 0;
  }
  const entries = await readdir(changesDir, { withFileTypes: true });
  const changes = entries
    .filter(
      (e) =>
        e.isDirectory() && e.name !== "archive" && existsSync(join(changesDir, e.name, "specs")),
    )
    .map((e) => e.name);
  if (changes.length === 0) {
    console.log("no openspec changes — nothing to validate");
    return 0;
  }
  let failed = 0;
  for (const change of changes) {
    const passed = await runOne(change);
    if (!passed) failed++;
  }
  if (failed > 0) {
    console.error(`${failed}/${changes.length} change(s) failed openspec validation`);
    return 1;
  }
  console.log(`all ${changes.length} change(s) valid`);
  return 0;

  function runOne(change: string): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const child = spawn(
        "npx",
        ["@fission-ai/openspec", "validate", change, "--type", "change", "--strict"],
        {
          shell: false,
        },
      );
      let out = "";
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.stderr.on("data", (d) => {
        out += d.toString();
      });
      child.on("close", (code) => {
        if (code === 0) {
          console.log(`[OK] ${change}`);
        } else {
          console.error(`[FAIL] ${change}\n${out.slice(-2000)}`);
        }
        resolvePromise(code === 0);
      });
    });
  }
}

async function status(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts status <story>");
    return 2;
  }
  const config = await loadConfig();
  const change = await loadChange(config.openspecDir, story);
  const reviewProfile = await resolveReviewProfile(story, change.path, config.reviewProfiles);
  const out = {
    story,
    path: change.path,
    approved: change.approved,
    hasProposal: Boolean(change.proposal),
    hasDesign: Boolean(change.design),
    hasTasks: Boolean(change.tasks),
    specFiles: change.specs.map((s) => s.file),
    holdoutPaths: config.holdouts.paths,
    markerComment: config.holdouts.markerComment,
    baseBranch: config.git.baseBranch,
    branchName: `${config.git.branchPrefix}${story}`,
    worktreePath: join(config.worktreeDir, story),
    maxAttempts: config.iteration.maxAttempts,
    models: config.models,
    reviewProfiles: config.reviewProfiles,
    reviewProfile,
    tier: change.tier,
  };
  console.log(JSON.stringify(out, null, 2));
  for (const w of change.tierWarnings) {
    process.stderr.write(`[harness] WARN ${w}\n`);
  }
  if (!change.approved) {
    console.error(`story is not approved. Create \`${change.path}/approved\` after human review.`);
    return 1;
  }
  return 0;
}

async function resolveReviewProfile(
  story: string,
  changePath: string,
  profiles: HarnessConfig["reviewProfiles"],
): Promise<{ name: string; reviewers: string[] } | undefined> {
  if (!profiles) return undefined;
  // Story can declare a profile by writing the profile name to
  // `<changePath>/review-profile` (single-line text file). If absent, fall
  // back to "default".
  const profileFile = join(changePath, "review-profile");
  let name = "default";
  if (existsSync(profileFile)) {
    const { readFile } = await import("node:fs/promises");
    name = (await readFile(profileFile, "utf8")).trim();
  }
  void story;
  const profile = profiles[name] ?? profiles.default;
  return { name: profiles[name] ? name : "default", reviewers: profile.reviewers };
}

async function approve(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts approve <story>");
    return 2;
  }
  const config = await loadConfig();
  const change = await loadChange(config.openspecDir, story);
  if (change.specs.length === 0) {
    console.error(
      `refusing to approve: no spec files under ${change.path}/specs/. Write at least one spec.md first.`,
    );
    return 1;
  }
  if (change.tierWarnings.length > 0) {
    for (const w of change.tierWarnings) {
      console.error(`[tier] ${w}`);
    }
    console.error(
      "refusing to approve: proposal.md must declare a valid `## Tier` section (primitives | content | infra).",
    );
    return 1;
  }
  const { spawn } = await import("node:child_process");
  const validated = await new Promise<boolean>((res) => {
    const c = spawn("npx", [
      "@fission-ai/openspec",
      "validate",
      story,
      "--type",
      "change",
      "--strict",
    ]);
    let out = "";
    c.stdout.on("data", (d) => {
      out += d.toString();
    });
    c.stderr.on("data", (d) => {
      out += d.toString();
    });
    c.on("close", (code) => {
      if (code !== 0) console.error(out);
      res(code === 0);
    });
  });
  if (!validated) {
    console.error("refusing to approve: openspec validate failed");
    return 1;
  }
  const sentinel = join(change.path, "approved");
  await writeFile(
    sentinel,
    `approved: ${new Date().toISOString()}\n` +
      `story: ${story}\n` +
      `commit: ${await currentCommit()}\n`,
    "utf8",
  );
  console.log(`approved ${story} -> ${sentinel}`);
  return 0;
}

async function unapprove(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts unapprove <story>");
    return 2;
  }
  const { unlink } = await import("node:fs/promises");
  const config = await loadConfig();
  const sentinel = join(config.openspecDir, "changes", story, "approved");
  if (!existsSync(sentinel)) {
    console.log(`already unapproved (no sentinel at ${sentinel})`);
    return 0;
  }
  await unlink(sentinel);
  console.log(`unapproved ${story}`);
  return 0;
}

async function currentCommit(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function worktreeCreate(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts worktree-create <story>");
    return 2;
  }
  await assertMainClean(process.cwd());
  const config = await loadConfig();
  const change = await loadChange(config.openspecDir, story);
  if (!change.approved) {
    console.error(
      `refusing to create worktree: story not approved (${change.path}/approved missing)`,
    );
    return 1;
  }
  const wt = await createWorktree(
    config.worktreeDir,
    config.git.branchPrefix,
    story,
    config.git.baseBranch,
  );
  console.log(JSON.stringify({ path: wt.path, branch: wt.branch }, null, 2));
  return 0;
}

async function worktreeRemove(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts worktree-remove <story>");
    return 2;
  }
  const config = await loadConfig();
  const path = join(config.worktreeDir, story);
  await removeWorktree(path);
  console.log(JSON.stringify({ removed: path }));
  return 0;
}

async function verifyAll(args: string[] = []): Promise<number> {
  const full = args.includes("--full");
  const config = await loadConfig();
  const results = await runAllVerifications(config, process.cwd(), { full });
  const allPassed = results.every((r) => r.passed);
  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    console.log(`[${tag}] ${r.kind} (${Math.round(r.durationMs)}ms)`);
    if (!r.passed) console.log(r.output.slice(-4000));
  }
  return allPassed ? 0 : 1;
}

async function verify(args: string[]): Promise<number> {
  const kind = args[0] as VerificationKind | undefined;
  if (!kind || !["lint", "typecheck", "unit", "e2e"].includes(kind)) {
    console.error("usage: cli.ts verify <lint|typecheck|unit|e2e>");
    return 2;
  }
  const config = await loadConfig();
  const r = await runVerification(kind, config, process.cwd());
  const tag = r.passed ? "PASS" : "FAIL";
  console.log(`[${tag}] ${r.kind} (${Math.round(r.durationMs)}ms)`);
  if (!r.passed) console.log(r.output.slice(-4000));
  return r.passed ? 0 : 1;
}

async function diff(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts diff <story>");
    return 2;
  }
  const config = await loadConfig();
  const cwd = join(config.worktreeDir, story);
  if (!existsSync(cwd)) {
    console.error(`worktree missing: ${cwd}`);
    return 1;
  }
  const out = await getDiff(cwd, config.git.baseBranch);
  console.log(out);
  return 0;
}

async function holdoutValidateCmd(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    process.stderr.write("usage: cli.ts holdout-validate <story> [--scope=story|repo]\n");
    return 2;
  }
  // Parse `--scope=<value>` from remaining args. Default `story` — the validator
  // gates the current story's holdouts; pass `--scope=repo` for ad-hoc full-repo audits.
  let scope: "repo" | "story" = "story";
  for (const arg of args.slice(1)) {
    if (arg.startsWith("--scope=")) {
      const v = arg.slice("--scope=".length);
      if (v !== "repo" && v !== "story") {
        process.stderr.write(
          `holdout-validate: invalid --scope value "${v}". Accepted: repo, story.\n`,
        );
        return 2;
      }
      scope = v;
    } else {
      process.stderr.write(`holdout-validate: unknown argument "${arg}"\n`);
      return 2;
    }
  }

  const config = await loadConfig();
  const change = await loadChange(config.openspecDir, story);
  // Skip on non-primitives tiers — there are no holdouts to validate.
  if (change.tier !== "primitives") {
    process.stdout.write(
      `holdout-validate: story tier is "${change.tier}"; no holdouts to validate.\n`,
    );
    return 0;
  }

  // Find holdout files in the worktree (or current cwd if running inside the worktree).
  const cwd = existsSync(join(config.worktreeDir, story))
    ? join(config.worktreeDir, story)
    : process.cwd();
  const { resolveHoldoutPaths } = await import("./holdout-validate-scope.js");
  const all = await resolveHoldoutPaths({
    cwd,
    holdoutPaths: config.holdouts.paths,
    scope,
    baseBranch: config.git.baseBranch,
  });

  const reportPath = join(cwd, "holdout-validation.json");

  // Story scope with no matching diff: pass cleanly without invoking detectors.
  if (scope === "story" && all.length === 0) {
    const empty = { passed: true, violations: [], filesScanned: 0, scope } as const;
    await writeFile(reportPath, `${JSON.stringify(empty, null, 2)}\n`, "utf8");
    process.stdout.write("holdout-validate: no story-scoped holdout changes; passing.\n");
    process.stdout.write(`report: ${reportPath}\n`);
    return 0;
  }

  // Read the proposal's `## Impact` section to power the over-constrained-extractor detector.
  const impact = extractImpactSection(change.proposal);

  const { validateHoldoutSuite } = await import("./holdout-validate.js");
  const baseReport = await validateHoldoutSuite(all, { proposalImpact: impact });
  const report = { ...baseReport, scope };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.passed) {
    process.stderr.write(
      `holdout-validate: ${report.violations.length} violation(s) across ${report.filesScanned} file(s) (scope=${scope}):\n`,
    );
    for (const v of report.violations) {
      process.stderr.write(`  [${v.kind}] ${v.file}:${v.line ?? "?"} — ${v.reason}\n`);
    }
    process.stderr.write(`report: ${reportPath}\n`);
    return 1;
  }
  process.stdout.write(
    `holdout-validate: passed (${report.filesScanned} file(s) scanned, 0 violations, scope=${scope}).\n`,
  );
  process.stdout.write(`report: ${reportPath}\n`);
  return 0;
}

function extractImpactSection(proposal: string): string {
  const lines = proposal.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Impact\s*$/i.test(lines[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i] ?? "")) break;
    out.push(lines[i] ?? "");
  }
  return out.join("\n");
}

async function holdoutCheck(): Promise<number> {
  // Holdouts are born on the story branch (the harness commits them first).
  // "Tamper" means: any commit on the branch AFTER the `holdouts(...)` commit
  // that touches a file matching a holdout glob. We locate the holdouts
  // commit by its message prefix, then diff from there to HEAD.
  const config = await loadConfig();
  const cwd = process.cwd();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  const pathspecs = config.holdouts.paths.map((p) => `:(glob)${p}`);

  const { stdout: holdoutsSha } = await exec(
    "git",
    ["log", "--format=%H", "-n", "1", "--grep", "^holdouts("],
    { cwd },
  );
  const sha = holdoutsSha.trim();
  if (!sha) {
    console.log("holdouts clean (no holdouts commit found on this branch)");
    return 0;
  }

  const { stdout: changed } = await exec(
    "git",
    ["log", "--name-only", "--format=", `${sha}..HEAD`, "--", ...pathspecs],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );
  const offenders = [
    ...new Set(
      changed
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  if (offenders.length > 0) {
    console.error(`holdout files modified after ${sha.slice(0, 7)}:\n  ${offenders.join("\n  ")}`);
    return 1;
  }
  console.log(`holdouts clean (frozen at ${sha.slice(0, 7)})`);
  return 0;
}

async function logEvent(args: string[]): Promise<number> {
  const [story, ...rest] = args;
  const json = rest.join(" ");
  if (!story || !json) {
    console.error("usage: cli.ts log-event <story> <json>");
    return 2;
  }
  const config = await loadConfig();
  await mkdir(config.logDir, { recursive: true });
  const path = join(config.logDir, `${story}.jsonl`);
  const record = { ts: new Date().toISOString(), ...JSON.parse(json) };
  await appendFile(path, `${JSON.stringify(record)}\n`);
  console.log(path);
  return 0;
}

async function result(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts result <story>");
    return 2;
  }
  await assertMainClean(process.cwd());
  const config = await loadConfig();
  const cwd = join(config.worktreeDir, story);
  const branch = `${config.git.branchPrefix}${story}`;
  const body = await readStdinOrDefault(`# ${story}\n\nBranch: \`${branch}\`\nAll gates passed.\n`);
  await writeFile(join(cwd, "HARNESS_RESULT.md"), body, "utf8");
  return 0;
}

async function handoff(args: string[]): Promise<number> {
  const story = args[0];
  if (!story) {
    console.error("usage: cli.ts handoff <story>  (body on stdin)");
    return 2;
  }
  const config = await loadConfig();
  const cwd = join(config.worktreeDir, story);
  const body = await readStdinOrDefault(`# HANDOFF — ${story}\n\n(no body provided on stdin)\n`);
  await writeFile(join(cwd, "HANDOFF.md"), body, "utf8");
  console.error(`[harness] ESCALATED — see ${join(cwd, "HANDOFF.md")}`);
  return 0;
}

async function readStdinOrDefault(fallback: string): Promise<string> {
  if (process.stdin.isTTY) return fallback;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim().length > 0 ? text : fallback;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
