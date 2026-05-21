#!/usr/bin/env node
// Sync @baton-tools/harness's package.json version into every place that
// hardcodes it. Run automatically by `pnpm version-packages` so the synced
// files are committed alongside the changeset-driven version bump.
//
// Targets:
//   - packages/harness/plugin/.claude-plugin/plugin.json (.version)
//   - .claude-plugin/marketplace.json (.metadata.version + baton-harness entry's .version)
//   - packages/harness/plugin/skills/autonomous-harness/SKILL.md
//       (every `@baton-tools/harness@X.Y.Z` reference — used by npx invocations)
//   - packages/harness/plugin/commands/finish-story.md
//       (same npx invocation rewrite as the skill)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const HARNESS_PKG = resolve(repoRoot, "packages/harness/package.json");
const PLUGIN_MANIFEST = resolve(
  repoRoot,
  "packages/harness/plugin/.claude-plugin/plugin.json",
);
const MARKETPLACE = resolve(repoRoot, ".claude-plugin/marketplace.json");
const SKILL_MD = resolve(
  repoRoot,
  "packages/harness/plugin/skills/autonomous-harness/SKILL.md",
);
const FINISH_STORY_MD = resolve(
  repoRoot,
  "packages/harness/plugin/commands/finish-story.md",
);
const PLUGIN_NAME = "baton-harness";

// SemVer-ish pattern. Matches X.Y.Z and X.Y.Z-prerelease forms. Conservative on
// purpose — only rewrites things that look like a baton version we wrote.
const NPX_REF_PATTERN = /(@baton-tools\/harness@)([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g;

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, obj) =>
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");

const rel = (p) => relative(repoRoot, p);

const harness = readJson(HARNESS_PKG);
const version = harness.version;
if (!version) {
  console.error(`[sync-plugin-version] no "version" in ${rel(HARNESS_PKG)}`);
  process.exit(1);
}

// --- JSON targets ---------------------------------------------------------

const plugin = readJson(PLUGIN_MANIFEST);
const marketplace = readJson(MARKETPLACE);

const before = {
  plugin: plugin.version,
  marketplaceMeta: marketplace.metadata?.version,
};

plugin.version = version;
marketplace.metadata = { ...(marketplace.metadata ?? {}), version };

const entry = (marketplace.plugins ?? []).find((p) => p.name === PLUGIN_NAME);
if (!entry) {
  console.error(
    `[sync-plugin-version] no plugin entry "${PLUGIN_NAME}" in ${rel(MARKETPLACE)}`,
  );
  process.exit(1);
}
const beforeEntry = entry.version;
entry.version = version;

writeJson(PLUGIN_MANIFEST, plugin);
writeJson(MARKETPLACE, marketplace);

// --- Markdown targets (npx version references) ----------------------------

function rewriteNpxRefs(filePath) {
  const original = readFileSync(filePath, "utf8");
  let hits = 0;
  const found = new Set();
  const next = original.replace(NPX_REF_PATTERN, (_match, prefix, oldVer) => {
    hits++;
    found.add(oldVer);
    return `${prefix}${version}`;
  });
  if (hits === 0) {
    console.error(
      `[sync-plugin-version] no @baton-tools/harness@X.Y.Z reference found in ${rel(filePath)} — refusing to no-op silently`,
    );
    process.exit(1);
  }
  if (next !== original) writeFileSync(filePath, next);
  return { hits, found: [...found] };
}

const skillSync = rewriteNpxRefs(SKILL_MD);
const finishSync = rewriteNpxRefs(FINISH_STORY_MD);

// --- Report ---------------------------------------------------------------

console.log(`[sync-plugin-version] target version -> ${version}`);
console.log(`  ${rel(PLUGIN_MANIFEST)}`);
console.log(`     .version:                 ${before.plugin} -> ${version}`);
console.log(`  ${rel(MARKETPLACE)}`);
console.log(`     metadata.version:         ${before.marketplaceMeta} -> ${version}`);
console.log(`     plugins[${PLUGIN_NAME}].version: ${beforeEntry} -> ${version}`);
console.log(`  ${rel(SKILL_MD)}`);
console.log(
  `     npx refs rewritten: ${skillSync.hits} (was: ${skillSync.found.join(", ") || "—"})`,
);
console.log(`  ${rel(FINISH_STORY_MD)}`);
console.log(
  `     npx refs rewritten: ${finishSync.hits} (was: ${finishSync.found.join(", ") || "—"})`,
);
