# @baton-tools/harness

Spec-driven autonomous-development harness with frozen holdout contracts, tier-aware adversarial review, and an OpenSpec workflow.

You write the spec; the harness drives an LLM (via Claude Code) through holdout-test generation, planning, implementation, and multi-agent adversarial review — stopping at a green branch or a structured handoff.

Part of the [Baton](https://github.com/sdg9/baton) monorepo. The companion package [`@baton-tools/workbench`](../workbench) provides a kanban dashboard for launching and monitoring runs.

Extracted from a production game project that has shipped 60+ stories through this loop. The core is project-agnostic; per-repo knobs live in a single `harness.config.ts`.

## What you get

- **An npm package** (`@baton-tools/harness`) with a TypeScript CLI (`baton-harness`): `status`, `worktree-create`, `verify-all`, `holdout-check`, `holdout-validate`, `merge-to-main`, `finish`, `review`, etc.
- **A Claude Code plugin** under `plugin/` with:
  - `autonomous-harness` skill — the orchestrator playbook.
  - Reviewer subagents (`code-reviewer`, `architect-review`, `security-auditor`) for parallel adversarial review.
  - Slash commands: `/harness <story>`, `/openspec-propose <name>`, `/finish-story <story>`.
- **Templates** for the initial scaffold: `harness.config.ts`, `openspec/project.md`, a `.husky/commit-msg` holdout-frozen check, proposal/spec/tasks templates.

## Conceptual model

```
        ┌────────────────┐
human → │  proposal.md   │  ← you write this (and the spec deltas)
        │  spec deltas   │
        └───────┬────────┘
                │ /harness <story>
                ▼
   ┌─────────────────────────────────────────────────────┐
   │ Phase 1  worktree-create                            │
   │ Phase 2  holdout subagent → frozen *.holdout.test.* │
   │ Phase 3  planner subagent → plan.md                 │
   │ Phase 4  implementer ↻ verify ↻ holdout-check ↻     │
   │          adversarial fan-out (1-4 reviewer agents)  │
   │          until green OR maxAttempts hit             │
   └─────────────────────────────────────────────────────┘
                │
                ▼  green: branch ready, you merge
                ▼  red:   HANDOFF.md with structured failure summary
```

### Three tiers, three loop intensities

Every proposal declares one tier in a `## Tier` section. The tier drives which phases run:

| Tier         | Holdouts | Plan | Implement | verify-all | Adversarial review |
| ------------ | :------: | :--: | :-------: | :--------: | :----------------- |
| `primitives` |    ✓     |  ✓   |     ✓     |     ✓      | 1–4 reviewers      |
| `content`    |    —     |  ✓   |     ✓     |     ✓      | spec-compliance only |
| `infra`      |    —     |  ✓   |     ✓     |     ✓      | —                  |

Tier names are intentionally abstract. Map them to YOUR project:

- **Component library**: `primitives` = public component API; `content` = new variants; `infra` = build/CI.
- **API backend**: `primitives` = request/response shapes; `content` = additive fields with defaults; `infra` = scripts/CI.
- **Game/sim**: `primitives` = state-mutation engine; `content` = data drops; `infra` = tooling.

The per-tier forbidden-path rules are configurable per-repo (`tierScopeRules` in `harness.config.ts`).

### Holdouts — the unbreakable contract

A holdout is a test file marked `// @openspec-holdout` on its first line and matching a configured glob (default `*.holdout.test.*` / `*.holdout.spec.*`). Once committed in a `holdouts(<story>):` commit during Phase 2, no later commit can modify it. The `commit-msg` git hook enforces this; the harness's `holdout-check` enforces it again in the implement loop.

This is the single most valuable pattern. Once a contract is encoded as a holdout, an entire LLM session cannot drift away from it without you noticing.

## Install in a consuming repo (recommended path)

The recommended path skips `npm install` in the consuming repo entirely. The Claude Code plugin handles orchestration; the CLI runs on demand via `npx`.

```bash
# 1. In Claude Code: install the plugin from the marketplace
#    /plugin marketplace add sdg9/baton
#    /plugin install baton-harness@baton

# 2. Scaffold harness.config.ts + openspec/ + commit-msg hook in your repo
npx -y @baton-tools/harness init --with-husky

# 3. Edit harness.config.ts to point at YOUR verify commands and tier rules
$EDITOR harness.config.ts

# 4. Add to .gitignore
echo ".claude/worktrees/" >> .gitignore
echo ".claude/harness-logs/" >> .gitignore
```

You're ready. Write a proposal, approve it, then in Claude Code:

```
/harness <story-name>
```

The skill invokes the CLI as `npx -y -p @baton-tools/harness@<version> baton-harness <subcommand>` — `npx` uses your `node_modules` copy if you've installed one, otherwise fetches the pinned version into the per-user cache (`~/.npm/_npx/`). First call after a version bump downloads (~5-30s); subsequent calls are cached and fast.

## Installing the Claude Code plugin

The npm package ships both the `baton-harness` CLI and a Claude Code plugin (under `plugin/`). The plugin contains the orchestration playbook, reviewer subagents, and `/harness`-style commands; the CLI is the engine those commands shell out to via `npx`.

Three install paths, in order of recommendation:

### Option C — marketplace + on-demand npx (recommended)

```
/plugin marketplace add sdg9/baton
/plugin install baton-harness@baton
```

That's the only install step. The plugin's skill invokes the CLI as `npx -y -p @baton-tools/harness@<pinned-version> baton-harness <subcommand>`; the pinned version is rewritten at every release by `scripts/sync-plugin-version.mjs` so the plugin and CLI are always in lockstep.

Tradeoffs:
- One install. Works in every consuming repo with no per-project `npm install`.
- Plugin and CLI versions are pinned together — bump them by running `/plugin update baton-harness`.
- ~200-500ms of `npx` overhead per CLI call (cache-warm). Across ~15-20 calls per `/harness` run, that's +5-10s total per story. The commit-msg hook does NOT pay this tax — it's a pure shell script with no CLI dependency.
- First call after a version bump downloads the tarball into the npx cache. One-time, ~5-30s.

### Option A — npm-installed CLI + symlinked plugin

```bash
npm install --save-dev @baton-tools/harness
ln -s "$(npm prefix)/node_modules/@baton-tools/harness/plugin" \
      ~/.claude/plugins/baton-harness
```

This sidesteps the `npx` per-call tax — `baton-harness` is on PATH via `node_modules/.bin`, and the skill's `npx -y -p ...` invocation uses that local copy directly without a registry lookup.

Tradeoffs:
- Fastest per-call. No npx overhead.
- The symlink is bound to **one** consuming repo's `node_modules`. To decouple, install globally (`npm i -g @baton-tools/harness`) and symlink from the global `node_modules` instead.
- Extra per-repo install step (`npm install --save-dev`), and you have to remember to bump it (`npm install @baton-tools/harness@latest`) alongside `/plugin update`.
- Required if you want to **import** harness functions in your own TypeScript code (`import { loadConfig, mergeToMain } from "@baton-tools/harness"`). The library exports are useful for custom tooling and for the workbench.

### Option B — marketplace plugin + npm-installed CLI on PATH

```
/plugin marketplace add sdg9/baton
/plugin install baton-harness@baton
```

```bash
npm i -g @baton-tools/harness   # or npm i -D in each consuming repo
```

Identical runtime behavior to Option C (skill shells out via `npx`), but if `@baton-tools/harness` is in `node_modules/.bin` or globally installed, `npx` resolves it locally instead of going to the cache — so you get Option A's speed.

Tradeoffs:
- Same as C plus a redundant install. Mostly useful if you started with C and later want library imports without changing the install model.

### Which should I pick?

- **First-time setup, want one install** → Option C.
- **Long-running project where the +10s/story matters or you're using harness as a library** → Option A.
- **Hacking on the harness itself** → `/plugin marketplace add /path/to/your/clone` for the plugin half, `pnpm link` or `npm link` for the CLI half.

## Configuring for your project

`harness.config.ts` is the only repo-specific file. The full schema is in [`templates/harness.config.ts`](./templates/harness.config.ts) with inline comments. The bits you'll actually touch:

```ts
import type { HarnessConfig } from "@baton-tools/harness";

const config: HarnessConfig = {
  // Where the four quality gates run. Plug in whatever your repo uses.
  verification: {
    lint:      "npm run lint",
    typecheck: "npm run typecheck",
    unit:      "npm run test:unit",
    e2e:       "npm run test:e2e",
  },

  // Holdout file globs (used by the pre-commit hook + holdout-check).
  holdouts: {
    paths: ["src/**/*.holdout.test.ts", "e2e/**/*.holdout.spec.ts"],
    markerComment: "// @openspec-holdout",
  },

  // Per-tier forbidden-path rules. Enforced by merge-to-main.
  tierScopeRules: {
    content: { forbiddenPrefixes: ["src/core/"] }, // content can't touch core
    infra:   { forbiddenPrefixes: ["src/"] },      // infra can't touch app
  },

  git: { baseBranch: "main", branchPrefix: "story/", forbidPushToBase: true, blockNoVerify: true },
  iteration: { maxAttempts: 5 },
  openspecDir: "openspec",
  worktreeDir: ".claude/worktrees",
  logDir: ".claude/harness-logs",
};
export default config;
```

Common per-repo customizations:

- **Adjust reviewer fan-out** via `reviewProfiles`. A PCI components library might add a profile that always includes `security-auditor`; a docs-heavy repo might collapse to one reviewer.
- **Change model selection** via `models`. Defaults: holdouts=sonnet, plan=opus, implement=sonnet, review=opus. Implement escalates to opus on attempt ≥2 regardless.
- **Add to `fullVerificationTriggers`** any paths that, when touched, should force the slow CLI-integration suite even on `--fast` merges (e.g. your harness config, your CI workflow).

## What's in the box (anatomy)

```
@baton-tools/harness/
├── src/                          # TypeScript core — project-agnostic
│   ├── cli.ts                    # the `baton-harness` entrypoint
│   ├── config-loader.ts          # parses harness.config.ts + defaults
│   ├── types.ts                  # HarnessConfig, StoryTier, ReviewSummary, …
│   ├── openspec.ts               # change-folder + tier parsing
│   ├── verification.ts           # the 4-gate runner
│   ├── git-worktree.ts           # worktree create/remove + assertMainClean
│   ├── holdout-validate.ts       # antipattern static-scan
│   ├── merge-to-main.ts          # tier-scope guardrail + auto-resolve merge
│   ├── finish-post-process.ts    # archive post-processor (Purpose seeding, INBOX prune)
│   ├── review.ts                 # static HTML review page
│   ├── run-queue.ts              # autopilot multi-story preflight
│   ├── autopilot-report.ts       # final report writer
│   └── init.ts                   # `init` subcommand
├── plugin/                       # Claude Code plugin (skill + commands + agents)
│   ├── .claude-plugin/plugin.json
│   ├── skills/autonomous-harness/SKILL.md
│   ├── agents/{code-reviewer,architect-review,security-auditor}.md
│   └── commands/{harness,openspec-propose,finish-story}.md
├── templates/                    # what `baton-harness init` lays down
│   ├── harness.config.ts
│   ├── openspec/project.md
│   ├── .husky/commit-msg
│   └── {proposal,spec,tasks}-template.md
└── bin/baton-harness.js          # node shim → dist/cli.js
```

## CLI reference

Run `baton-harness help` for the full list. The ones you'll use directly:

| Command                                  | What it does                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `init [--with-husky]`                    | Scaffold harness.config.ts + openspec/ + commit-msg hook in cwd.             |
| `status <story>`                         | JSON: paths, tier, holdout globs, branch name, models. Exit 1 if unapproved. |
| `approve <story>` / `unapprove <story>`  | Mark/unmark a proposal as ready for the harness.                             |
| `worktree-create <story>`                | `git worktree add` + symlink node_modules. Refuses if main is dirty.         |
| `verify-all [--full]`                    | Run lint/typecheck/unit/e2e via the configured commands.                     |
| `holdout-check`                          | Refuse if any commit on the branch after `holdouts(...)` touched a holdout.  |
| `holdout-validate <story>`               | Static-scan holdouts for the 3 documented antipatterns.                      |
| `diff <story>`                           | Print `git diff <base>...HEAD` in the worktree.                              |
| `result <story>` / `handoff <story>`     | Write HARNESS_RESULT.md (green) or HANDOFF.md (red) in the worktree.         |
| `merge-to-main <story> [--fast]`         | Tier-scope guardrail + `--no-ff` merge + post-merge verify (rollback on fail). |
| `finish <story>`                         | After merge: openspec archive + worktree-remove + branch -d.                 |
| `accept <story>`                         | Preflight + checkout base + merge `--no-ff` + finish, in one command.        |
| `review <story>`                         | Generate static HTML review page, open in browser.                           |
| `run-queue <story...> [--autopilot]`     | Preflight a batch; with `--autopilot`, runs unattended end-to-end.           |

## Authoring a proposal

```
openspec/changes/<kebab-name>/
├── proposal.md         # ## Why / ## What changes / ## Impact / ## Tier
├── design.md           # (optional) design choices and tradeoffs
├── specs/<capability>/
│   └── spec.md         # ## Purpose / ## Requirements / scenarios as WHEN/THEN
├── tasks.md            # numbered implementation tasks
└── approved            # sentinel — a human writes this when ready
```

Templates for the three required files are at [`templates/proposal-template.md`](./templates/proposal-template.md), [`spec-template.md`](./templates/spec-template.md), and [`tasks-template.md`](./templates/tasks-template.md).

**The one rule that matters most when writing specs:** phrase `#### Scenario:` blocks as observable state transitions, not as "the system MUST register X." Apply this filter to every WHEN/THEN:

> "If I implement this scenario by exporting a pure helper and calling it from the holdout — but never wire that helper into any production dispatcher — does the scenario as written still appear satisfied?"

If yes, rewrite. Otherwise the harness will faithfully produce a holdout that passes against orphan helpers, and you'll waste cycles in adversarial review uncovering it.

## Programmatic use

```ts
import { loadConfig, mergeToMain, validateHoldoutSuite } from "@baton-tools/harness";

const config = await loadConfig();
const result = await mergeToMain({
  story: "my-feature",
  repoRoot: process.cwd(),
  runVerifyAll: () => spawnVerify(),
  baseBranch: config.git.baseBranch,
  branch: `${config.git.branchPrefix}my-feature`,
  tier: "primitives",
  tierScopeRules: config.tierScopeRules,
});
```

See [`src/index.ts`](./src/index.ts) for the full public surface.

## Why a harness at all

The pitch I'd make to a skeptic:

- **Specs become real contracts.** A holdout test pinned to a `// @openspec-holdout` marker is enforced by git, the implementer subagent, and the merge. Drift you'd never catch in code review is impossible by construction.
- **LLM cycles are amortized.** Spec refinement is the only human-paced step. Holdout generation, planning, implementation, adversarial review, merge, and archive all happen unattended. A 50-LOC story closes in ~15 min; a 500-LOC story in ~45 min.
- **Reviews scale to your fan-out budget.** Run 4 independent reviewers in parallel on a load-bearing story; run 1 reviewer on routine work. Configure per-tier so you don't pay for review you don't need.
- **Failure modes are structured.** A red verdict produces a `HANDOFF.md` summarizing attempts, the last 3 failure modes, what was tried, and what's still unclear. You re-read the spec instead of re-reading the code.

## License

MIT
