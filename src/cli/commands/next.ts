import * as path from "node:path";
import type { Command } from "commander";
import { logger } from "../../core/logging/index.js";
import { readState, StateError } from "../../core/state/index.js";
import {
  recommendNextCommand,
  nextState,
} from "../../core/workflow/index.js";

/**
 * Commands that take a `<ticket>` positional argument. `next --run` looks the
 * ticket up in state and supplies it when dispatching one of these.
 */
const TICKET_COMMANDS = new Set([
  "clarify",
  "context",
  "eda",
  "design",
  "plan",
  "build",
  "validate",
  "pr",
  "update-ticket",
  "ship",
]);

export function registerNext(program: Command): void {
  program
    .command("next")
    .description("Show (or, with --run, execute) the recommended next command")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .option("--run", "execute the recommended next command (never skips validation)")
    .addHelpText(
      "after",
      "\nExamples:\n  oswald next\n  oswald next --run",
    )
    .action(async (opts: { cwd: string; run?: boolean }) => {
      const root = path.resolve(opts.cwd);
      let phase;
      let ticketId: string | null = null;
      try {
        const state = await readState(root);
        phase = state.status.phase;
        ticketId = state.ticket.id;
      } catch (err) {
        if (err instanceof StateError) {
          logger.warn("Oswald is not initialized here.");
          logger.info("  next:  oswald init");
          process.exitCode = 0;
          return;
        }
        throw err;
      }

      const cmd = recommendNextCommand(phase);
      const successor = nextState(phase);
      logger.info(`current phase: ${phase}`);

      if (!cmd) {
        logger.success(`phase '${phase}' is terminal — nothing to run`);
        process.exitCode = 0;
        return;
      }

      logger.success(`recommended:   oswald ${cmd}`);
      if (successor) {
        logger.info(`  → advances toward phase '${successor}'`);
      }

      if (!opts.run) {
        process.exitCode = 0;
        return;
      }

      // --- --run: dispatch the recommended command via the program. --------
      if (cmd === "init") {
        logger.warn("next --run: project not yet initialized; run 'oswald init' manually.");
        process.exitCode = 1;
        return;
      }
      const argv = [process.argv[0]!, process.argv[1]!, cmd];
      if (TICKET_COMMANDS.has(cmd)) {
        if (!ticketId) {
          logger.error(
            `next --run: '${cmd}' needs a ticket id but none is recorded in state. Run 'oswald ${cmd} <ticket>' manually.`,
          );
          process.exitCode = 1;
          return;
        }
        argv.push(ticketId);
      }
      argv.push("--cwd", root);

      logger.info(`running: oswald ${argv.slice(2).join(" ")}`);
      await program.parseAsync(argv);
      // The dispatched command sets process.exitCode itself.
    });
}
