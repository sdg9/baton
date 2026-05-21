import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHuman, renderJson, runDoctor } from "./doctor.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-doctor-test-"));
}

describe("runDoctor — git-repo check", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a fail result when cwd is not a git repo", async () => {
    const report = await runDoctor(dir);
    const gitRepo = report.checks.find((c) => c.name === "git-repo");
    expect(gitRepo).toBeDefined();
    expect(gitRepo?.tier).toBe("hard");
    expect(gitRepo?.status).toBe("fail");
    expect(report.ok).toBe(false);
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
  });

  it("emits a pass result when cwd is a git repo", async () => {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    const report = await runDoctor(dir);
    const gitRepo = report.checks.find((c) => c.name === "git-repo");
    expect(gitRepo?.status).toBe("pass");
  });
});

describe("renderers", () => {
  it("renderHuman includes the section headers and result line", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const out = renderHuman(report);
      expect(out).toContain("baton-harness doctor");
      expect(out).toContain("Hard checks");
      expect(out).toContain("Result:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renderJson produces parseable JSON with summary + checks", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const parsed = JSON.parse(renderJson(report));
      expect(parsed.ok).toBe(false);
      expect(parsed.summary).toMatchObject({ pass: expect.any(Number) });
      expect(Array.isArray(parsed.checks)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDoctor — environment checks", () => {
  it("emits a pass result for node-version on a supported runtime", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const node = report.checks.find((c) => c.name === "node-version");
      expect(node).toBeDefined();
      expect(node?.tier).toBe("hard");
      // We assume the host running tests has node >=18.17.0 (the engines floor).
      // If the floor changes, update this expectation.
      expect(node?.status).toBe("pass");
      expect(node?.message).toMatch(/\d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a pass result for git-on-path when git is installed", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const git = report.checks.find((c) => c.name === "git-on-path");
      expect(git).toBeDefined();
      expect(git?.tier).toBe("hard");
      // CI hosts and dev machines invariably have git on PATH.
      expect(git?.status).toBe("pass");
      expect(git?.message).toMatch(/git version/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const VALID_CONFIG_JSON = JSON.stringify({
  openspecDir: "openspec",
  worktreeDir: ".claude/worktrees",
  logDir: ".claude/harness-logs",
  verification: {
    lint: "echo lint",
    typecheck: "echo typecheck",
    unit: "echo unit",
    e2e: "echo e2e",
  },
  holdouts: { paths: ["src/**/*.holdout.test.ts"], markerComment: "// @openspec-holdout" },
  iteration: { maxAttempts: 3 },
  git: { baseBranch: "main", branchPrefix: "story/", forbidPushToBase: true, blockNoVerify: true },
  tierScopeRules: {},
  fullVerificationTriggers: { exactPaths: [], prefixes: [] },
});

describe("runDoctor — config checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits config-present fail and config-parses fail (skipped) when no config exists", async () => {
    const report = await runDoctor(dir);
    const present = report.checks.find((c) => c.name === "config-present");
    const parses = report.checks.find((c) => c.name === "config-parses");
    expect(present?.status).toBe("fail");
    expect(parses?.status).toBe("fail");
    expect(parses?.message).toMatch(/no config file/i);
  });

  it("emits both passes when a valid harness.config.json is present", async () => {
    writeFileSync(join(dir, "harness.config.json"), VALID_CONFIG_JSON);
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "config-present")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "config-parses")?.status).toBe("pass");
  });

  it("emits config-present pass but config-parses fail when the file is malformed", async () => {
    writeFileSync(join(dir, "harness.config.json"), "{ this is not valid json");
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "config-present")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "config-parses")?.status).toBe("fail");
  });
});

describe("runDoctor — openspec checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    // Every test in this block has a valid config — write it once.
    writeFileSync(join(dir, "harness.config.json"), VALID_CONFIG_JSON);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("openspec-dir fails when openspec/ does not exist", async () => {
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "openspec-dir")?.status).toBe("fail");
  });

  it("openspec-dir passes when openspec/ exists", async () => {
    mkdirSync(join(dir, "openspec"));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "openspec-dir")?.status).toBe("pass");
  });

  it("openspec-project-md fails when openspec/ exists but project.md does not", async () => {
    mkdirSync(join(dir, "openspec"));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "openspec-project-md")?.status).toBe("fail");
  });

  it("openspec-project-md passes when openspec/project.md exists", async () => {
    mkdirSync(join(dir, "openspec"));
    writeFileSync(join(dir, "openspec", "project.md"), "# Project\n");
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "openspec-project-md")?.status).toBe("pass");
  });

  it("openspec-dir is skipped (fail) when config is unavailable", async () => {
    rmSync(join(dir, "harness.config.json"));
    const report = await runDoctor(dir);
    const check = report.checks.find((c) => c.name === "openspec-dir");
    expect(check?.status).toBe("fail");
    expect(check?.message).toMatch(/skipped: config unavailable/i);
  });
});

