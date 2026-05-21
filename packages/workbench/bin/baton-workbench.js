#!/usr/bin/env node
// Thin shim that starts the workbench server. The server is TypeScript;
// we delegate execution to `tsx` (a runtime dep). Forward any CLI args.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

let tsxCli;
try {
  tsxCli = require.resolve("tsx/cli");
} catch {
  console.error("[baton-workbench] could not find `tsx` — it's a required runtime dependency.");
  console.error("If you installed without postinstall scripts, run `npm install` again.");
  process.exit(1);
}

const serverSrc = resolve(__dirname, "..", "src", "server", "server.ts");

const child = spawn(process.execPath, [tsxCli, serverSrc, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
