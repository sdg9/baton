# Project notes for the @baton-tools/harness

This file holds project-level context the harness reuses across stories. Add anything that affects every story (architectural invariants, naming conventions, non-negotiable rules).

## Architectural invariants

<!-- Examples:
- `src/engine/` must not import from `src/scenes/`.
- All randomness goes through `src/rng/`. No `Math.random()` in engine code.
- Server is authoritative; clients never decide damage.
-->

## Tier mapping

Per `harness.config.ts`'s `tierScopeRules`:

- **primitives** — <describe what counts as primitives in this repo>
- **content** — <describe>
- **infra** — <describe>

## Non-negotiable rules

<!-- Things the harness orchestrator AND human reviewers should never override. -->