describe("runDoctor — openspec-cli check", () => {
  it("emits a hard check named 'openspec-cli' with a status of pass, warn, or fail", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const cli = report.checks.find((c) => c.name === "openspec-cli");
      expect(cli).toBeDefined();
      expect(cli?.tier).toBe("hard");
      expect(["pass", "warn", "fail"]).toContain(cli?.status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDoctor — verify-command checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("verify-lint passes when the first token resolves on PATH (node)", async () => {
    const cfg = JSON.parse(VALID_CONFIG_JSON);
    cfg.verification.lint = "node --version";
    writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "verify-lint")?.status).toBe("pass");
  });

  it("verify-typecheck fails when the first token cannot be resolved", async () => {
    const cfg = JSON.parse(VALID_CONFIG_JSON);
    cfg.verification.typecheck = "definitely-not-a-real-binary-xyz123 --check";
    writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "verify-typecheck")?.status).toBe("fail");
  });

  it("verify-unit passes when the first token resolves in cwd/node_modules/.bin", async () => {
    const cfg = JSON.parse(VALID_CONFIG_JSON);
    cfg.verification.unit = "my-fake-runner --watch=false";
    writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    // Create an executable shim — content doesn't matter; the check resolves only.
    writeFileSync(join(dir, "node_modules", ".bin", "my-fake-runner"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "verify-unit")?.status).toBe("pass");
  });

  it("all four verify-* checks are skipped when config is unavailable", async () => {
    const report = await runDoctor(dir);
    for (const name of ["verify-lint", "verify-typecheck", "verify-unit", "verify-e2e"]) {
      const check = report.checks.find((c) => c.name === name);
      expect(check?.status).toBe("fail");
      expect(check?.message).toMatch(/skipped: config unavailable/i);
    }
  });

  it("verify-lint strips leading env-var assignments before resolving the binary", async () => {
    const cfg = JSON.parse(VALID_CONFIG_JSON);
    cfg.verification.lint = "DEBUG=1 NODE_OPTIONS=--no-warnings node --version";
    writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "verify-lint")?.status).toBe("pass");
  });
});

describe("runDoctor — soft filesystem checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    writeFileSync(join(dir, "harness.config.json"), VALID_CONFIG_JSON);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("git-hook warns when .githooks/commit-msg is missing", async () => {
    const report = await runDoctor(dir);
    const hook = report.checks.find((c) => c.name === "git-hook");
    expect(hook?.tier).toBe("soft");
    expect(hook?.status).toBe("warn");
  });

  it("git-hook passes when .githooks/commit-msg exists and core.hooksPath is .githooks", async () => {
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(join(dir, ".githooks", "commit-msg"), "#!/bin/sh\n", { mode: 0o755 });
    execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: dir });
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "git-hook")?.status).toBe("pass");
  });

  it("git-hook warns when hook file exists but core.hooksPath is unset", async () => {
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(join(dir, ".githooks", "commit-msg"), "#!/bin/sh\n", { mode: 0o755 });
    // Intentionally do NOT set git config core.hooksPath here.
    const report = await runDoctor(dir);
    const hook = report.checks.find((c) => c.name === "git-hook");
    expect(hook?.status).toBe("warn");
    expect(hook?.message).toMatch(/\(unset\)/);
  });

  it("gitignore-worktree warns when .gitignore does not cover worktreeDir", async () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "gitignore-worktree")?.status).toBe("warn");
  });

  it("gitignore-worktree passes when worktreeDir is covered", async () => {
    writeFileSync(join(dir, ".gitignore"), ".claude/worktrees/\n.claude/harness-logs/\n");
    const report = await runDoctor(dir);
    expect(report.checks.find((c) => c.name === "gitignore-worktree")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "gitignore-logs")?.status).toBe("pass");
  });
});

