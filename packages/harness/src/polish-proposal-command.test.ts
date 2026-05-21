import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const commandPath = join(here, "..", "plugin", "commands", "polish-proposal.md");

describe("polish-proposal slash command", () => {
  const body = readFileSync(commandPath, "utf8");

  it("ships with the required frontmatter", () => {
    expect(body.startsWith("---\n")).toBe(true);
    const end = body.indexOf("\n---\n", 4);
    expect(end).toBeGreaterThan(0);
    const frontmatter = body.slice(4, end);
    expect(frontmatter).toMatch(/^description:/m);
    expect(frontmatter).toMatch(/^argument-hint:/m);
  });

  it("explicitly bounds the round count at 3", () => {
    expect(body).toMatch(/3\s+rounds/i);
  });

  it("enumerates the auto-apply whitelist and forbids anything else", () => {
    expect(body).toMatch(/Auto-apply/);
    expect(body).toMatch(/typo/i);
    expect(body).toMatch(/missing required section/i);
    expect(body).toMatch(/intra-doc references/i);
    expect(body).toMatch(/When in doubt, escalate/);
  });

  it("requires one git commit per round so reverts work", () => {
    expect(body).toMatch(/git commit/);
    expect(body).toMatch(/per round/);
  });

  it("forbids edits outside the change directory", () => {
    expect(body).toMatch(/Only edit files inside `openspec\/changes\/\$ARGUMENTS\//);
    expect(body).toMatch(/never touch source code/i);
  });

  it("writes an audit log at polish-log.md inside the change dir", () => {
    expect(body).toMatch(/polish-log\.md/);
    expect(body).toMatch(/Auto-applied/);
    expect(body).toMatch(/Escalations/);
  });

  it("defines explicit stop conditions", () => {
    expect(body).toMatch(/zero auto-apply edits AND zero escalations/i);
    expect(body).toMatch(/round cap/i);
    expect(body).toMatch(/`done`/);
  });
});
