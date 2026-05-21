/**
 * Post-processing helpers run by `harness finish` after `openspec archive`.
 *
 * - seedPurpose: fill TBD stub in archived spec Purpose with proposal Why text
 * - normalizeMarkdownSpacing: blank lines around ## Requirements; trim trailing
 * - pruneBacklogEntries: remove INBOX entries completed by a finished story
 * - finishPostProcess: full post-processing pipeline with injected cwd and exec
 */

import { existsSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// seedPurpose
// ---------------------------------------------------------------------------

const TBD_PREFIX = "TBD - created by archiving change ";
const TBD_SUFFIX = ". Update Purpose after archive.";

/**
 * Replace the TBD stub inside `## Purpose` with the first paragraph of the
 * proposal's `## Why` section, truncated to 400 chars + `...`.
 *
 * Returns the spec unchanged when:
 * - there is no `## Purpose` section, OR
 * - the Purpose body is not the TBD stub, OR
 * - the proposal has no `## Why` section.
 */
export function seedPurpose(spec: string, proposal: string, _changeName: string): string {
  // Find ## Purpose section and extract its body (everything until the next ##).
  // Accept any number of newlines after the heading — openspec archive emits
  // `## Purpose\n<TBD_STUB>` (single newline) while canonical-spec authors use
  // `## Purpose\n\n<body>` (blank-line separated). Both forms must match.
  const purposeMatch = spec.match(/## Purpose\n+([\s\S]*?)(?=\n## |\n# |$)/);
  if (!purposeMatch) return spec;

  const purposeBody = purposeMatch[1].trimEnd();

  // Check if the body is the TBD stub.
  if (!purposeBody.startsWith(TBD_PREFIX) || !purposeBody.endsWith(TBD_SUFFIX)) {
    return spec;
  }

  // Extract the first paragraph from proposal ## Why section.
  const whyMatch = proposal.match(/## Why\n\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!whyMatch) return spec;

  const whyBody = whyMatch[1].trimEnd();
  // First paragraph = text before the first double-newline.
  const firstParagraph = whyBody.split(/\n\n/)[0].trim();
  if (!firstParagraph) return spec;

  // Truncate to 400 chars.
  const purposeText =
    firstParagraph.length > 400 ? `${firstParagraph.slice(0, 400)}...` : firstParagraph;

  // Replace just the stub text (preserving surrounding structure).
  return spec.replace(purposeBody, purposeText);
}

// ---------------------------------------------------------------------------
// normalizeMarkdownSpacing
// ---------------------------------------------------------------------------

/**
 * Ensure `## Requirements` has a blank line above AND below it, collapse
 * multiple trailing blank lines to a single terminating newline. Idempotent.
 */
export function normalizeMarkdownSpacing(input: string): string {
  let result = input;

  // Same MD022 normalization applied to both `## Purpose` and `## Requirements`.
  // `## Purpose` is covered because openspec archive emits `## Purpose\n<body>`
  // with no blank line below the heading, which seedPurpose leaves intact.
  for (const heading of ["## Purpose", "## Requirements"] as const) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`([^\\n])\\n(${escaped})`, "g"), "$1\n\n$2");
    result = result.replace(new RegExp(`(${escaped})\\n([^\\n])`, "g"), "$1\n\n$2");
  }

  // Collapse multiple trailing blank lines to a single terminating newline.
  result = result.replace(/\n{2,}$/, "\n");

  return result;
}

// ---------------------------------------------------------------------------
// parseArchiveTimeCleanup
// ---------------------------------------------------------------------------

/**
 * Extract INBOX entry titles from an archived tasks.md's `## Archive-time
 * cleanup` section. The section contains bullet lines of the form:
 *
 *   - [ ] Remove INBOX entry: "<exact title>"
 *   - [x] Remove INBOX entry: "<exact title>"
 *   - [ ] Remove BACKLOG entry: "<exact title>"
 *   - [x] Remove BACKLOG entry: "<exact title>"
 *
 * Both unchecked and checked boxes are honored. Returns `[]` when the section
 * is absent or contains no matching bullet lines.
 */
