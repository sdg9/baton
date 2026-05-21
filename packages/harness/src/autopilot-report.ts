/**
 * Autopilot run report — assembles a Markdown summary of a full autopilot
 * batch run and writes it under .claude/harness-logs/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JudgmentCall } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoryRunLog {
  name: string;
  verdict: "green" | "yellow" | "red";
  attempts: number;
  durationMs: number;
  reasoning: string;
  judgmentCalls: JudgmentCall[];
}

export interface MainSideCommit {
  sha: string;
  message: string;
  mappedToJudgmentCall: boolean;
}

export interface AutopilotRunLog {
  startedAt: string;
  endedAt: string;
  terminalState:
    | "completed"
    | "stopped-red"
    | "stopped-cap"
    | "stopped-verify-all"
    | "stopped-conflict"
    | "stopped-error";
  stoppingStory?: string;
  stoppingReason?: string;
  stories: StoryRunLog[];
  mainSideCommits: MainSideCommit[];
}

// ---------------------------------------------------------------------------
// assembleReport
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function assembleReport(log: AutopilotRunLog): string {
  const lines: string[] = [];

  lines.push("# Autopilot Run Report");
  lines.push("");
  lines.push(`**Started:** ${log.startedAt}  `);
  lines.push(`**Ended:** ${log.endedAt}  `);
  lines.push(`**Terminal state:** ${log.terminalState}`);
  if (log.stoppingStory) {
    lines.push(`**Stopping story:** ${log.stoppingStory}  `);
    lines.push(`**Stopping reason:** ${log.stoppingReason ?? "(none)"}`);
  }
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| story | verdict | attempts | judgment-calls | duration |");
  lines.push("|---|---|---|---|---|");
  for (const s of log.stories) {
    const jcCount = s.judgmentCalls.length;
    lines.push(
      `| ${s.name} | ${s.verdict} | ${s.attempts} | ${jcCount} | ${formatDuration(s.durationMs)} |`,
    );
  }
  lines.push("");

  // Per-story blocks
  lines.push("## Story Details");
  lines.push("");
  for (const s of log.stories) {
    lines.push(`### ${s.name}`);
    lines.push("");
    lines.push(`**Verdict:** ${s.verdict}  `);
    lines.push(`**Attempts:** ${s.attempts}  `);
    lines.push(`**Duration:** ${formatDuration(s.durationMs)}`);
    lines.push("");
    lines.push("**Reasoning:**");
    lines.push("");
    lines.push(s.reasoning);
    lines.push("");
    lines.push("**Judgment calls:**");
    lines.push("");
    if (s.judgmentCalls.length === 0) {
      lines.push("(none)");
    } else {
      for (const jc of s.judgmentCalls) {
        lines.push(`- **[${jc.kind}]** ${jc.summary}`);
        lines.push(`  - Rationale: ${jc.rationale}`);
        if (jc.reviewerIds && jc.reviewerIds.length > 0) {
          lines.push(`  - Reviewers: ${jc.reviewerIds.join(", ")}`);
        }
      }
    }
    lines.push("");
  }

  // Main-side commits
  lines.push("## Main-side Commits");
  lines.push("");
  if (log.mainSideCommits.length === 0) {
    lines.push("(none)");
  } else {
    for (const c of log.mainSideCommits) {
      const mapped = c.mappedToJudgmentCall ? " ✓" : "";
      lines.push(`- \`${c.sha}\` ${c.message}${mapped}`);
    }
  }
  lines.push("");

  // Unreconciled main commits section (only if any are unmapped)
  const unreconciled = log.mainSideCommits.filter((c) => !c.mappedToJudgmentCall);
  if (unreconciled.length > 0) {
    lines.push("## Unreconciled Main Commits");
    lines.push("");
    lines.push(
      "These commits landed on main during the run but were not mapped to a judgment call. " +
        "Review them manually.",
    );
    lines.push("");
    for (const c of unreconciled) {
      lines.push(`- \`${c.sha}\` ${c.message}`);
    }
    lines.push("");
  }

  // Terminal state line
  lines.push(`---`);
  lines.push("");
  lines.push(`**Terminal state:** \`${log.terminalState}\``);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// writeAutopilotReport
// ---------------------------------------------------------------------------

export async function writeAutopilotReport(
  log: AutopilotRunLog,
  opts: { repoRoot: string },
): Promise<string> {
  const { repoRoot } = opts;
  const ts = new Date().toISOString();
  const filename = `autopilot-${ts}.md`;
  const dir = join(repoRoot, ".claude", "harness-logs");
  await mkdir(dir, { recursive: true });
  const absPath = join(dir, filename);
  const content = assembleReport(log);
  await writeFile(absPath, content, "utf8");
  process.stdout.write(`[autopilot-report] ${absPath}\n`);
  return absPath;
}
