import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessConfigError, loadConfig, loadMinimalConfig } from "./config-loader.js";

/**
 * Most tests write a config to a temp dir and pass its absolute path to
 * loadConfig — that exercises the extension dispatch + parse + validate path
 * without needing to chdir (esbuild's persistent worker, which tsx uses, gets
 * unhappy when cwd changes between tests in the same process).
 *
 * Discovery (no-arg loadConfig) is exercised by a single test below that
 * chdir's and restores carefully.
 */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-config-test-"));
}

const VALID_CONFIG_OBJ = {
  openspecDir: "openspec",
  worktreeDir: ".claude/worktrees",
  logDir: ".claude/harness-logs",
  verification: {
    lint: "echo lint",
    typecheck: "echo typecheck",
    unit: "echo unit",
    e2e: "echo e2e",
  },
  holdouts: {
    paths: ["src/**/*.holdout.test.ts"],
    markerComment: "// @openspec-holdout",
  },
  iteration: { maxAttempts: 3 },
  git: {
    baseBranch: "main",
    branchPrefix: "story/",
    forbidPushToBase: true,
    blockNoVerify: true,
  },
  tierScopeRules: {},
  fullVerificationTriggers: { exactPaths: [], prefixes: [] },
};

const VALID_CONFIG_TS_SOURCE = `
const config = ${JSON.stringify(VALID_CONFIG_OBJ, null, 2)};
export default config;
`;

const VALID_CONFIG_MJS_SOURCE = `
export default ${JSON.stringify(VALID_CONFIG_OBJ, null, 2)};
`;

const VALID_CONFIG_CJS_SOURCE = `
module.exports = ${JSON.stringify(VALID_CONFIG_OBJ, null, 2)};
`;

describe("loadConfig — explicit paths", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads .ts via tsx and unwraps export default", async () => {
    const path = join(dir, "harness.config.ts");
    writeFileSync(path, VALID_CONFIG_TS_SOURCE);
    const cfg = await loadConfig(path);
    expect(cfg.openspecDir).toBe("openspec");
    expect(cfg.verification?.typecheck).toBe("echo typecheck");
    // Regression: tsx's CJS-interop double-wrap must be flattened.
    expect((cfg as unknown as Record<string, unknown>).default).toBeUndefined();
  });

  it("loads .mts via tsx", async () => {
    const path = join(dir, "harness.config.mts");
    writeFileSync(path, VALID_CONFIG_TS_SOURCE);
    const cfg = await loadConfig(path);
    expect(cfg.openspecDir).toBe("openspec");
  });

  it("loads .mjs via plain dynamic import", async () => {
    const path = join(dir, "harness.config.mjs");
    writeFileSync(path, VALID_CONFIG_MJS_SOURCE);
    const cfg = await loadConfig(path);
    expect(cfg.openspecDir).toBe("openspec");
    expect((cfg as unknown as Record<string, unknown>).default).toBeUndefined();
  });

  it("loads .cjs via plain dynamic import", async () => {
    const path = join(dir, "harness.config.cjs");
    writeFileSync(path, VALID_CONFIG_CJS_SOURCE);
    const cfg = await loadConfig(path);
    expect(cfg.openspecDir).toBe("openspec");
  });

  it("loads strict .json", async () => {
    const path = join(dir, "harness.config.json");
    writeFileSync(path, JSON.stringify(VALID_CONFIG_OBJ));
    const cfg = await loadConfig(path);
    expect(cfg.openspecDir).toBe("openspec");
    expect(cfg.holdouts?.paths).toEqual(["src/**/*.holdout.test.ts"]);
  });

  it("loads .jsonc with line comments, block comments, and trailing commas", async () => {
    const jsoncSource = `{
      // top-level line comment
      "openspecDir": "openspec", // inline comment
      /* block
         comment */
      "worktreeDir": ".claude/worktrees",
      "logDir": ".claude/harness-logs",
      "verification": {
        "lint": "echo lint",
        "typecheck": "echo typecheck",
        "unit": "echo unit",
        "e2e": "echo e2e",
      },
      "holdouts": {
        "paths": ["src/**/*.holdout.test.ts"],
        "markerComment": "// @openspec-holdout",
      },
      "iteration": { "maxAttempts": 3 },
      "git": {
        "baseBranch": "main",
        "branchPrefix": "story/",
        "forbidPushToBase": true,
        "blockNoVerify": true,
      },
      "tierScopeRules": {},
      "fullVerificationTriggers": { "exactPaths": [], "prefixes": [] },
    }`;
    const path = join(dir, "harness.config.jsonc");
    writeFileSync(path, jsoncSource);
    const cfg = await loadConfig(path);
    expect(cfg.openspecDir).toBe("openspec");
    expect(cfg.iteration?.maxAttempts).toBe(3);
  });

  it("does not strip a // comment that lives inside a string literal", async () => {
    // The JSONC stripper has to respect strings — otherwise it'd eat the
    // marker comment users actually put in their config.
    const path = join(dir, "harness.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...VALID_CONFIG_OBJ,
        holdouts: {
          paths: ["src/**/*.holdout.test.ts"],
          markerComment: "// @openspec-holdout", // ← this MUST survive parsing
        },
      }),
    );
    const cfg = await loadConfig(path);
    expect(cfg.holdouts?.markerComment).toBe("// @openspec-holdout");
  });

  it("strips $schema metadata from JSON configs", async () => {
    const path = join(dir, "harness.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        $schema: "https://unpkg.com/@baton-tools/harness/schema.json",
        ...VALID_CONFIG_OBJ,
      }),
    );
    const cfg = await loadConfig(path);
    expect((cfg as unknown as Record<string, unknown>).$schema).toBeUndefined();
    expect(cfg.openspecDir).toBe("openspec");
  });

  it("rejects invalid JSON with a clear message", async () => {
    const path = join(dir, "harness.config.json");
    writeFileSync(path, "{ not valid json");
    await expect(loadConfig(path)).rejects.toThrow(/failed to parse/);
  });

  it("rejects an unknown model slug", async () => {
    const path = join(dir, "harness.config.json");
    writeFileSync(
      path,
      JSON.stringify({ ...VALID_CONFIG_OBJ, models: { plan: "gpt-4" } }),
    );
    await expect(loadConfig(path)).rejects.toThrow(/unknown model slug/);
  });

  it("rejects an unknown reviewer name", async () => {
    const path = join(dir, "harness.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...VALID_CONFIG_OBJ,
        reviewProfiles: {
          default: { reviewers: ["not-a-real-reviewer"] },
        },
      }),
    );
    await expect(loadConfig(path)).rejects.toThrow(/invalid name/);
  });

  it("merges default models when config omits them", async () => {
    const path = join(dir, "harness.config.json");
    writeFileSync(path, JSON.stringify(VALID_CONFIG_OBJ));
    const cfg = await loadConfig(path);
    expect(cfg.models).toEqual({
      holdouts: "sonnet",
      plan: "opus",
      implement: "sonnet",
      review: "opus",
    });
  });

  it("throws HarnessConfigError when explicit path doesn't exist", async () => {
    const path = join(dir, "missing.ts");
    await expect(loadConfig(path)).rejects.toThrow(HarnessConfigError);
    await expect(loadConfig(path)).rejects.toThrow(/config file not found/);
  });
});

