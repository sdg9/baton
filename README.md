# Baton

Spec-driven autonomous-development tooling: a harness that drives an LLM through holdout-test generation, planning, implementation, and adversarial review — paired with a local-first kanban dashboard for launching and monitoring runs.

This repository contains two packages:

- **[`packages/harness`](./packages/harness)** — `@baton-tools/harness` on npm. A TypeScript CLI plus Claude Code plugin (`baton-harness`) that orchestrates the autonomous-development loop. Project-agnostic core; per-repo config via `harness.config.ts`.
- **[`packages/workbench`](./packages/workbench)** — `@baton-tools/workbench` on npm. A local-first browser kanban for launching and monitoring Claude Code terminal sessions against allowlisted projects. Reads OpenSpec changes natively; lights up extra controls when a project has the harness installed.

The two packages can be used independently. The workbench has *optional* awareness of the harness — projects without `harness.config.ts` still get a working kanban; projects with it get harness-driven actions on the board.

## Development

```bash
# Install all package dependencies via pnpm workspaces
pnpm install

# Build everything
pnpm build

# Run all tests
pnpm test

# Work in one package
pnpm --filter @baton-tools/harness <script>
pnpm --filter @baton-tools/workbench <script>
```

## Releases

We use [changesets](https://github.com/changesets/changesets) for per-package versioning and publishing.

**See [`RELEASING.md`](./RELEASING.md) for the full scriptable recipe** — designed so an LLM or human can take a "publish a patch of the harness" instruction end-to-end without interactive prompts.

The two packages version independently. Note one cascading rule: bumping `@baton-tools/harness` also produces a patch bump of `@baton-tools/workbench` because the workbench depends on the harness via `workspace:*` (per `updateInternalDependencies: patch` in `.changeset/config.json`).

## License

MIT
