/**
 * Holdout antipattern validator.
 *
 * Static scan over a generated holdout suite that flags the three documented
 * antipatterns from `feedback_holdout_antipatterns.md`:
 *
 *   1. type-check-stub:        a runtime-dereferenced type-check stub
 *                              (e.g. `declare const _x: T; _x.field` or
 *                              `const _x = null as unknown as T; _x.field`)
 *
 *   2. over-constrained-extractor:
 *                              a holdout's path filter / mock target is more
 *                              specific than the file paths listed in the
 *                              proposal's `## Impact` section. (Pragmatic
 *                              symptom-detection — see comment on the
 *                              `detectOverConstrainedExtractor` function for
 *                              the limitation.)
 *
 *   3. hardcoded-path:         absolute paths starting with `/Users/`,
 *                              `/home/`, `/tmp/<user>`, or hand-counted
 *                              `path.resolve(__dirname, "../../../..")`
 *                              cascades.
 *
 * False positives are tolerable (operator can re-read and override); false
 * negatives are tolerable (this is a defense-in-depth gate, not the only
 * line). The validator emits a JSON report; non-empty `violations` array
 * means the orchestrator must regenerate before proceeding.
 */

import { readFile } from "node:fs/promises";

export type HoldoutViolationKind =
  | "type-check-stub"
  | "over-constrained-extractor"
  | "hardcoded-path";

export interface HoldoutViolation {
  file: string;
  kind: HoldoutViolationKind;
  line?: number;
  reason: string;
}

export type HoldoutValidationScope = "repo" | "story";

export interface HoldoutValidationReport {
  passed: boolean;
  violations: HoldoutViolation[];
  filesScanned: number;
  /**
   * The scope under which this validation ran. `repo` (default) scans every
   * tracked file matched by `config.holdouts.paths`; `story` scans only files
   * added or modified on the story branch relative to the configured base.
   * Optional for backwards compatibility with reports written before the
   * field existed.
   */
  scope?: HoldoutValidationScope;
}

export interface ValidateHoldoutSuiteOpts {
  /**
   * Optional content of the proposal's `## Impact` section. Used only by the
   * over-constrained-extractor heuristic. If absent or unparseable, the
   * detector returns clean for that file (we lack ground truth).
   */
  proposalImpact?: string;
}

/**
 * Scan each absolute holdout file path and accumulate violations.
 */
export async function validateHoldoutSuite(
  paths: readonly string[],
  opts: ValidateHoldoutSuiteOpts = {},
): Promise<HoldoutValidationReport> {
  const violations: HoldoutViolation[] = [];
  for (const path of paths) {
    const content = await readFile(path, "utf8");
    violations.push(...detectTypeCheckStub(path, content));
    violations.push(...detectHardcodedPath(path, content));
    violations.push(...detectOverConstrainedExtractor(path, content, opts.proposalImpact));
  }
  return { passed: violations.length === 0, violations, filesScanned: paths.length };
}

// ---------------------------------------------------------------------------
// Detector 1: type-check stubs that dereference at runtime
// ---------------------------------------------------------------------------

/**
 * Two known patterns:
 *   (a) `declare const _x: T;` followed by a `_x.field` reference
 *   (b) `const _x = null as unknown as T;` followed by a `_x.field` reference
 *
 * Implementation: regex over the file. Find each `declare const NAME: …;`
 * (or `const NAME = null as unknown as …;`), record NAME and the line, then
 * scan the rest of the file for `NAME.<ident>` (dereference). If found,
 * flag.
 *
 * Tolerated: NAME used as a function argument (`fn(NAME)`), `expect(NAME)`,
 * etc. — a property access (`NAME.foo`) is the trigger.
 */
function detectTypeCheckStub(path: string, content: string): HoldoutViolation[] {
  const violations: HoldoutViolation[] = [];
  const lines = content.split(/\r?\n/);
  // Pattern (a): `declare const _foo: SomeType;`
  // Pattern (b): `const _foo = null as unknown as SomeType;`
  const declRe =
    /^\s*(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+;|=\s*null\s+as\s+unknown\s+as\b[^;]+;)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(declRe);
    if (!m) continue;
    const name = m[1];
    if (!name) continue;
    // Heuristic: only flag stub-like names — leading underscore or `Stub`/`fake`
    // suffix. Avoids matching real `const player = null as unknown as Player`
    // that was meant for adversarial null-input tests where the value never
    // gets dereferenced. We separately verify dereference below.
    const looksLikeStub = name.startsWith("_") || /[Ss]tub|[Ff]ake|[Mm]ock/.test(name);
    if (!looksLikeStub) continue;
    // Scan rest of the file for `<name>.<ident>` dereference.
    const derefRe = new RegExp(`\\b${escapeRegex(name)}\\.[A-Za-z_$]`);
    for (let j = i + 1; j < lines.length; j++) {
      const tail = lines[j] ?? "";
      if (derefRe.test(tail)) {
        violations.push({
          file: path,
          kind: "type-check-stub",
          line: j + 1,
          reason:
            `runtime dereference of type-check stub \`${name}\` declared at line ${i + 1}. ` +
            `Use expectTypeOf<T>().toEqualTypeOf<...>(), an unreachable function _typeCheck() { ... }, or a type-level conditional check.`,
        });
        break;
      }
    }
  }
  return violations;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Detector 2: over-constrained extractors
// ---------------------------------------------------------------------------

