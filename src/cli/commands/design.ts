import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";

const OptionsSchema = z.object({ cwd: z.string() });

export function registerDesign(program: Command): void {
  program
    .command("design")
    .description("Convert business language into precise metric/semantic definitions")
    .argument("<ticket>", "ticket id this design targets")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText("after", "\nExamples:\n  oswald design TICKET-42")
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      const { exitCode } = await runTentacleCommand({
        id: "design",
        command: "design",
        cwd,
        ticketId: ticket,
      });
      process.exitCode = exitCode;
    });
}
