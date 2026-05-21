import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
