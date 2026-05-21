export type HarnessModelSlug = "opus" | "sonnet" | "haiku";

// ---------------------------------------------------------------------------
// Tier classification — drives harness dispatch.
//
// Three tiers, intentionally abstract so they fit different projects:
//   `primitives` → full flow (holdout-gen + plan + impl + 4-reviewer adversarial).
//                  Use for core contracts and load-bearing behavior — the bits
//                  consumers / downstream code couple against. Examples by
//                  project type:
//                    • component library → public component API (props, events)
//                    • game engine       → state mutation primitives
//                    • API backend       → request/response contracts
//   `content`    → impl + spec-compliance reviewer; lint/typecheck/unit gate.
//                  Use for data drops or new variants that consume existing
//                  primitives without changing them.
//   `infra`      → impl + lint/typecheck/unit only; no holdout-gen, no reviewers.
//                  Use for build, CI, scripts, dev tooling.
//
// Declared in a `## Tier` section of the proposal.md (single value, optional
// one-line justification). Parsed by `openspec.ts`. Tier-to-forbidden-path
// rules are configured per-repo via `harness.config.ts` (`tierScopeRules`).
// ---------------------------------------------------------------------------

export type StoryTier = "primitives" | "content" | "infra";

export const VALID_TIERS: readonly StoryTier[] = ["primitives", "content", "infra"];

// ---------------------------------------------------------------------------
// JudgmentCall types (autopilot-mode)
// ---------------------------------------------------------------------------

export type JudgmentCallKind =
  | "block-downgrade"
  | "conflict-resolution"
  | "main-side-fix"
  | "archive-fix"
  | "other";

export interface JudgmentCall {
  kind: JudgmentCallKind;
  summary: string;
  rationale: string;
  reviewerIds?: string[];
}

// ---------------------------------------------------------------------------
// ReviewSummary — canonical definition (was in review.ts; moved here so
// holdouts can import from tools/harness/types without a circular dep).
// review.ts re-exports it for backward compatibility.
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  verdict: "green" | "yellow" | "red";
  confidence: "high" | "medium" | "low";
  reasoning: string;
  attempts: number;
  gates: Record<string, "pass" | "fail" | "skip">;
  findings: { block: number; warn: number; info: number };
  judgmentCalls?: JudgmentCall[];
}

export type HarnessPhase = "holdouts" | "plan" | "implement" | "review";

export interface HarnessModelConfig {
  holdouts?: HarnessModelSlug;
  plan?: HarnessModelSlug;
  implement?: HarnessModelSlug;
  review?: HarnessModelSlug;
}

// ---------------------------------------------------------------------------
// Review profiles — per-epic reviewer fan-out.
// The orchestrator (autonomous-harness skill, Phase 4d) picks a profile per
// story and dispatches only those reviewers. Engine/multiplayer/persistence
// stories use `default` (4 reviewers); UI/content stories use lighter sets
// because architect/security findings on UI surface as noise that never gets
// acted on.
// ---------------------------------------------------------------------------

export type ReviewerName =
  | "code-reviewer"
  | "architect-review"
  | "security-auditor"
  | "spec-compliance";

export interface ReviewProfile {
  reviewers: ReviewerName[];
  description?: string;
}

export interface ReviewProfileSet {
  default: ReviewProfile;
  [profileName: string]: ReviewProfile;
}

/**
 * Per-tier scope guardrail rules. When the merge-to-main guardrail runs, any
 * diff path matching a `forbiddenPrefixes` entry for the story's tier blocks
 * the merge. Omit a tier entry (or the whole field) to disable enforcement
 * for that tier. `primitives` is never restricted.
 *
 * Example for a component library:
 *   { content: { forbiddenPrefixes: ["src/lib/", "src/api/"] },
 *     infra:   { forbiddenPrefixes: ["src/"] } }
 */
export interface TierScopeRule {
  forbiddenPrefixes: string[];
}
export interface TierScopeRules {
  content?: TierScopeRule;
  infra?: TierScopeRule;
}

/**
 * Triggers that force `verify-all --full` (slow CLI-integration suites) even
 * when a `--fast` merge was requested. Exact-path match or prefix match.
 * Holdout files always trigger full verification.
 */
export interface FullVerificationTriggers {
  exactPaths?: string[];
  prefixes?: string[];
}

export interface HarnessConfig {
  openspecDir: string;
  worktreeDir: string;
  logDir: string;
  verification: {
    typecheck: string;
    unit: string;
    e2e: string;
    lint: string;
    /**
     * Optional full-suite unit command. Used by `verify-all --full` (and
     * `merge-to-main`) to run the slow CLI-integration tests that the
     * per-gate `unit` command skips for speed. Falls back to `unit` when
     * absent.
     */
    unitFull?: string;
  };
  holdouts: {
    paths: string[];
    markerComment: string;
  };
  iteration: {
    maxAttempts: number;
  };
  git: {
    baseBranch: string;
    branchPrefix: string;
    forbidPushToBase: boolean;
    blockNoVerify: boolean;
  };
  models?: HarnessModelConfig;
  reviewProfiles?: ReviewProfileSet;
  tierScopeRules?: TierScopeRules;
  fullVerificationTriggers?: FullVerificationTriggers;
}

export type VerificationKind = "typecheck" | "unit" | "e2e" | "lint";

export interface VerificationResult {
  kind: VerificationKind;
  passed: boolean;
  durationMs: number;
  output: string;
  exitCode: number | null;
}

export class HarnessConfigError extends Error {
  public readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "HarnessConfigError";
    this.reason = reason;
  }
}
