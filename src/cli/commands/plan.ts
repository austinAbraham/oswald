import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";

const OptionsSchema = z.object({ cwd: z.string() });

export function registerPlan(program: Command): void {
  program
    .command("plan")
    .description("Plan layered dbt models + tests and emit an intended-changes manifest")
    .argument("<ticket>", "ticket id this plan targets")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald plan TICKET-42\n\nNote: planning is read-only w.r.t. project files — it writes plans, not models.",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      const { exitCode } = await runTentacleCommand({
        id: "planning",
        command: "plan",
        cwd,
        ticketId: ticket,
      });
      process.exitCode = exitCode;
    });
}
