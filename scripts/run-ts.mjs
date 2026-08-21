#!/usr/bin/env node
/** Execute a TypeScript entry through Vite+'s native module runner. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, createServerModuleRunner } from "vite-plus";

const [, , entry, ...entryArgs] = process.argv;
if (!entry) {
  console.error("Usage: node scripts/run-ts.mjs <entry.ts> [...args]");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPath = path.resolve(process.cwd(), entry);

// Keep the entry's argv compatible with direct Node execution. The module
// runner is only the loader; application code still owns argument parsing and
// signal handling.
process.argv = [process.argv[0], entryPath, ...entryArgs];

const server = await createServer({
  root: repoRoot,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });

try {
  // Long-running host entries return after starting
  // their service. Keep Vite's module runner alive for later request-driven
  // imports instead of closing it as soon as the entry function returns.
  await runner.import(entryPath);
} catch (error) {
  await runner.close();
  await server.close();
  throw error;
}
