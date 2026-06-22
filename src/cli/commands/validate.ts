import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";

const OptionsSchema = z.object({
  command: z.array(z.string()).optional(),
  dbt: z.boolean().optional(),
  skipExternal: z.boolean().optional(),
  dbtProjectDir: z.string().optional(),
  dbtCommand: z.string().optional(),
  dbtTarget: z.string().optional(),
  cwd: z.string(),
});

export function registerValidate(program: Command): void {
  program
    .command("validate")
    .description("Verify generated work against acceptance criteria (build/test guarded)")
    .argument("<ticket>", "ticket id this validation targets")
    .option(
      "--command <cmd>",
      "extra validation command to run (repeatable)",
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .option(
      "--dbt",
      "run real dbt build + test via the runner when a dbt project is detected (turns on external execution)",
    )
    .option("--skip-external", "stay fully local: never run any external command (default)")
    .option("--dbt-project-dir <dir>", "explicit dbt project dir (else auto-detected)")
    .option("--dbt-command <cmd>", "dbt invocation (e.g. 'uvx --from dbt-core --with dbt-duckdb dbt')")
    .option("--dbt-target <target>", "dbt target to build/test against (must look like a sandbox)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald validate TICKET-42                 # local-only classification (default)\n  oswald validate TICKET-42 --dbt           # REAL dbt build + test against the sandbox\n  oswald validate TICKET-42 --command 'pytest -q'\n\nNote: a blocking failure parks the workflow in 'blocked' and exits non-zero.",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      // Default is fully-local (deterministic, no spawn). Passing `--dbt` (or any
      // explicit dbt knob) opts INTO real external execution; `--skip-external`
      // always forces local even if `--dbt` is present.
      const wantsExternal =
        Boolean(opts.dbt) ||
        Boolean(opts.dbtProjectDir) ||
        Boolean(opts.dbtCommand) ||
        Boolean(opts.dbtTarget);
      const skipExternal = opts.skipExternal ? true : !wantsExternal;

      const options: Record<string, unknown> = { skipExternal };
      if (opts.command && opts.command.length > 0) {
        options.validationCommands = opts.command;
      }
      if (opts.dbt) options.dbtProject = true;
      if (opts.dbtProjectDir) options.dbtProjectDir = opts.dbtProjectDir;
      if (opts.dbtCommand) options.dbtCommand = opts.dbtCommand;
      if (opts.dbtTarget) options.dbtTarget = opts.dbtTarget;

      const { exitCode } = await runTentacleCommand({
        id: "validate",
        command: "validate",
        cwd,
        ticketId: ticket,
        options,
      });
      process.exitCode = exitCode;
    });
}
