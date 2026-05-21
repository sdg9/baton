#!/usr/bin/env node
// Generate schema.json from the HarnessConfig TypeScript type.
//
// Output is shipped in the published package so JSON config users get
// VS Code autocomplete via:  "$schema": "https://unpkg.com/@baton-tools/harness/schema.json"
//
// Run as part of `npm run build` after tsc so the schema is always in sync
// with the published types.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

const generator = createGenerator({
  path: resolve(pkgRoot, "src", "types.ts"),
  tsconfig: resolve(pkgRoot, "tsconfig.json"),
  type: "HarnessConfig",
  skipTypeCheck: true,
  topRef: true,
  expose: "export",
  jsDoc: "extended",
  additionalProperties: false,
});

const schema = generator.createSchema("HarnessConfig");
schema.$id = "https://unpkg.com/@baton-tools/harness/schema.json";
schema.title = "HarnessConfig";

const outPath = resolve(pkgRoot, "schema.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
process.stdout.write(`[build-schema] wrote ${outPath}\n`);
