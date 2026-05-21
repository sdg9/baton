# @baton-tools/harness

## 0.2.0

### Minor Changes

- Add `baton-harness doctor` command that verifies the install: config discovery + parse, openspec scaffold, external CLIs (git, node, openspec), four configurable verify commands (resolves the binary on PATH or in workspace `node_modules/.bin` without executing), plus best-effort detection of the Claude Code plugin and superpowers. Supports `--json` for stable structured output and `--cwd=<path>` for non-`process.cwd()` invocation. Exit 0 unless any hard check fails; exit 1 on hard fail; exit 2 on arg error. Exposes `runDoctor`, `DoctorReport`, `CheckResult` from the package entry for programmatic consumers.
