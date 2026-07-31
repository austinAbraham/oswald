/**
 * `oswald audit` — inspect the persistent, tamper-evident audit ledger.
 *
 *   oswald audit                      # readable summary + tail of recent records
 *   oswald audit export --format csv  # bundle the ledger for compliance review
 *   oswald audit verify               # strict hash-chain walk (first broken link)
 *
 * The ledger (`<artifact_dir>/audit.jsonl`) is written fail-open by the
 * pipeline; reading it back here is STRICT — `verify` exits non-zero on the
 * first broken link so automation can gate on ledger integrity.
 *
 * `-C/--cwd` (and `-n/--tail`) live on the parent `audit` command; commander
 * parses parent options wherever they appear, so subcommand actions read the
 * merged view via `optsWithGlobals()`.
 */
import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import {
  AuditLedger,
  type AuditRecord,
  type AuditVerifyReport,
} from "../../core/audit/index.js";
import { logger } from "../../core/logging/index.js";
import { resolveConfig } from "./_config.js";

const ShowOptionsSchema = z.object({
  tail: z.coerce.number().int().positive().default(20),
  cwd: z.string(),
});

const ExportOptionsSchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  out: z.string().optional(),
  cwd: z.string(),
});

const VerifyOptionsSchema = z.object({
  cwd: z.string(),
});

export function registerAudit(program: Command): void {
  const audit = program
    .command("audit")
    .description("Inspect the tamper-evident audit ledger (JSONL + hash chain)")
    .option("-n, --tail <n>", "number of recent records to show", "20")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald audit                          # summary + recent records\n  oswald audit -n 50                    # longer tail\n  oswald audit export --format json     # JSON bundle to stdout\n  oswald audit export --format csv --out audit.csv\n  oswald audit verify                   # strict hash-chain check",
    )
    .action(async (raw: unknown) => {
      const opts = ShowOptionsSchema.parse(raw);
      const ledger = await openLedger(opts.cwd);
      const { records, malformedLines } = await ledger.readAll();

      if (records.length === 0 && malformedLines.length === 0) {
        logger.info(
          `no audit ledger records yet (${ledger.relativePath}) — run a pipeline command to start the trail`,
        );
        process.exitCode = 0;
        return;
      }

      const counts = new Map<string, number>();
      for (const r of records) {
        counts.set(r.event, (counts.get(r.event) ?? 0) + 1);
      }
      logger.info(`audit ledger: ${ledger.relativePath}`);
      logger.info(
        `  records: ${records.length} (${[...counts.entries()]
          .map(([event, n]) => `${event}=${n}`)
          .join(", ")})`,
      );
      if (malformedLines.length > 0) {
        logger.warn(
          `  malformed line(s): ${malformedLines.join(", ")} — run 'oswald audit verify'`,
        );
      }

      const chain = await ledger.verify();
      if (chain.ok) {
        logger.success(`  chain: intact (${chain.records} records verified)`);
      } else {
        logger.warn(
          `  chain: BROKEN at line ${chain.brokenAt?.line} — ${chain.brokenAt?.reason}`,
        );
      }

      logger.info(`  last ${Math.min(opts.tail, records.length)} record(s):`);
      for (const r of records.slice(-opts.tail)) {
        logger.info(`    #${r.seq} ${r.ts} ${r.event}: ${summarize(r)}`);
      }
      process.exitCode = 0;
    });

  audit
    .command("export")
    .description("Bundle the audit ledger for compliance review (json|csv)")
    .option("--format <format>", "output format: json|csv", "json")
    .option("--out <file>", "write to a file (default: stdout)")
    .action(async (_raw: unknown, cmd: Command) => {
      const opts = ExportOptionsSchema.parse(cmd.optsWithGlobals());
      const ledger = await openLedger(opts.cwd);
      try {
        if (opts.out) {
          const dest = await ledger.exportToFile(opts.format, opts.out);
          logger.success(
            `audit export: wrote ${path.relative(path.resolve(opts.cwd), dest) || dest} (${opts.format})`,
          );
        } else {
          process.stdout.write(await ledger.export(opts.format));
        }
        process.exitCode = 0;
      } catch (err) {
        logger.error(
          `audit export failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
      }
    });

  audit
    .command("verify")
    .description("Walk the hash chain and report the first broken link")
    .action(async (_raw: unknown, cmd: Command) => {
      const opts = VerifyOptionsSchema.parse(cmd.optsWithGlobals());
      const ledger = await openLedger(opts.cwd);
      const report = await ledger.verify();
      if (report.ok) {
        logger.success(
          report.records === 0
            ? `audit verify: no ledger records yet (${ledger.relativePath})`
            : `audit verify: chain intact — ${report.records} record(s) verified`,
        );
        process.exitCode = 0;
        return;
      }
      reportBrokenChain(report);
      process.exitCode = 1;
    });
}

async function openLedger(cwd: string): Promise<AuditLedger> {
  const root = path.resolve(cwd);
  const config = await resolveConfig(root);
  return new AuditLedger(root, {
    artifactDir: config.paths.artifact_dir,
    logger,
  });
}

function reportBrokenChain(report: AuditVerifyReport): void {
  logger.error(
    `audit verify: chain BROKEN at line ${report.brokenAt?.line} — ${report.brokenAt?.reason}`,
  );
  logger.error(
    `  ${report.records} record(s) verified before the break; treat everything after line ${report.brokenAt?.line} as untrusted`,
  );
}

/** One-line human summary of a record for the tail view. */
function summarize(record: AuditRecord): string {
  const d = record.data;
  const ticket = typeof d.ticket === "string" ? ` [${d.ticket}]` : "";
  switch (record.event) {
    case "approval_decision":
      return `${String(d.action)} → ${String(d.decision)} (consent=${String(d.consent)}, policy=${String(d.policy_gate)})${ticket}`;
    case "step_outcome":
      return `${String(d.command)} exit ${String(d.exit_code)}${
        d.phase_after ? ` — phase ${String(d.phase_before ?? "?")} → ${String(d.phase_after)}` : ""
      }${ticket}`;
    case "sql_validated":
      return `${String(d.keyword ?? "?")} ${d.allowed ? "allowed" : `BLOCKED (${String(d.reason ?? "")})`} sha256=${String(d.sql_sha256).slice(0, 12)}…`;
    case "sql_executed":
      return `${String(d.query)} ${d.ok ? `ok (${String(d.rows)} rows)` : `FAILED (${String(d.error ?? "")})`} sha256=${String(d.sql_sha256).slice(0, 12)}…${ticket}`;
    case "provider_fallback":
      return `${String(d.requested)} → ${String(d.used)} (${String(d.reason)})`;
    case "redaction_applied":
      return `${String(d.count)} value(s) redacted`;
    case "sanitizer_detection":
      return `injection pattern(s) in ${String(d.source)} (severity=${String(d.highest_severity)})`;
    default:
      return JSON.stringify(d).slice(0, 120);
  }
}