describe("runDoctor — soft env/plugin checks", () => {
  it("emits each soft env/plugin check with a well-formed result", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      for (const name of [
        "claude-on-path",
        "plugin-installed",
        "superpowers-installed",
      ]) {
        const c = report.checks.find((c) => c.name === name);
        expect(c).toBeDefined();
        expect(c?.tier).toBe("soft");
        expect(["pass", "warn"]).toContain(c?.status);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("version-drift is omitted when no local install exists", async () => {
    const dir = makeTempDir();
    try {
      const report = await runDoctor(dir);
      const drift = report.checks.find((c) => c.name === "version-drift");
      expect(drift).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("version-drift warns on mismatch and passes on match", async () => {
    const dir = makeTempDir();
    try {
      // Fake a local install: cwd/node_modules/@baton-tools/harness/package.json
      const local = join(dir, "node_modules", "@baton-tools", "harness");
      mkdirSync(local, { recursive: true });
      writeFileSync(
        join(local, "package.json"),
        JSON.stringify({ name: "@baton-tools/harness", version: "9.9.9" }),
      );
      // Fake a SKILL.md pinning a different version.
      const skillsDir = join(local, "plugin", "skills", "autonomous-harness");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, "SKILL.md"),
        "Run `npx -y -p @baton-tools/harness@1.0.0 baton-harness status <story>`.\n",
      );
      const report = await runDoctor(dir);
      const drift = report.checks.find((c) => c.name === "version-drift");
      expect(drift?.tier).toBe("soft");
      expect(drift?.status).toBe("warn");
      expect(drift?.message).toMatch(/9\.9\.9.*1\.0\.0|1\.0\.0.*9\.9\.9/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("version-drift passes when installed version matches plugin pin", async () => {
    const dir = makeTempDir();
    try {
      const local = join(dir, "node_modules", "@baton-tools", "harness");
      mkdirSync(local, { recursive: true });
      writeFileSync(
        join(local, "package.json"),
        JSON.stringify({ name: "@baton-tools/harness", version: "1.0.0" }),
      );
      const skillsDir = join(local, "plugin", "skills", "autonomous-harness");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, "SKILL.md"),
        "Run `npx -y -p @baton-tools/harness@1.0.0 baton-harness status <story>`.\n",
      );
      const report = await runDoctor(dir);
      const drift = report.checks.find((c) => c.name === "version-drift");
      expect(drift?.tier).toBe("soft");
      expect(drift?.status).toBe("pass");
      expect(drift?.message).toMatch(/1\.0\.0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDoctor — integration", () => {
  it("healthy scaffold: every hard check passes", async () => {
    const dir = makeTempDir();
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });
      writeFileSync(join(dir, "harness.config.json"), VALID_CONFIG_JSON);
      mkdirSync(join(dir, "openspec"));
      writeFileSync(join(dir, ".gitignore"), ".claude/worktrees/\n.claude/harness-logs/\n");
      writeFileSync(join(dir, "openspec", "project.md"), "# Project\n");
      mkdirSync(join(dir, ".githooks"));
      writeFileSync(join(dir, ".githooks", "commit-msg"), "#!/bin/sh\n", { mode: 0o755 });
      execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: dir });

      // Override the config's verify commands to use `node` (always on PATH).
      const cfg = JSON.parse(VALID_CONFIG_JSON);
      cfg.verification = {
        lint: "node --version",
        typecheck: "node --version",
        unit: "node --version",
        e2e: "node --version",
      };
      writeFileSync(join(dir, "harness.config.json"), JSON.stringify(cfg));

      const report = await runDoctor(dir);
      const hardFails = report.checks.filter((c) => c.tier === "hard" && c.status === "fail");
      // openspec-cli may legitimately fail in CI if @fission-ai/openspec isn't
      // in the npx cache. Allow that single check to fail without breaking
      // the test (it's still a real signal in practice).
      const acceptableFails = hardFails.filter((c) => c.name !== "openspec-cli");
      expect(acceptableFails).toHaveLength(0);
      // Soft checks may legitimately warn (no Claude Code on CI hosts).
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("broken scaffold: expected hard fails, JSON shape is stable", async () => {
    const dir = makeTempDir();
    try {
      // Empty dir: no git, no config, no openspec.
      const report = await runDoctor(dir);
      const failNames = report.checks.filter((c) => c.status === "fail").map((c) => c.name);
      expect(failNames).toContain("git-repo");
      expect(failNames).toContain("config-present");
      expect(failNames).toContain("config-parses");
      expect(failNames).toContain("openspec-dir");
      expect(failNames).toContain("openspec-project-md");

      // JSON shape: every expected check name is present, exactly once.
      const json = JSON.parse(renderJson(report));
      const names = (json.checks as Array<{ name: string }>).map((c) => c.name);
      const expectedHard = [
        "git-repo",
        "node-version",
        "git-on-path",
        "config-present",
        "config-parses",
        "openspec-dir",
        "openspec-project-md",
        "openspec-cli",
        "verify-lint",
        "verify-typecheck",
        "verify-unit",
        "verify-e2e",
      ];
      const expectedSoft = [
        "git-hook",
        "gitignore-worktree",
        "gitignore-logs",
        "claude-on-path",
        "plugin-installed",
        "superpowers-installed",
      ];
      for (const name of [...expectedHard, ...expectedSoft]) {
        expect(names.filter((n) => n === name)).toHaveLength(1);
      }
      // version-drift not emitted (no local install in tmp dir).
      expect(names).not.toContain("version-drift");
      expect(report.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
