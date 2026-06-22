import * as path from "node:path";
import type { Command } from "commander";
import { logger } from "../../core/logging/index.js";
import { runDiagnostics } from "../../core/doctor/index.js";
import {
  MockTicketProvider,
  MockWarehouseProvider,
  MockRepoProvider,
  MockDocumentProvider,
} from "../../tools/providers/mock/index.js";
import type { ToolProvider } from "../../tools/providers/types.js";

const STATUS_LABEL: Record<string, string> = {
  ok: "ok  ",
  warn: "warn",
  fail: "FAIL",
};

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose the Oswald environment (config, state, providers, policy)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .action(async (opts: { cwd: string }) => {
      const root = path.resolve(opts.cwd);

      // In the current (offline) tier the providers are the mocks; this is also
      // what powers the data-residency story. MCP-backed providers slot in here
      // once the MCP seam is wired.
      const providers: ToolProvider[] = [
        new MockTicketProvider(),
        new MockWarehouseProvider(),
        new MockRepoProvider({ cwd: root }),
        new MockDocumentProvider(),
      ];

      const report = await runDiagnostics({ cwd: root, providers });

      for (const c of report.checks) {
        const line = `${STATUS_LABEL[c.status] ?? c.status}  ${c.name}: ${c.detail}`;
        if (c.status === "fail") logger.error(line);
        else if (c.status === "warn") logger.warn(line);
        else logger.info(line);
      }

      for (const p of report.providers) {
        const label =
          p.health.state === "ok"
            ? "ok  "
            : p.health.state === "degraded"
              ? "warn"
              : "warn";
        logger.info(
          `${label}  provider ${p.name} (${p.kind}): ${p.health.state} — ${p.health.detail} [${p.capabilityCount} cap]`,
        );
      }

      if (report.policyMode) {
        logger.info(
          `info  policy: ${report.policyMode.mode}; mask_sensitive=${report.policyMode.maskSensitiveValues}; max_result_rows=${report.policyMode.maxResultRows}`,
        );
        logger.info(
          `info  policy.require_approval_for: ${report.policyMode.requireApprovalFor.join(", ") || "—"}`,
        );
        logger.info(
          `info  policy.prohibit: ${report.policyMode.prohibit.join(", ") || "—"}`,
        );
      }

      if (report.ok) {
        logger.success("doctor: all checks passed");
        if (report.recommendedNext) {
          logger.info(`  next:  oswald ${report.recommendedNext}`);
        }
        process.exitCode = 0;
      } else {
        const failures = report.checks.filter((c) => c.status === "fail").length;
        logger.warn(`doctor: ${failures} check(s) failed`);
        process.exitCode = 1;
      }
    });
}
