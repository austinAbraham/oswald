/**
 * `oswald status` — at-a-glance, read-only run dashboard.
 *
 * One screen: current phase, ticket, requirements completeness, blockers,
 * which canonical artifacts exist vs are missing, provider/tool health (the
 * same cheap probes `doctor` runs, including the `snow` CLI detection), and
 * the recommended next command plus its successor. Pure composition of
 * existing readers — no writes, no side effects, always exit 0 unless the
 * command itself throws.
 */
import * as path from "node:path";
import type { Command } from "commander";
import { ConfigError } from "../../core/config/index.js";
import { logger } from "../../core/logging/index.js";
import {
  buildStatusReport,
  renderProgress,
  type StatusReport,
} from "../../core/status/index.js";
import { resolveConfig } from "./_config.js";
import {
  MockTicketProvider,
  MockWarehouseProvider,
  MockRepoProvider,
  MockDocumentProvider,
} from "../../tools/providers/mock/index.js";
import type { ToolProvider } from "../../tools/providers/types.js";
import { detectSnow } from "../../tools/snowflake/index.js";

function renderText(report: StatusReport): void {
  if (report.initialized && report.project && report.phase) {
    logger.info(`project:      ${report.project.name}`);
    logger.info(`phase:        ${report.phase}`);
    logger.info(
      report.ticket.id
        ? `ticket:       ${report.ticket.id} (${report.ticket.provider ?? "provider unknown"})`
        : "ticket:       none recorded",
    );
    if (report.requirements) {
      const q = report.requirements.unresolvedQuestions;
      logger.info(
        `requirements: ${renderProgress(report.requirements.completeness)} complete; ${q} unresolved question(s); acceptance criteria ${report.requirements.acceptanceCriteriaFound ? "found" : "not found"}`,
      );
    }
    if (report.blockers.length === 0) {
      logger.info("blockers:     none");
    } else {
      logger.warn(`blockers:     ${report.blockers.length}`);
      for (const b of report.blockers) {
        logger.warn(`  - ${b}`);
      }
    }
  } else {
    logger.warn("Oswald is not initialized here.");
    if (report.hint) logger.info(report.hint);
  }

  const present = report.artifacts.filter((a) => a.exists).length;
  logger.info(`artifacts:    ${present}/${report.artifacts.length} present`);
  for (const a of report.artifacts) {
    logger.info(`  ${a.exists ? "present" : "missing"}  ${a.file}`);
  }

  for (const p of report.providers) {
    const label = p.health.state === "ok" ? "ok  " : "warn";
    logger.info(
      `${label}  provider ${p.name} (${p.kind}): ${p.health.state} — ${p.health.detail}`,
    );
  }
  if (report.snow) {
    logger.info(
      report.snow.available
        ? `ok    runtime snow (Snowflake CLI): available${report.snow.version ? ` — ${report.snow.version}` : ""}`
        : "info  runtime snow (Snowflake CLI): not found on PATH (--warehouse snowflake falls back to the mock)",
    );
  }

  if (report.nextCommand) {
    logger.success(`next:         oswald ${report.nextCommand}`);
    if (report.thenCommand) {
      logger.info(`  then:       oswald ${report.thenCommand}`);
    }
  } else if (report.phase === "blocked") {
    logger.warn(
      "phase 'blocked' — resolve the blockers above, then re-run the blocked phase (or 'oswald next')",
    );
  } else if (report.initialized && report.phase) {
    logger.success(`phase '${report.phase}' is terminal — nothing to run`);
  } else {
    logger.info("  next:  oswald init");
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description(
      "Show an at-a-glance, read-only dashboard: phase, ticket, requirements, blockers, artifacts, tool health, next command",
    )
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .option("--json", "emit the report as JSON on stdout")
    .addHelpText(
      "after",
      "\nExamples:\n  oswald status\n  oswald status --json",
    )
    .action(async (opts: { cwd: string; json?: boolean }) => {
      const root = path.resolve(opts.cwd);

      // Honor `paths.artifact_dir` from oswald.yml — the same resolution the
      // pipeline (init / intake / …) uses, so status reads the dir the run
      // actually writes to. Best-effort: an invalid config must not break the
      // read-only dashboard (doctor is the tool that reports config problems),
      // so fall back to the default artifact dir on ConfigError.
      let artifactDir: string | undefined;
      try {
        artifactDir = (await resolveConfig(root)).paths.artifact_dir;
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
      }

      // The same offline provider set `doctor` reports on; MCP-backed
      // providers slot in here once the MCP seam is wired.
      const providers: ToolProvider[] = [
        new MockTicketProvider(),
        new MockWarehouseProvider(),
        new MockRepoProvider({ cwd: root }),
        new MockDocumentProvider(),
      ];

      const report = await buildStatusReport({
        cwd: root,
        providers,
        snow: detectSnow(),
        ...(artifactDir ? { artifactDir } : {}),
      });

      if (opts.json) {
        // Machine-readable: raw JSON on stdout, no logger prefixes.
        console.log(JSON.stringify(report, null, 2));
      } else {
        renderText(report);
      }
      process.exitCode = 0;
    });
}
