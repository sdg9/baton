// harness.config.ts — per-repo configuration for @baton-tools/harness.
//
// The baton-harness CLI reads this file at the repo root. Every field is
// either a path you control, a shell command to run as a gate, or a rule
// describing what the harness is allowed to do in your codebase.

import type { HarnessConfig } from "@baton-tools/harness";

const config: HarnessConfig = {
  // Where OpenSpec change folders live. The harness reads
  // <openspecDir>/changes/<story>/ for proposals, specs, and tasks.
  openspecDir: "openspec",

  // Directory under which story worktrees are created. Story <foo> lives at
  // <worktreeDir>/<foo>. Add this path to .gitignore.
  worktreeDir: ".claude/worktrees",

  // Where JSONL phase-event logs are written (one file per story).
  logDir: ".claude/harness-logs",

  // Shell commands the harness runs as quality gates. Each must exit 0 on
  // pass and non-zero on fail. They are invoked via `sh -c`, so use whatever
  // your project actually uses (npm/pnpm/yarn/just/make).
  verification: {
    lint: "npm run lint",
    typecheck: "npm run typecheck",
    unit: "npm run test:unit",
    e2e: "npm run test:e2e",
    // Optional: slow CLI-integration / full suite. `verify-all --full` uses
    // this; the per-gate `unit` skips it for speed. Falls back to `unit` if
    // unset.
    // unitFull: "npm run test:unit -- --include-slow",
  },

  // Holdout file globs. The pre-commit hook + holdout-check CLI use these to
  // identify frozen contract tests. A file is treated as a holdout only when
  // BOTH (a) its path matches one of these globs AND (b) its first line is
  // exactly `// @openspec-holdout`.
  holdouts: {
    paths: ["src/**/*.holdout.test.ts", "e2e/**/*.holdout.spec.ts"],
    markerComment: "// @openspec-holdout",
  },

  iteration: {
    // Maximum retry attempts in the implement→verify→review loop before
    // the harness escalates with a HANDOFF.md.
    maxAttempts: 5,
  },

  git: {
    baseBranch: "main",
    branchPrefix: "story/", // story <foo> → branch story/<foo>
    forbidPushToBase: true,
    blockNoVerify: true,
  },

  // Per-tier forbidden-path rules. Enforced by merge-to-main.
  //
  // The three tier names (`primitives`, `content`, `infra`) are intentionally
  // abstract; map them to YOUR project's concept of "core contracts" vs
  // "data/variants" vs "build/tooling":
  //
  //   • component library: primitives = public component API; content = new
  //     variants, internal styling; infra = build, demo site
  //   • API backend:       primitives = request/response shapes; content =
  //     new fields with defaults; infra = CI, scripts
  //   • game/sim:          primitives = state mutation engine; content = data
  //     drops; infra = tooling
  //
  // `primitives` is never restricted. Set forbiddenPrefixes to [] (or omit
  // the tier entry) to disable enforcement for that tier.
  tierScopeRules: {
    content: { forbiddenPrefixes: ["src/core/"] },
    infra: { forbiddenPrefixes: ["src/"] },
  },

  // Paths that force `verify-all --full` even when `--fast` was requested.
  // Holdout files (`*.holdout.test.*`, `*.holdout.spec.*`) always trigger it.
  fullVerificationTriggers: {
    exactPaths: [
      "harness.config.ts",
      "harness.config.mts",
      "harness.config.mjs",
      "harness.config.js",
      "harness.config.cjs",
      "harness.config.jsonc",
      "harness.config.json",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ],
    prefixes: [],
  },

  // Per-phase model selection. Defaults are sane:
  //   { holdouts: "sonnet", plan: "opus", implement: "sonnet", review: "opus" }
  // The orchestrator auto-escalates implementer to opus on attempt >= 2.
  // models: { holdouts: "sonnet", plan: "opus", implement: "sonnet", review: "opus" },

  // Review profiles. The orchestrator picks one per story (a story can opt in
  // by writing the name into `openspec/changes/<story>/review-profile`).
  // The four reviewer roles ship with this plugin under `agents/`.
  // reviewProfiles: {
  //   default: { reviewers: ["code-reviewer", "architect-review", "security-auditor", "spec-compliance"] },
  //   minimal: { reviewers: ["code-reviewer"] },
  // },
};

export default config;
