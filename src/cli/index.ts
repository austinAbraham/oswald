#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { Command } from "commander";
import { registerCommands } from "./commands/index.js";
import { logger } from "../core/logging/index.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("oswald")
    .description(
      "Oswald the Analytical Octopus — a runtime-agnostic, MCP-native workflow layer for analytical-engineering AI agents.",
    )
    .version("0.1.0");

  registerCommands(program);
  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

/**
 * Only auto-run when invoked as the CLI entrypoint (e.g. `node dist/cli/index.js`
 * or the `oswald` bin), NOT when imported by tests/other modules. This keeps
 * `buildProgram` importable for integration tests without parsing the test
 * runner's argv.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
