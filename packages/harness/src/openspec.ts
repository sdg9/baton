import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { type StoryTier, VALID_TIERS } from "./types.js";

export interface ChangeFolder {
  name: string;
  path: string;
  proposal: string;
  design?: string;
  specs: { file: string; content: string }[];
  tasks?: string;
  approved: boolean;
  tier: StoryTier;
  /**
   * Diagnostic flags about the tier parse:
   *  - `missing` — the proposal had no `## Tier` section (default applied)
   *  - `default-applied` — currently always equal to `missing`; kept separate
   *    so a future flip from "default-to-primitives" to "hard-reject" can
   *    distinguish "valid value supplied" vs "we filled it in for you".
   */
  tierWarnings: string[];
}

export interface TierParseResult {
  tier: StoryTier;
  warnings: string[];
  /** True if the proposal had no recognizable `## Tier` section. */
  missing: boolean;
}

/**
 * Parse the tier value out of a proposal.md body. Looks for a top-level
 * `## Tier` heading (case-insensitive) and reads the first non-empty line
 * after it. Optional trailing text on subsequent lines is treated as a
 * human-readable justification and ignored by the parser.
 *
 * Grace-window behavior: missing `## Tier` returns `primitives` with a
 * deprecation warning. A follow-up will flip this to a hard error once all
 * in-flight proposals are retro-tagged. Invalid values always throw.
 */
export function parseTier(proposalContent: string): TierParseResult {
  const warnings: string[] = [];
  // Split into lines; locate `## Tier` heading, allow trailing whitespace.
  const lines = proposalContent.split(/\r?\n/);
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Tier\s*$/i.test(lines[i] ?? "")) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) {
    warnings.push(
      "proposal.md missing `## Tier` section — defaulting to `primitives` during the 1-story grace window. " +
        "Add `## Tier` with one of: primitives, content, infra. " +
        "This default will be removed in a follow-up; see harness-tiering-and-holdout-guards.",
    );
    return { tier: "primitives", warnings, missing: true };
  }
  // Find the first non-empty line after the heading.
  let value = "";
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    // Stop scanning if we hit another `##` heading without finding a value.
    if (line.startsWith("##")) break;
    // Take only the first whitespace-separated token; allow `value — note` etc.
    value = line.split(/\s+/)[0]?.toLowerCase() ?? "";
    break;
  }
  if (value.length === 0) {
    throw new Error(
      `proposal.md has \`## Tier\` section but no value on a following non-empty line. Expected one of: ${VALID_TIERS.join(", ")}.`,
    );
  }
  if (!(VALID_TIERS as readonly string[]).includes(value)) {
    throw new Error(
      `proposal.md \`## Tier\` value "${value}" is not valid. Allowed: ${VALID_TIERS.join(", ")}.`,
    );
  }
  return { tier: value as StoryTier, warnings, missing: false };
}

export async function loadChange(openspecDir: string, name: string): Promise<ChangeFolder> {
  const path = join(openspecDir, "changes", name);
  if (!existsSync(path)) {
    throw new Error(`OpenSpec change not found: ${path}`);
  }
  const proposalPath = join(path, "proposal.md");
  const designPath = join(path, "design.md");
  const tasksPath = join(path, "tasks.md");
  const specsDir = join(path, "specs");
  const approvedSentinel = join(path, "approved");

  const proposal = await safeRead(proposalPath);
  if (proposal === null) {
    throw new Error(`Missing proposal.md in ${path}`);
  }

  const specs: { file: string; content: string }[] = [];
  if (existsSync(specsDir) && (await stat(specsDir)).isDirectory()) {
    for (const md of await walkMarkdown(specsDir)) {
      specs.push({
        file: relative(specsDir, md),
        content: await readFile(md, "utf8"),
      });
    }
  }

  const tierResult = parseTier(proposal);

  return {
    name,
    path,
    proposal,
    design: (await safeRead(designPath)) ?? undefined,
    specs,
    tasks: (await safeRead(tasksPath)) ?? undefined,
    approved: existsSync(approvedSentinel),
    tier: tierResult.tier,
    tierWarnings: tierResult.warnings,
  };
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

async function safeRead(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}