describe("loadMinimalConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns normalized defaults from a minimal JSON file", async () => {
    const path = join(dir, "harness.config.json");
    writeFileSync(path, JSON.stringify({ holdouts: { paths: ["x"] } }));
    const minimal = await loadMinimalConfig(path);
    expect(minimal.maxAttempts).toBe(3);
    expect(minimal.worktreesDir).toBe(".claude/worktrees");
    expect(minimal.holdoutPaths).toEqual(["x"]);
    expect(minimal.models.plan).toBe("opus");
  });
});

describe("loadConfig — discovery (cwd-based)", () => {
  // Exercises the no-arg discovery path. Kept to a single chdir → restore
  // round-trip so esbuild's persistent worker (used by tsx) doesn't get
  // confused by repeated cwd changes within the file.
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers .ts over .json when both exist (CONFIG_FILENAMES order)", async () => {
    // .ts is first in the discovery order, so it wins even though .json
    // would also satisfy the lookup.
    //
    // The package.json with type:module is so tsx treats harness.config.ts
    // as ESM rather than wrapping it in a CJS virtual module (which would
    // reference __filename and fail inside vitest's ESM worker).
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(dir, "harness.config.ts"),
      VALID_CONFIG_TS_SOURCE.replace('"openspec"', '"from-ts"'),
    );
    writeFileSync(
      join(dir, "harness.config.json"),
      JSON.stringify({ ...VALID_CONFIG_OBJ, openspecDir: "from-json" }),
    );
    const cfg = await loadConfig();
    expect(cfg.openspecDir).toBe("from-ts");
  });

  it("throws HarnessConfigError when no config is found", async () => {
    // dir was just created and has nothing in it.
    await expect(loadConfig()).rejects.toThrow(HarnessConfigError);
    await expect(loadConfig()).rejects.toThrow(/no harness config found/);
  });
});
