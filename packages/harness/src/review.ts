/**
 * Static review page generator.
 *
 * Reads the OpenSpec change folder + the worktree's git state + the
 * HARNESS_RESULT.md and emits a single self-contained HTML file at
 * `.claude/reviews/<story>.html`, then opens it in the default browser.
 *
 * Deliberately static — no server, no actions. "Accept" is a code block
 * the user copies; "reject" means closing the tab and coming back here.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { marked } from "marked";
import { loadConfig } from "./config-loader.js";
import { loadChange } from "./openspec.js";
import type { ReviewSummary } from "./types.js";

export type { ReviewSummary };

const exec = promisify(execFile);

export async function generateReview(story: string): Promise<string> {
  const config = await loadConfig();
  const change = await loadChange(config.openspecDir, story);
  const worktree = join(config.worktreeDir, story);
  const branch = `${config.git.branchPrefix}${story}`;

  if (!existsSync(worktree)) {
    throw new Error(`worktree missing: ${worktree}`);
  }

  const [result, commits, diff, logs, summaryRaw, diffSummariesRaw] = await Promise.all([
    readOptional(join(worktree, "HARNESS_RESULT.md")),
    gitCommits(worktree, config.git.baseBranch),
    gitDiff(worktree, config.git.baseBranch),
    readOptional(join(config.logDir, `${story}.jsonl`)),
    readOptional(join(worktree, "review-summary.json")),
    readOptional(join(worktree, "diff-summaries.json")),
  ]);
  const summary = summaryRaw ? (JSON.parse(summaryRaw) as ReviewSummary) : null;
  const diffSummaries: Record<string, string> = diffSummariesRaw
    ? (JSON.parse(diffSummariesRaw) as Record<string, string>)
    : {};

  const plan = await readOptional(join(change.path, "plan.md"));
  const specsBlock = change.specs.map((s) => `### ${s.file}\n\n${s.content}`).join("\n\n---\n\n");

  const diffHtml = renderDiff(diff, config.holdouts.markerComment, diffSummaries);
  const logsTable = renderLogs(logs);

  const html = renderHtml({
    story,
    branch,
    worktree: relative(process.cwd(), worktree),
    result: result ?? "_No HARNESS_RESULT.md yet — run has not completed._",
    proposal: change.proposal,
    design: change.design ?? "_(no design.md)_",
    plan: plan ?? "_(no plan.md yet — harness hasn't planned this story)_",
    specs: specsBlock || "_(no specs)_",
    commits,
    diffHtml,
    logsTable,
    baseBranch: config.git.baseBranch,
    summary,
  });

  const reviewsDir = ".claude/reviews";
  await mkdir(reviewsDir, { recursive: true });
  const outPath = join(reviewsDir, `${story}.html`);
  await writeFile(outPath, html, "utf8");
  return outPath;
}

async function readOptional(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

async function gitCommits(
  cwd: string,
  baseBranch: string,
): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const { stdout } = await exec("git", ["log", "--format=%H%x00%s", `${baseBranch}..HEAD`], {
      cwd,
    });
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\0");
        return { sha, subject };
      });
  } catch {
    return [];
  }
}

async function gitDiff(cwd: string, baseBranch: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["diff", `${baseBranch}...HEAD`], {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

function renderDiff(
  diff: string,
  holdoutMarker: string,
  summaries: Record<string, string>,
): string {
  if (!diff.trim()) return "<p><em>No diff.</em></p>";

  // Split into per-file chunks on `diff --git` headers.
  const chunks = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const parts: string[] = [];
  for (const chunk of chunks) {
    const firstLine = chunk.split("\n", 1)[0];
    const match = /^diff --git a\/(.+?) b\//.exec(firstLine);
    const path = match ? match[1] : firstLine;
    const isHoldout = chunk.includes(holdoutMarker) || /\.holdout\.(test|spec)\.ts\b/.test(path);
    const body = escapeHtml(chunk).split("\n").map(colorLine).join("\n");
    const openAttr = isHoldout ? "" : " open";
    const tag = isHoldout ? ` <span class="holdout-tag">frozen holdout</span>` : "";
    const summaryMd = summaries[path];
    const summaryHtml = summaryMd
      ? `<aside class="diff-why markdown">${marked.parse(summaryMd) as string}</aside>`
      : "";
    parts.push(
      `<details${openAttr} class="diff-file"><summary><code>${escapeHtml(path)}</code>${tag}</summary><pre class="diff"><code>${body}</code></pre>${summaryHtml}</details>`,
    );
  }
  return parts.join("\n");
}

function colorLine(line: string): string {
  if (/^@@/.test(line)) return `<span class="hunk">${line}</span>`;
  if (/^\+\+\+/.test(line) || /^---/.test(line)) return `<span class="file-hdr">${line}</span>`;
  if (/^\+/.test(line)) return `<span class="add">${line}</span>`;
  if (/^-/.test(line)) return `<span class="del">${line}</span>`;
  return line;
}

function renderLogs(logs: string | null): string {
  if (!logs) return "<p><em>No harness log yet.</em></p>";
  const rows = logs
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const obj = JSON.parse(line);
        const ts = typeof obj.ts === "string" ? obj.ts : "";
        const phase = typeof obj.phase === "string" ? obj.phase : "";
        const rest = Object.keys(obj)
          .filter((k) => k !== "ts" && k !== "phase")
          .map((k) => `${k}=${JSON.stringify(obj[k])}`)
          .join(" ");
        return `<tr><td>${escapeHtml(ts)}</td><td><code>${escapeHtml(phase)}</code></td><td>${escapeHtml(rest)}</td></tr>`;
      } catch {
        return `<tr><td colspan="3"><code>${escapeHtml(line)}</code></td></tr>`;
      }
    })
    .join("");
  return `<table class="logs"><thead><tr><th>Time</th><th>Phase</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface RenderInput {
  story: string;
  branch: string;
  worktree: string;
  result: string;
  proposal: string;
  design: string;
  plan: string;
  specs: string;
  commits: Array<{ sha: string; subject: string }>;
  diffHtml: string;
  logsTable: string;
  baseBranch: string;
  summary: ReviewSummary | null;
}

function renderVerdict(s: ReviewSummary | null): string {
  if (!s) {
    return '<div class="verdict verdict-unknown"><div class="verdict-label">No verdict</div><div class="verdict-reason">Run <code>review-summary.json</code> missing in the worktree — either the harness has not finished or the orchestrator did not write a summary.</div></div>';
  }
  const gatesList = Object.entries(s.gates)
    .map(([k, v]) => `<span class="gate gate-${v}">${escapeHtml(k)}: ${v}</span>`)
    .join(" ");
  return `<div class="verdict verdict-${s.verdict}">
  <div class="verdict-header">
    <div class="verdict-label">${s.verdict.toUpperCase()}</div>
    <div class="verdict-confidence">confidence: <strong>${s.confidence}</strong></div>
    <div class="verdict-stats">
      attempts <strong>${s.attempts}</strong> ·
      findings <span class="finding-block">${s.findings.block} block</span>
      <span class="finding-warn">${s.findings.warn} warn</span>
      <span class="finding-info">${s.findings.info} info</span>
    </div>
  </div>
  <div class="verdict-reason">${escapeHtml(s.reasoning)}</div>
  <div class="verdict-gates">${gatesList}</div>
</div>`;
}

function renderHtml(i: RenderInput): string {
  const md = (s: string) => marked.parse(s) as string;
  const commitsList = i.commits.length
    ? `<ul class="commits">${i.commits
        .map((c) => `<li><code>${c.sha.slice(0, 7)}</code> ${escapeHtml(c.subject)}</li>`)
        .join("")}</ul>`
    : "<p><em>No commits on this branch.</em></p>";

  const acceptCmd = `npm run harness -- accept ${i.story}`;
  const rejectHint = `npm run harness -- unapprove ${i.story}   # then edit the spec and re-approve`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Review — ${escapeHtml(i.story)}</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --fg:#e8eaed; --muted:#9aa0a6; --border:#2a2d33; --accent:#8ab4f8; --add:#aed58155; --del:#f2837f55; --holdout:#3a2a48; --green:#3fb950; --yellow:#d29922; --red:#f85149; }
  .verdict { margin-top:1rem; border:1px solid var(--border); border-radius:6px; padding:1rem 1.25rem; }
  .verdict-green { border-left:6px solid var(--green); background:rgba(63,185,80,.06); }
  .verdict-yellow { border-left:6px solid var(--yellow); background:rgba(210,153,34,.06); }
  .verdict-red { border-left:6px solid var(--red); background:rgba(248,81,73,.06); }
  .verdict-unknown { border-left:6px solid var(--muted); background:#14171c; }
  .verdict-header { display:flex; flex-wrap:wrap; gap:1rem; align-items:baseline; margin-bottom:.5rem; }
  .verdict-label { font-size:1.3rem; font-weight:700; letter-spacing:.05em; }
  .verdict-green .verdict-label { color:var(--green); }
  .verdict-yellow .verdict-label { color:var(--yellow); }
  .verdict-red .verdict-label { color:var(--red); }
  .verdict-confidence { color:var(--muted); font-size:.9rem; }
  .verdict-stats { color:var(--muted); font-size:.85rem; margin-left:auto; }
  .verdict-stats strong { color:var(--fg); }
  .verdict-reason { margin:.5rem 0 .75rem; }
  .verdict-gates { display:flex; flex-wrap:wrap; gap:.5rem; font-size:.8rem; }
  .gate { padding:.15em .5em; border-radius:3px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .gate-pass { background:rgba(63,185,80,.15); color:var(--green); }
  .gate-fail { background:rgba(248,81,73,.15); color:var(--red); }
  .gate-skip { background:#2a2d33; color:var(--muted); }
  .finding-block { color:var(--red); }
  .finding-warn { color:var(--yellow); }
  .finding-info { color:var(--muted); }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { padding:1.25rem 2rem; border-bottom:1px solid var(--border); background:#181b21; }
  header h1 { margin:0 0 .25rem; font-size:1.3rem; }
  header .meta { color:var(--muted); font-size:.9rem; }
  header .meta code { background:#0b0d11; padding:.1em .4em; border-radius:3px; }
  main { max-width: 1100px; margin: 0 auto; padding: 1rem 2rem 4rem; }
  section { margin-top: 2rem; }
  section > h2 { border-bottom:1px solid var(--border); padding-bottom:.3rem; font-size:1.05rem; letter-spacing:.02em; text-transform:uppercase; color:var(--muted); }
  .actions { display:flex; gap:1rem; margin-top:1rem; flex-wrap:wrap; }
  .action-box { flex:1 1 360px; border:1px solid var(--border); border-radius:6px; padding:1rem; background:#14171c; }
  .action-box h3 { margin:0 0 .5rem; font-size:.95rem; }
  .action-box pre { background:#0b0d11; padding:.75rem; border-radius:4px; overflow-x:auto; margin:0; }
  .markdown code:not(pre code) { background:#14171c; padding:.1em .3em; border-radius:3px; }
  .markdown pre { background:#0b0d11; border:1px solid var(--border); padding:.75rem; border-radius:4px; overflow-x:auto; }
  .markdown h1, .markdown h2, .markdown h3 { margin-top:1.2em; }
  .markdown h1 { font-size:1.3rem; }
  .markdown h2 { font-size:1.1rem; }
  .markdown h3 { font-size:1rem; }
  .markdown blockquote { border-left:3px solid var(--accent); padding-left:.8rem; color:var(--muted); margin:0; }
  details { border:1px solid var(--border); border-radius:4px; padding:.5rem .75rem; margin:.4rem 0; background:#14171c; }
  details[open] { padding-bottom:.75rem; }
  summary { cursor:pointer; font-weight:600; }
  .diff { background:#0b0d11; padding:.75rem; border-radius:4px; overflow-x:auto; white-space:pre; font:12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border:1px solid var(--border); margin-top:.5rem; }
  .diff .add { background:var(--add); display:inline-block; width:100%; }
  .diff .del { background:var(--del); display:inline-block; width:100%; }
  .diff .hunk { color:var(--accent); }
  .diff .file-hdr { color:var(--muted); }
  .holdout-tag { background:var(--holdout); color:#cba6f7; padding:.1em .5em; border-radius:3px; font-size:.8rem; margin-left:.5rem; font-weight:400; }
  .diff-why { margin-top:.75rem; padding:.75rem 1rem; border-left:3px solid var(--accent); background:rgba(138,180,248,.06); border-radius:0 4px 4px 0; font-size:.9rem; color:var(--fg); }
  .diff-why::before { content:"Why this change is good"; display:block; font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--accent); font-weight:600; margin-bottom:.4rem; }
  .diff-why p:first-of-type { margin-top:0; }
  .diff-why p:last-child { margin-bottom:0; }
  ul.commits { list-style:none; padding:0; }
  ul.commits li { padding:.3rem 0; border-bottom:1px solid var(--border); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.85rem; }
  ul.commits code { color:var(--accent); }
  table.logs { width:100%; border-collapse:collapse; font-size:.85rem; }
  table.logs th, table.logs td { text-align:left; padding:.35rem .5rem; border-bottom:1px solid var(--border); vertical-align:top; }
  table.logs th { color:var(--muted); font-weight:500; text-transform:uppercase; letter-spacing:.02em; font-size:.75rem; }
  table.logs code { background:#0b0d11; padding:.1em .4em; border-radius:3px; }
  nav.toc { position:fixed; left:0; top:1rem; padding:1rem; font-size:.85rem; line-height:1.8; max-height:calc(100vh - 2rem); overflow-y:auto; }
  nav.toc a { color:var(--muted); text-decoration:none; display:block; }
  nav.toc a:hover { color:var(--fg); }
  @media (max-width: 1320px) { nav.toc { display:none; } }
  .verdict { margin-top:0; margin-bottom:1.5rem; }
</style>
</head>
<body>
<header>
  <h1>Review — ${escapeHtml(i.story)}</h1>
  <div class="meta">branch <code>${escapeHtml(i.branch)}</code> · worktree <code>${escapeHtml(i.worktree)}</code> · ${i.commits.length} commit(s)</div>
</header>
<nav class="toc">
  <a href="#result">Result</a>
  <a href="#actions">Actions</a>
  <a href="#proposal">Proposal</a>
  <a href="#design">Design</a>
  <a href="#plan">Plan</a>
  <a href="#specs">Specs</a>
  <a href="#commits">Commits</a>
  <a href="#diff">Diff</a>
  <a href="#logs">Logs</a>
</nav>
<main>

${renderVerdict(i.summary)}

<section id="result">
<h2>Result</h2>
<div class="markdown">${md(i.result)}</div>
</section>

<section id="actions">
<h2>Actions</h2>
<div class="actions">
  <div class="action-box">
    <h3>Accept & finish</h3>
    <pre><code>${escapeHtml(acceptCmd)}</code></pre>
  </div>
  <div class="action-box">
    <h3>Reject (iterate)</h3>
    <pre><code>${escapeHtml(rejectHint)}</code></pre>
  </div>
</div>
</section>

<section id="proposal">
<h2>Proposal</h2>
<div class="markdown">${md(i.proposal)}</div>
</section>

<section id="design">
<h2>Design</h2>
<div class="markdown">${md(i.design)}</div>
</section>

<section id="plan">
<h2>Plan</h2>
<div class="markdown">${md(i.plan)}</div>
</section>

<section id="specs">
<h2>Specs (the contract)</h2>
<div class="markdown">${md(i.specs)}</div>
</section>

<section id="commits">
<h2>Commits</h2>
${commitsList}
</section>

<section id="diff">
<h2>Diff (vs ${escapeHtml(i.baseBranch)})</h2>
${i.diffHtml}
</section>

<section id="logs">
<h2>Harness log</h2>
${i.logsTable}
</section>

</main>
</body>
</html>`;
}

export async function openInBrowser(path: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", path] : [path];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
