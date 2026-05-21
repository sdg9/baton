import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  HarnessConfig,
  HarnessModelConfig,
  HarnessModelSlug,
  ReviewerName,
  ReviewProfileSet,
} from "./types.js";
import { HarnessConfigError } from "./types.js";

// Config-file discovery order. First match in cwd wins. TS is the documented
// default (rich typed schema, comments, computation); JSON exists for repos
// that don't want a TS loader in their toolchain and is autocompleted via
// the published JSON Schema ($schema URL in the JSON template).
const CONFIG_FILENAMES = [
  "harness.config.ts",
  "harness.config.mts",
  "harness.config.mjs",
  "harness.config.js",
  "harness.config.cjs",
  "harness.config.jsonc",
  "harness.config.json",
] as const;

const JSON_EXTENSIONS = new Set([".json", ".jsonc"]);

function discoverConfigPath(cwd: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse a JSONC document (JSON + comments + trailing commas). We avoid
 * `JSON.parse` directly so users can leave inline notes next to regex/glob
 * fields. Implementation is intentionally tiny — strip line/block comments
 * and trailing commas, then JSON.parse. Pulled inline rather than depending
 * on jsonc-parser to keep the install footprint minimal.
 */
function parseJsonc(source: string, filePath: string): unknown {
  // Strip // line comments and /* block */ comments, preserving them inside
  // strings. This is a small state machine over the input.
  let out = "";
  let i = 0;
  const n = source.length;
  let inString: false | '"' | "'" = false;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === inString) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Strip trailing commas before } or ]
  const stripped = out.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HarnessConfigError(`failed to parse ${filePath}: ${msg}`);
  }
}

const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

