// Prints a starter prompt for an agent session that's beginning work on the workbench itself.
// Usage: node tools/print-start-prompt.mjs

const prompt = `We are working on the Baton Workbench package (@baton-tools/workbench).

Read AGENTS.md and CLAUDE.md first for the package's safety rules and architecture principles.

Goal for this session:
Continue implementation of the local-first kanban board. Keep the server bound to 127.0.0.1, keep project paths and agent commands allowlisted, and never log raw secrets or auth tokens.

If an OpenSpec change folder is referenced (under openspec/changes/), use it as the source of truth — validate the artifacts first, then write a concise implementation plan before editing code.`;

console.log(prompt);
