import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";
import { selectProviders } from "./_providers.js";

const OptionsSchema = z.object({
  warehouse: z.enum(["snowflake", "mock", "none"]).optional(),
  execute: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  tables: z.string().optional(),
  maxRows: z.coerce.number().int().positive().optional(),
  cwd: z.string(),
});

export function registerEda(program: Command): void {
  program
    .command("eda")
    .description("Generate (and optionally run) read-only EDA SQL against a warehouse")
    .argument("<ticket>", "ticket id this EDA targets")
    .option("--warehouse <kind>", "warehouse: snowflake|mock|none (default: mock)")
    .option("--execute", "actually run the read-only queries (needs provider + policy)")
    .option("--dry-run", "generate SQL + plan only; never execute (default)")
    .option("--tables <csv>", "restrict EDA to these schemas/tables (comma-separated)")
    .option("--max-rows <n>", "cap rows per result (advisory; SQL is LIMIT-capped)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald eda TICKET-42                 # dry-run against the mock warehouse\n  oswald eda TICKET-42 --execute       # run read-only profiling SQL\n  oswald eda TICKET-42 --warehouse none",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      const warehouse = opts.warehouse ?? "mock";
      const providers = selectProviders({ cwd, warehouse });

      // --dry-run wins over --execute; default is dry-run.
      const execute = Boolean(opts.execute) && !opts.dryRun && warehouse !== "none";

      const options: Record<string, unknown> = { execute };
      if (opts.tables) {
        options.schemas = opts.tables
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const { exitCode } = await runTentacleCommand({
        id: "eda",
        command: "eda",
        cwd,
        ticketId: ticket,
        options,
        providers,
      });
      process.exitCode = exitCode;
    });
}