async function loadConfigFile(absolute: string): Promise<unknown> {
  const ext = extname(absolute).toLowerCase();
  if (JSON_EXTENSIONS.has(ext)) {
    const text = readFileSync(absolute, "utf8");
    const data = parseJsonc(text, absolute);
    // Strip $schema metadata so downstream validators don't see an unknown key.
    if (data && typeof data === "object" && "$schema" in data) {
      delete (data as Record<string, unknown>).$schema;
    }
    return data;
  }
  if (TS_EXTENSIONS.has(ext)) {
    // Use tsx's per-call API rather than node's bare `import()`, which only
    // accepts .ts on Node >=22.6 with --experimental-strip-types (default in
    // >=23.6). tsx is declared as a runtime dep of @baton-tools/harness so
    // .ts configs work on any supported Node version.
    let tsImport: (specifier: string, parentURL: string) => Promise<unknown>;
    try {
      ({ tsImport } = (await import("tsx/esm/api")) as {
        tsImport: typeof tsImport;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HarnessConfigError(
        `cannot load ${absolute}: tsx runtime dependency is missing (${msg}).\n` +
          `  Fix one of:\n` +
          `    • reinstall @baton-tools/harness (tsx is a runtime dep)\n` +
          `    • rename to harness.config.json (see https://unpkg.com/@baton-tools/harness/schema.json)`,
      );
    }
    const mod = await tsImport(pathToFileURL(absolute).href, import.meta.url);
    return unwrapDefault(mod);
  }
  // .mjs, .cjs, .js — plain dynamic import
  const mod = await import(pathToFileURL(absolute).href);
  return unwrapDefault(mod);
}

/**
 * Unwrap `export default config`, handling ESM->CJS->ESM double-wraps.
 *
 * Standard ESM: `await import("foo.mjs")` returns a Module Namespace whose
 * `default` is the exported config — unwrap once.
 *
 * tsx + a .ts file in a directory without package.json: tsx transforms to CJS
 * so `module.exports = { default: config }`, then ESM importing the CJS
 * wraps it again as `{ default: { default: config } }` — unwrap twice.
 *
 * We walk down `.default` as long as the current level has a *single* key
 * named `default`. The first level that looks like real config (any other
 * shape) is returned. This handles both cases without hardcoding either.
 */
function unwrapDefault(mod: unknown): unknown {
  let current: unknown = mod;
  for (let i = 0; i < 4; i++) {
    if (current === null || typeof current !== "object") return current;
    const obj = current as Record<string, unknown>;
    // Skip the outer Module Namespace wrapper unconditionally — `default` is
    // the only meaningful export for a config file.
    if ((obj as Record<symbol, unknown>)[Symbol.toStringTag] === "Module") {
      if (!("default" in obj)) return obj;
      current = obj.default;
      continue;
    }
    // For plain objects: unwrap only if the *sole* enumerable key is
    // `default` (the CJS-interop wrap shape). Otherwise we've found config.
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === "default") {
      current = obj.default;
      continue;
    }
    return obj;
  }
  return current;
}

export { HarnessConfigError } from "./types.js";

export const MODEL_DEFAULTS: Required<HarnessModelConfig> = {
  holdouts: "sonnet",
  plan: "opus",
  implement: "sonnet",
  review: "opus",
};

// Default review profiles. The autonomous-harness skill picks one per story
// at Phase 4d; stories without a `reviewProfile` declaration get `default`.
// Operators can override the whole set in harness.config.ts.
export const REVIEW_PROFILE_DEFAULTS: ReviewProfileSet = {
  default: {
    reviewers: ["code-reviewer", "architect-review", "security-auditor", "spec-compliance"],
    description: "Full 4-reviewer adversarial — engine, multiplayer, persistence, contracts",
  },
  ui: {
    reviewers: ["code-reviewer", "spec-compliance"],
    description: "Light fan-out — UI/scenes need human eyes, not architect/security signal",
  },
  content: {
    reviewers: ["code-reviewer", "spec-compliance"],
    description: "Light fan-out — data-only content drops (cards, enemies, status defs)",
  },
  minimal: {
    reviewers: ["code-reviewer"],
    description: "Small mechanical changes — one reviewer + verify-all gates is enough",
  },
};

const VALID_PHASES = ["holdouts", "plan", "implement", "review"] as const;
const VALID_SLUGS: HarnessModelSlug[] = ["opus", "sonnet", "haiku"];
const VALID_REVIEWERS: ReviewerName[] = [
  "code-reviewer",
  "architect-review",
  "security-auditor",
  "spec-compliance",
];

export function validateModels(rawModels: unknown): void {
  if (rawModels === undefined || rawModels === null) return;
  if (typeof rawModels !== "object") {
    throw new HarnessConfigError("models must be an object");
  }
  for (const [key, value] of Object.entries(rawModels as Record<string, unknown>)) {
    if (!(VALID_PHASES as readonly string[]).includes(key)) {
      throw new HarnessConfigError(`unknown phase: ${key}`);
    }
    if (typeof value !== "string" || !VALID_SLUGS.includes(value as HarnessModelSlug)) {
      throw new HarnessConfigError(`unknown model slug: ${value}`);
    }
  }
}

export function validateReviewProfiles(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object") {
    throw new HarnessConfigError("reviewProfiles must be an object");
  }
  const set = raw as Record<string, unknown>;
  if (!("default" in set)) {
    throw new HarnessConfigError("reviewProfiles must include a 'default' profile");
  }
  for (const [name, profile] of Object.entries(set)) {
    if (!profile || typeof profile !== "object") {
      throw new HarnessConfigError(`reviewProfiles.${name} must be an object`);
    }
    const reviewers = (profile as { reviewers?: unknown }).reviewers;
    if (!Array.isArray(reviewers) || reviewers.length === 0) {
      throw new HarnessConfigError(`reviewProfiles.${name}.reviewers must be a non-empty array`);
    }
    for (const r of reviewers) {
      if (typeof r !== "string" || !VALID_REVIEWERS.includes(r as ReviewerName)) {
        throw new HarnessConfigError(
          `reviewProfiles.${name}.reviewers contains invalid name: ${String(r)}`,
        );
      }
    }
  }
}

