import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  HarnessConfig,
  HarnessModelConfig,
  HarnessModelSlug,
  ReviewerName,
  ReviewProfileSet,
} from "./types.js";
import { HarnessConfigError } from "./types.js";

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

export async function loadConfig(configPath = "harness.config.ts"): Promise<HarnessConfig> {
  const absolute = resolve(process.cwd(), configPath);
  const mod = await import(pathToFileURL(absolute).href);
  const config = (mod.default ?? mod) as HarnessConfig;
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

export async function loadMinimalConfig(
  configPath = "harness.config.ts",
): Promise<MinimalHarnessConfig> {
  const absolute = resolve(process.cwd(), configPath);
  const mod = await import(pathToFileURL(absolute).href);
  const raw = (mod.default ?? mod) as Record<string, unknown>;
  return normalizeConfigRaw(raw);
}
