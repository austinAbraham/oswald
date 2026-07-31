import * as path from "node:path";
import type { Command } from "commander";
import { logger } from "../../core/logging/index.js";
import { runDiagnostics } from "../../core/doctor/index.js";
import { acceptDriftBaselines } from "../../core/drift/index.js";
import { ArtifactManager } from "../../core/artifacts/index.js";
import {
  readState,
  writeState,
  DEFAULT_ARTIFACT_DIR,
} from "../../core/state/index.js";
import { systemClock } from "../../utils/time.js";
import { resolveConfig } from "./_config.js";
import {
  MockTicketProvider,
  MockWarehouseProvider,
  MockRepoProvider,
  MockDocumentProvider,
} from "../../tools/providers/mock/index.js";
import type { ToolProvider } from "../../tools/providers/types.js";
import { detectSnow } from "../../tools/snowflake/index.js";
import { detectGit } from "../../tools/repo/index.js";

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
    .option(
      "--accept-drift",
      "bless hand-edited artifacts: re-hash their current content into the drift baseline (keeps the edits) before diagnosing",
    )
    .action(async (opts: { cwd: string; acceptDrift?: boolean }) => {
      const root = path.resolve(opts.cwd);

      // Explicit opt-in mutation: re-baseline hand-edited artifacts so a
      // deliberate human edit can be kept without --allow-drift at ship time.
      // Everything after this stays report-only.
      if (opts.acceptDrift) {
        try {
          const config = await resolveConfig(root);
          const artifactDir = config.paths.artifact_dir || DEFAULT_ARTIFACT_DIR;
          const state = await readState(root, artifactDir);
          const artifacts = new ArtifactManager(root, { artifactDir });
          const { state: next, rebaselined } = await acceptDriftBaselines({
            state,
            artifacts,
          });
          if (rebaselined.length > 0) {
            next.timestamps.updated_at = systemClock.nowIso();
            await writeState(next, artifactDir);
            logger.info(
              `accept-drift: re-baselined ${rebaselined.length} hand-edited artifact(s): ${rebaselined.join(", ")}`,
            );
          } else {
            logger.info("accept-drift: no hand-edited artifacts to re-baseline");
          }
        } catch (err) {
          logger.warn(
            `accept-drift: skipped — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

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

      // Drift detail (report-only here; `oswald ship` is the hard gate).
      for (const f of report.drift?.drifted ?? []) {
        logger.warn(`      drift: ${f.phase} ← ${f.upstream}: ${f.detail}`);
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

      // Optional runtime probe: is the Snowflake CLI (`snow`) available for the
      // non-MCP EDA execution path? Purely informational — never a failure.
      const snow = detectSnow();
      logger.info(
        snow.available
          ? `ok    runtime snow (Snowflake CLI): available${snow.version ? ` — ${snow.version}` : ""}`
          : "info  runtime snow (Snowflake CLI): not found on PATH (--warehouse snowflake falls back to the mock)",
      );

      // Same informational probe for the real repo provider path (`repo.provider:
      // git`). Purely informational — never a failure.
      const git = detectGit();
      logger.info(
        git.available
          ? `ok    runtime git: available${git.version ? ` — ${git.version}` : ""}`
          : "info  runtime git: not found on PATH (repo.provider 'git' falls back to the mock)",
      );

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
