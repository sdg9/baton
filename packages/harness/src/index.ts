// Public API exports for programmatic consumers.
export type {
  HarnessConfig,
  HarnessModelConfig,
  HarnessModelSlug,
  HarnessPhase,
  StoryTier,
  TierScopeRule,
  TierScopeRules,
  FullVerificationTriggers,
  ReviewerName,
  ReviewProfile,
  ReviewProfileSet,
  ReviewSummary,
  JudgmentCall,
  JudgmentCallKind,
  VerificationKind,
  VerificationResult,
} from "./types.js";

export { HarnessConfigError, VALID_TIERS } from "./types.js";
export { loadConfig, loadMinimalConfig, MODEL_DEFAULTS, REVIEW_PROFILE_DEFAULTS } from "./config-loader.js";
export { parseTier, loadChange } from "./openspec.js";
export { checkDiffScope, requiresFullVerification, mergeToMain } from "./merge-to-main.js";
export { validateHoldoutSuite } from "./holdout-validate.js";