export function parseArchiveTimeCleanup(tasksContent: string): string[] {
  // Accept both numbered (`## 9. Archive-time cleanup`) and unnumbered
  // (`## Archive-time cleanup`) headings. Anchor to line start so deeper
  // headings like `### Archive-time cleanup` do not match. Deliberately
  // omits the `m` flag so `$` in the lookahead matches end-of-string only
  // (with `m`, `$` also matches before every `\n`, which truncated the body
  // to the first line).
  const sectionMatch = tasksContent.match(
    /(?:^|\n)## (?:\d+\.\s+)?Archive-time cleanup\s*\n([\s\S]*?)(?=\n## |\n# |$)/,
  );
  if (!sectionMatch) return [];

  const body = sectionMatch[1];
  const titles: string[] = [];
  // Allow an optional numbered-sub-item prefix between the checkbox and
  // "Remove INBOX/BACKLOG entry:" — e.g. `- [ ] 6.1 Remove INBOX entry: "X"`
  // or `- [x] 9.1.2 Remove BACKLOG entry: "Y"`.
  const bulletRe =
    /^- \[[ xX]\](?:\s+\d+(?:\.\d+)*)?\s+Remove (?:INBOX|BACKLOG) entry: "([^"]+)"/gm;
  for (const match of body.matchAll(bulletRe)) {
    titles.push(match[1]);
  }
  return titles;
}

// ---------------------------------------------------------------------------
// pruneBacklogEntries
// ---------------------------------------------------------------------------

export interface PruneResult {
  content: string;
  removed: string[];
}

/**
 * Parse INBOX entries split on `### <title>` headings. Remove entries where:
 * 1. title is in explicitTitles, OR
 * 2. the heading line or first non-blank body line literally states
 *    `COMPLETED by <storyName>`.
 *
 * Source/provenance lines are intentionally ignored. They often name the story
 * that discovered a follow-up, which does not mean the follow-up should
 * disappear when that story archives.
 */