/**
 * LIMITATION: today's proposals don't carry a structured `scope` field. The
 * spec authorizes us to compare extractors against "the proposal's declared
 * scope," but the only structured place to look is the `## Impact` section's
 * file list. We therefore detect the *symptom*: a holdout that opens or
 * imports a file path narrower than any of those listed.
 *
 * Concrete heuristic: extract path-like literals from the holdout file
 * (string-quoted strings ending in a known source extension), then check
 * whether each one is a strict subdirectory or sub-glob of a path listed in
 * the proposal's Impact. If a holdout names `src/engine/foo/bar.ts` but the
 * Impact only authorizes `src/engine/`, we let it through (narrower-than is
 * fine when the proposal's scope is broader). If a holdout's path filter
 * extends OUTSIDE the proposal's listed paths entirely, that's flagged.
 *
 * If `proposalImpact` is empty/missing, the detector returns clean — we lack
 * ground truth.
 *
 * BACKLOG: refine this once proposals get a structured `scope` field. Until
 * then this detector mostly catches "holdout points at a file the proposal
 * never mentioned," not the deeper "regex too broad" symptom.
 */
function detectOverConstrainedExtractor(
  path: string,
  content: string,
  proposalImpact: string | undefined,
): HoldoutViolation[] {
  if (!proposalImpact || proposalImpact.trim().length === 0) {
    return [];
  }
  const authorized = extractAuthorizedPaths(proposalImpact);
  if (authorized.length === 0) return [];
  const referenced = extractReferencedPaths(content);
  const violations: HoldoutViolation[] = [];
  for (const ref of referenced) {
    if (isCovered(ref.value, authorized)) continue;
    violations.push({
      file: path,
      kind: "over-constrained-extractor",
      line: ref.line,
      reason:
        `holdout references "${ref.value}" but the proposal's \`## Impact\` only authorizes paths under ` +
        `${authorized
          .slice(0, 4)
          .map((a) => `"${a}"`)
          .join(", ")}${authorized.length > 4 ? ", …" : ""}. ` +
        `Either narrow the holdout to an authorized path or expand the proposal's Impact section.`,
    });
  }
  return violations;
}

/** Pull backtick-quoted paths from a proposal Impact section. */
function extractAuthorizedPaths(impact: string): string[] {
  const out = new Set<string>();
  const re = /`([^`]+\.[a-zA-Z0-9]+|[^`]+\/)`/g;
  for (const match of impact.matchAll(re)) {
    const v = (match[1] ?? "").trim();
    // Skip things that look like commands (`npm run …`) or non-paths.
    if (v.includes(" ") || !v.includes("/")) continue;
    out.add(stripGlob(v));
  }
  return [...out];
}

function stripGlob(p: string): string {
  return p.replace(/\*+/g, "").replace(/\{[^}]+\}/g, "");
}

function extractReferencedPaths(content: string): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  const lines = content.split(/\r?\n/);
  // Only look at quoted string literals containing a `/` and ending in a
  // src/data/i18n-ish extension or trailing slash.
  const re = /["'`](src\/[\w./-]+|tools\/[\w./-]+|shared\/[\w./-]+|e2e\/[\w./-]+)["'`]/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const match of line.matchAll(re)) {
      const v = (match[1] ?? "").trim();
      if (v.length === 0) continue;
      out.push({ value: v, line: i + 1 });
    }
  }
  return out;
}

function isCovered(ref: string, authorized: string[]): boolean {
  for (const a of authorized) {
    // If `a` ends with a path separator, treat as a directory prefix.
    // Otherwise require exact match (file).
    if (a.endsWith("/")) {
      if (ref === a.slice(0, -1) || ref.startsWith(a)) return true;
    } else {
      if (ref === a) return true;
      // Allow ref to be a prefix-extension of a file path's directory:
      // authorized "src/engine/foo.ts" implies "src/engine/" is authorized.
      const dir = a.slice(0, a.lastIndexOf("/") + 1);
      if (ref.startsWith(dir)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Detector 3: hardcoded paths
// ---------------------------------------------------------------------------

/**
 * Two flavors:
 *   (a) absolute user-specific paths (`/Users/<name>/...`, `/home/<name>/...`)
 *   (b) hand-counted `path.resolve(__dirname, "../../../..")` cascades — any
 *       chain of three or more `..` segments is suspicious enough to flag.
 *
 * Tolerated: `/tmp/something` (legitimate temp-dir scratch); short relative
 * paths.
 */
function detectHardcodedPath(path: string, content: string): HoldoutViolation[] {
  const violations: HoldoutViolation[] = [];
  const lines = content.split(/\r?\n/);
  const userPathRe = /["'`](\/Users\/[^"'`]+|\/home\/[a-zA-Z0-9_-]+\/[^"'`]+)["'`]/;
  const dotDotCascadeRe =
    /(?:["'`])(?:\.\.\/){3,}[^"'`]*["'`]|path\.resolve\([^)]*(?:["'`])(?:\.\.\/){3,}/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (userPathRe.test(line)) {
      violations.push({
        file: path,
        kind: "hardcoded-path",
        line: i + 1,
        reason:
          "absolute user-specific path detected (`/Users/...` or `/home/<user>/...`). Use a marker-file walk-up to find the repo root instead.",
      });
      continue;
    }
    if (dotDotCascadeRe.test(line)) {
      violations.push({
        file: path,
        kind: "hardcoded-path",
        line: i + 1,
        reason:
          "hand-counted `../../../..` path cascade detected. Walk up to a marker file (e.g. `package.json`) instead — robust to test relocation and worktree variations.",
      });
    }
  }
  return violations;
}
