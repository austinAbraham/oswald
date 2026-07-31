import * as path from "node:path";
import type { Command } from "commander";
import { logger } from "../../core/logging/index.js";
import {
  readState,
  StateError,
  type OswaldState,
} from "../../core/state/index.js";
import {
  recommendNextCommand,
  nextState,
} from "../../core/workflow/index.js";
import { ArtifactManager } from "../../core/artifacts/index.js";
import { explainNextStep } from "./_explain.js";
import { resolveConfig } from "./_config.js";

/**
 * Commands that take a `<ticket>` positional argument. `next --run` looks the
 * ticket up in state and supplies it when dispatching one of these; `run`
 * supplies its explicit `<ticket>` argument.
 */
export const TICKET_COMMANDS = new Set([
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
    .option(
      "--explain",
      "explain WHY the command is next (phase, inputs, gates, tools, consent); read-only",
    )
    .addHelpText(
      "after",
      "\nExamples:\n  oswald next\n  oswald next --explain\n  oswald next --run",
    )
    .action(async (opts: { cwd: string; run?: boolean; explain?: boolean }) => {
      const root = path.resolve(opts.cwd);
      let state: OswaldState;
      try {
        state = await readState(root);
      } catch (err) {
        if (err instanceof StateError) {
          logger.warn("Oswald is not initialized here.");
          logger.info("  next:  oswald init");
          process.exitCode = 0;
          return;
        }
        throw err;
      }
      const phase = state.status.phase;
      const ticketId = state.ticket.id;

      // --explain: deterministic, read-only teaching output appended after the
      // default lines. It never changes the default (no-flag) output.
      const printExplanation = async (): Promise<void> => {
        const config = await resolveConfig(root);
        const artifacts = new ArtifactManager(root, {
          artifactDir: config.paths.artifact_dir,
        });
        for (const line of await explainNextStep({ state, config, artifacts })) {
          logger.info(line);
        }
      };

      const cmd = recommendNextCommand(phase);
      const successor = nextState(phase);
      logger.info(`current phase: ${phase}`);

      if (!cmd) {
        logger.success(`phase '${phase}' is terminal — nothing to run`);
        if (opts.explain) {
          await printExplanation();
        }
        process.exitCode = 0;
        return;
      }

      logger.success(`recommended:   oswald ${cmd}`);
      if (successor) {
        logger.info(`  → advances toward phase '${successor}'`);
      }

      if (opts.explain) {
        await printExplanation();
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
