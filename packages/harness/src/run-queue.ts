import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadMinimalConfig } from "./config-loader.js";
import { parseTier } from "./openspec.js";
import type { StoryTier } from "./types.js";

const exec = promisify(execFile);

export async function runQueue(rawArgs: string[]): Promise<number> {
  // Parse --autopilot flag; strip it from story names.
  let autopilot = false;
  const stories: string[] = [];
  for (const arg of rawArgs) {
    if (arg === "--autopilot") {
      autopilot = true;
    } else {
      stories.push(arg);
    }
  }

  if (stories.length === 0) {
    process.stderr.write("usage: cli.ts run-queue [--autopilot] <story...>\n");
    return 2;
  }

  let config: Awaited<ReturnType<typeof loadMinimalConfig>>;
  try {
    config = await loadMinimalConfig();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\u2717 preflight: ${reason}\n`);
    return 1;
  }
  const { storiesDir, worktreesDir, models, maxAttempts } = config;

  // Per-story preflight checks.
  const tiers: Record<string, StoryTier> = {};
  for (const story of stories) {
    const storyDir = join(storiesDir, story);
    if (!existsSync(storyDir)) {
      process.stderr.write(
        `\u2717 ${story} failed preflight: story directory missing: ${storyDir}\n`,
      );
      return 1;
    }
    const approvedSentinel = join(storyDir, "approved");
    if (!existsSync(approvedSentinel)) {
      process.stderr.write(
        `\u2717 ${story} failed preflight: not approved (${approvedSentinel} missing)\n`,
      );
      return 1;
    }
    const worktreePath = join(worktreesDir, story);
    if (existsSync(worktreePath)) {
      process.stderr.write(
        `\u2717 ${story} failed preflight: existing worktree at ${worktreePath}\n`,
      );
      return 1;
    }
    // Validate tier (invalid value \u2192 reject; missing \u2192 grace warning + default).
    const proposalPath = join(storyDir, "proposal.md");
    if (!existsSync(proposalPath)) {
      process.stderr.write(
        `\u2717 ${story} failed preflight: proposal.md missing at ${proposalPath}\n`,
      );
      return 1;
    }
    let parsed: ReturnType<typeof parseTier>;
    try {
      parsed = parseTier(await readFile(proposalPath, "utf8"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\u2717 ${story} failed preflight: ${reason}\n`);
      return 1;
    }
    for (const w of parsed.warnings) {
      process.stderr.write(`[harness] WARN ${story}: ${w}\n`);
    }
    tiers[story] = parsed.tier;
  }

  // Autopilot-specific: dirty-tree check.
  if (autopilot) {
    let statusOut: string;
    try {
      const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: process.cwd() });
      statusOut = stdout.trim();
    } catch (err) {
      process.stderr.write(`\u2717 autopilot preflight: git status failed: ${String(err)}\n`);
      return 1;
    }
    if (statusOut.length > 0) {
      process.stderr.write(
        `\u2717 autopilot preflight: working tree is dirty — commit or stash uncommitted changes before running autopilot\n`,
      );
      return 1;
    }
  }

  const plan = { queue: stories, models, maxAttempts, autopilot, tiers };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  return 0;
}