export function pruneBacklogEntries(
  backlog: string,
  storyName: string,
  explicitTitles: string[],
): PruneResult {
  const removed: string[] = [];

  // Split on `### ` heading boundaries while keeping the delimiter so we can
  // reconstruct without losing text before the first entry.
  const parts = backlog.split(/(?=^### )/m);

  const kept: string[] = [];
  for (const part of parts) {
    if (!part.startsWith("### ")) {
      kept.push(part);
      continue;
    }

    // Extract the title from the heading line.
    const headingMatch = part.match(/^### (.+)/);
    if (!headingMatch) {
      kept.push(part);
      continue;
    }
    const title = headingMatch[1].trim();

    const completedMarker = `COMPLETED by ${storyName}`;
    const firstBodyLine = part
      .split("\n")
      .slice(1)
      .find((line) => line.trim().length > 0)
      ?.trim();

    // Determine if this entry should be removed.
    let shouldRemove = false;

    if (explicitTitles.includes(title)) {
      shouldRemove = true;
    } else if (
      headingMatch[0].includes(completedMarker) ||
      firstBodyLine?.includes(completedMarker)
    ) {
      shouldRemove = true;
    }

    if (shouldRemove) {
      removed.push(title);
    } else {
      kept.push(part);
    }
  }

  return { content: kept.join(""), removed };
}

// ---------------------------------------------------------------------------
// finishPostProcess types
// ---------------------------------------------------------------------------

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export interface FinishPostProcessOptions {
  story: string;
  openspecDir: string;
  cwd: string;
  exec: ExecFn;
}

export interface PostProcessReport {
  processedSpecs: string[];
  prunedBacklogEntries: string[];
  deletedArtifacts: string[];
}

// ---------------------------------------------------------------------------
// finishPostProcess
// ---------------------------------------------------------------------------

export async function finishPostProcess(
  opts: FinishPostProcessOptions,
): Promise<PostProcessReport> {
  const { story, openspecDir, cwd, exec } = opts;

  // Find the archived change folder (archive/<timestamp>-<story>/).
  const archiveDir = join(cwd, openspecDir, "changes", "archive");
  let archivedChangeDir: string | null = null;
  if (existsSync(archiveDir)) {
    const entries = await readdir(archiveDir);
    const match = entries.find((e) => e.endsWith(`-${story}`) || e === story);
    if (match) archivedChangeDir = join(archiveDir, match);
  }

  // Read proposal for seedPurpose.
  let proposalContent = "";
  if (archivedChangeDir) {
    const proposalPath = join(archivedChangeDir, "proposal.md");
    if (existsSync(proposalPath)) {
      proposalContent = await readFile(proposalPath, "utf8");
    }
  }

  // Discover live spec targets. `git status --porcelain --untracked-files=all`
  // catches modified-tracked specs AND newly-created untracked specs in a
  // single call — important because `openspec archive` can create brand-new
  // live spec files for greenfield capabilities, which a plain `git diff`
  // against the index would miss.
  //
  // NUL-delimited porcelain avoids the v1 default path-quoting that would
  // otherwise ENOENT on capability slugs with spaces/non-ASCII.
  const pathspec = `:(glob)${openspecDir}/specs/**/spec.md`;
  const { stdout: statusOut } = await exec(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "-z", "--", pathspec],
    { cwd },
  );
  const specFiles: string[] = [];
  // Records are NUL-separated; no trailing NUL after the last record.
  const records = statusOut.split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    // Each record is `XY path` — two status chars, one space, then raw path.
    if (record.length < 3) continue;
    const xy = record.slice(0, 2);
    const rel = record.slice(3);
    if (xy === "!!") continue;
    // Deletion: live spec no longer exists, nothing to post-process.
    if (xy[0] === "D" || xy[1] === "D") continue;
    // Rename/copy (R/C): the NEXT record is the paired OLD path. Consume it
    // and treat the current record's path as the target.
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      i++;
    }
    if (!rel) continue;
    specFiles.push(join(cwd, rel));
  }

  // Process each spec.md.
  const processedSpecs: string[] = [];
  for (const specPath of specFiles) {
    let content = await readFile(specPath, "utf8");
    content = seedPurpose(content, proposalContent, story);
    content = normalizeMarkdownSpacing(content);
    await writeFile(specPath, content, "utf8");
    processedSpecs.push(specPath);
  }

  // Parse explicit `## Archive-time cleanup` directives from the archived tasks.md.
  const explicitTitles: string[] = [];
  if (archivedChangeDir) {
    const tasksPath = join(archivedChangeDir, "tasks.md");
    if (existsSync(tasksPath)) {
      const tasksContent = await readFile(tasksPath, "utf8");
      explicitTitles.push(...parseArchiveTimeCleanup(tasksContent));
    }
  }

  // Prune the inbox file. INBOX.md is the sole active follow-up surface.
  const inboxPath = join(cwd, "INBOX.md");
  let prunedBacklogEntries: string[] = [];
  if (existsSync(inboxPath)) {
    const backlogContent = await readFile(inboxPath, "utf8");
    const { content: prunedContent, removed } = pruneBacklogEntries(
      backlogContent,
      story,
      explicitTitles,
    );
    if (removed.length > 0) {
      await writeFile(inboxPath, prunedContent, "utf8");
      prunedBacklogEntries = removed;
    }
  }

  // Delete root-level review artifacts.
  const deletedArtifacts: string[] = [];
  for (const artifact of [
    "diff-summaries.json",
    "review-summary.json",
    "holdout-validation.json",
  ]) {
    const p = join(cwd, artifact);
    if (existsSync(p)) {
      await unlink(p);
      deletedArtifacts.push(p);
    }
  }

  // Stage explicit paths only — never sweep with `git add -A` (no pathspec)
  // because untracked sibling change folders (e.g. parallel-session work in
  // `openspec/changes/<other-story>/` that hasn't been committed to its own
  // branch yet) would be folded into this archive commit. We know exactly
  // which paths finishPostProcess and ensureChangeArchived can have touched:
  //   - the story's change folder (deletion at the old path; addition at the
  //     new archive path — `git add -A -- <path>` handles both for tracked content)
  //   - each modified spec file
  //   - INBOX.md (only if pruned)
  //   - each deleted root-level review artifact
  try {
    // The change-folder transition gets its own try block: in the
    // archive-fallback path, `git mv` already staged the move; in the
    // openspec-CLI-moved path, the old location's tracked files need their
    // deletion staged. Either way, a missing pathspec match (e.g. the path
    // was never tracked, as in some test fixtures) is benign — silence the
    // error so the rest of the staging still runs.
    const changeFolderPaths: string[] = [
      join(cwd, openspecDir, "changes", story),
      ...(archivedChangeDir ? [archivedChangeDir] : []),
    ];
    for (const p of changeFolderPaths) {
      try {
        await exec("git", ["add", "-A", "--", p], { cwd });
      } catch {
        // Pathspec didn't match (path never tracked + not on disk). Benign.
      }
    }

    const otherPaths: string[] = [
      ...processedSpecs,
      ...(prunedBacklogEntries.length > 0 ? [inboxPath] : []),
      ...deletedArtifacts,
    ];
    if (otherPaths.length > 0) {
      await exec("git", ["add", "-A", "--", ...otherPaths], { cwd });
    }
    const { stdout: commitStatusOut } = await exec("git", ["status", "--porcelain"], { cwd });
    if (commitStatusOut.trim().length > 0) {
      await exec("git", ["commit", "-m", `openspec(archive): ${story}`], { cwd });
    }
  } catch (err) {
    console.log(
      `[WARN] post-process commit skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { processedSpecs, prunedBacklogEntries, deletedArtifacts };
}