function normalizeConfigRaw(raw: Record<string, unknown>): {
  models: Required<HarnessModelConfig>;
  reviewProfiles: ReviewProfileSet;
  maxAttempts: number;
  storiesDir: string;
  worktreesDir: string;
  holdoutPaths: string[];
  logDir: string;
} {
  validateModels(raw.models);
  validateReviewProfiles(raw.reviewProfiles);
  const models: Required<HarnessModelConfig> = {
    ...MODEL_DEFAULTS,
    ...((raw.models as HarnessModelConfig) ?? {}),
  };
  const reviewProfiles: ReviewProfileSet = {
    ...REVIEW_PROFILE_DEFAULTS,
    ...((raw.reviewProfiles as ReviewProfileSet) ?? {}),
  };
  const worktreesDir =
    (raw.worktrees as { dir?: string } | undefined)?.dir ??
    (raw.worktreeDir as string | undefined) ??
    ".claude/worktrees";
  const storiesDir =
    (raw.stories as { dir?: string } | undefined)?.dir ??
    join((raw.openspecDir as string | undefined) ?? "openspec", "changes");
  if (raw.maxAttempts !== undefined && typeof raw.maxAttempts !== "number") {
    throw new HarnessConfigError("maxAttempts must be a number");
  }
  const maxAttempts =
    (raw.maxAttempts as number | undefined) ??
    (raw.iteration as { maxAttempts?: number } | undefined)?.maxAttempts ??
    3;
  const holdoutPaths = (raw.holdouts as { paths?: string[] } | undefined)?.paths ?? [];
  const logDir = (raw.logDir as string | undefined) ?? ".claude/harness-logs";
  return {
    models,
    reviewProfiles,
    maxAttempts,
    storiesDir,
    worktreesDir,
    holdoutPaths,
    logDir,
  };
}

function resolveConfigPath(configPath: string | undefined): string {
  if (configPath) {
    const absolute = resolve(process.cwd(), configPath);
    if (!existsSync(absolute)) {
      throw new HarnessConfigError(`config file not found: ${absolute}`);
    }
    return absolute;
  }
  const discovered = discoverConfigPath(process.cwd());
  if (!discovered) {
    throw new HarnessConfigError(
      `no harness config found in ${process.cwd()}.\n` +
        `  Looked for: ${CONFIG_FILENAMES.join(", ")}\n` +
        `  Run \`baton-harness init\` to scaffold one.`,
    );
  }
  return discovered;
}

export async function loadConfig(configPath?: string): Promise<HarnessConfig> {
  const absolute = resolveConfigPath(configPath);
  const config = (await loadConfigFile(absolute)) as HarnessConfig;
  validateModels((config as { models?: unknown }).models);
  validateReviewProfiles((config as { reviewProfiles?: unknown }).reviewProfiles);
  validate(config);
  const normalized = normalizeConfigRaw(config as unknown as Record<string, unknown>);
  config.models = normalized.models;
  config.reviewProfiles = normalized.reviewProfiles;
  return config;
}

// Legacy fields are validated when present but allowed to be absent so that
// minimal configs (used by the config-models holdout fixture, which calls
// loadConfig with only { holdouts, stories, [models] }) load cleanly.
// Empty/invalid values still throw — the reviewer's concern about
// `openspecDir: ""` silently passing does not apply here, since `!"" === true`
// combined with `"" !== undefined` triggers the throw.
function validate(config: HarnessConfig): void {
  if (config.openspecDir !== undefined && !config.openspecDir)
    throw new Error("harness.config: openspecDir required");
  if (config.verification !== undefined && !config.verification.typecheck)
    throw new Error("harness.config: verification.typecheck required");
  if (config.iteration !== undefined && config.iteration.maxAttempts < 1)
    throw new Error("harness.config: iteration.maxAttempts must be >= 1");
  if (config.holdouts !== undefined && config.holdouts.paths.length === 0)
    throw new Error("harness.config: holdouts.paths required");
}

export interface MinimalHarnessConfig {
  models: Required<HarnessModelConfig>;
  reviewProfiles: ReviewProfileSet;
  maxAttempts: number;
  storiesDir: string;
  worktreesDir: string;
  holdoutPaths: string[];
  logDir: string;
}

export async function loadMinimalConfig(configPath?: string): Promise<MinimalHarnessConfig> {
  const absolute = resolveConfigPath(configPath);
  const raw = (await loadConfigFile(absolute)) as Record<string, unknown>;
  return normalizeConfigRaw(raw);
}
