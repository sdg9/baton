#!/usr/bin/env node
// Thin shim that dispatches to dist/cli.js. Built by `tsc`.
import("../dist/cli.js").catch((err) => {
  console.error("[baton-harness] failed to load CLI:", err?.message ?? err);
  console.error("Did you run `npm run build`?");
  process.exit(1);
});
