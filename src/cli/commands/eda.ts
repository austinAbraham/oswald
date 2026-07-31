import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";
import { selectProviders, type SnowflakeSettings } from "./_providers.js";
import { resolveConfig } from "./_config.js";
import { AuditLedger } from "../../core/audit/index.js";
import { logger } from "../../core/logging/index.js";

const OptionsSchema = z.object({
  warehouse: z.enum(["snowflake", "mock", "none"]).optional(),
  execute: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  tables: z.string().optional(),
  maxRows: z.coerce.number().int().positive().optional(),
  connection: z.string().optional(),
  warehouseCommand: z.string().optional(),
  queryTimeout: z.coerce.number().int().positive().optional(),
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
    .option("--connection <name>", "snow connection NAME (required for --execute with snowflake)")
    .option("--warehouse-command <cmd>", "warehouse CLI invocation (default: 'snow')")
    .option("--query-timeout <ms>", "per-query subprocess timeout in ms")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald eda TICKET-42                                  # dry-run against the mock warehouse\n  oswald eda TICKET-42 --execute                        # run read-only profiling SQL (mock)\n  oswald eda TICKET-42 --warehouse snowflake --connection analytics --execute\n  oswald eda TICKET-42 --warehouse none",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);
      const config = await resolveConfig(cwd);

      const warehouse = opts.warehouse ?? "mock";

      // --dry-run wins over --execute; default is dry-run.
      const execute = Boolean(opts.execute) && !opts.dryRun && warehouse !== "none";

      // Resolve Snowflake settings from config, with CLI flags taking precedence.
      // Only a connection NAME is ever threaded — never credentials.
      const connection = opts.connection ?? config.warehouse.connection;
      const snowflake: SnowflakeSettings = {
        command: opts.warehouseCommand ?? config.warehouse.command,
        ...(connection != null ? { connection } : {}),
        timeoutMs: opts.queryTimeout ?? config.warehouse.timeout_ms,
        dialect: config.warehouse.dialect,
        maxResultRows: opts.maxRows ?? config.policies.warehouse.max_result_rows,
        maskSensitive: config.policies.privacy.mask_sensitive_values,
      };

      // Real Snowflake execution requires an explicit connection NAME. Omission
      // is only tolerated in dry-run (no queries run); refuse --execute clearly.
      if (warehouse === "snowflake" && execute && !connection) {
        logger.error(
          "eda --warehouse snowflake --execute requires a connection: pass --connection <name> or set warehouse.connection in oswald.yml. Only a connection NAME is used (never credentials).",
        );
        process.exitCode = 2;
        return;
      }

      // One ledger instance owns the hash chain for this run: provider
      // fallbacks recorded here and the tentacle's events share it.
      const audit = new AuditLedger(cwd, {
        artifactDir: config.paths.artifact_dir,
        logger,
      });
      const providers = selectProviders({ cwd, warehouse, snowflake, audit });

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
        audit,
      });
      process.exitCode = exitCode;
    });
}
