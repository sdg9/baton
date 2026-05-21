# Project notes

Project-level context every OpenSpec change should respect. This file is read
by tools and LLM agents working on proposals and implementations — keep it
short, factual, and stable across changes.

## Architectural invariants

<!-- Things that hold true regardless of which change is in flight.
Examples:
- `src/engine/` must not import from `src/scenes/`.
- All randomness goes through `src/rng/`. No `Math.random()` in engine code.
- Server is authoritative; clients never decide damage.
-->

## Non-negotiable rules

<!-- Conventions that must not be broken even by an in-progress change. -->
