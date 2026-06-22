/**
 * `compact` — context-rot reduction.
 *
 * Summarizes the current artifact set into a single `current_context.md` (the
 * one file a fresh agent run should read first), then archives the noisy
 * intermediate artifacts it just summarized. It DELIBERATELY preserves the
 * decision log and evidence/source-bearing summaries so nothing load-bearing is
 * lost, and it updates `state.timestamps` to record the compaction.
 *
 * It does not change the workflow phase — compaction is orthogonal to pipeline
 * progress and can be run at any time.
 */
import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { buildContext } from "../../tentacles/base.js";
import { readState, writeState, DEFAULT_ARTIFACT_DIR } from "../../core/state/index.js";
import { logger } from "../../core/logging/index.js";
import { resolveConfig } from "./_config.js";

const OptionsSchema = z.object({ cwd: z.string() });

const CURRENT_CONTEXT = "current_context.md";

/** Artifacts that, if present, get a one-line summary in current_context.md. */
const SUMMARY_SOURCES: Array<{ name: string; label: string }> = [
  { name: "intake.md", label: "Intake brief" },
  { name: "requirements.md", label: "Requirements" },
  { name: "acceptance_criteria.md", label: "Acceptance criteria" },
  { name: "open_questions.md", label: "Open questions" },
  { name: "context_pack.md", label: "Context pack" },
  { name: "eda_report.md", label: "EDA report" },
  { name: "semantic_model_plan.md", label: "Design / semantic plan" },
  { name: "model_plan.md", label: "Model plan" },
  { name: "implementation_plan.md", label: "Implementation plan" },
  { name: "validation_report.md", label: "Validation report" },
  { name: "pr_summary.md", label: "PR summary" },
];

/**
 * Artifacts that are PRESERVED across compaction (never archived): the decision
 * log + evidence/source-bearing references + the compaction output itself.
 */
const PRESERVE = new Set([
  "state.yml",
  "decision_log.md",
  "current_context.md",
  "source_inventory.md",
  "acceptance_criteria.md",
  "known_limitations.md",
  "ship_record.md",
  "audit.log",
]);

/** Noisy intermediates safe to archive after they are summarized. */
const ARCHIVABLE = [
  "open_questions.md",
  "scope_risks.md",
  "clarification_comment.md",
  "existing_assets.md",
  "lineage_notes.md",
  "grain_analysis.md",
  "join_analysis.md",
  "data_quality_findings.md",
  "test_results.md",
  "build_preview.md",
];

/** Extract the first non-heading, non-empty line of a markdown doc as its gist. */
function firstGist(md: string): string {
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line.replace(/^_+|_+$/g, "").slice(0, 200);
  }
  return "(no summary line)";
}

export function registerCompact(program: Command): void {
  program
    .command("compact")
    .description("Summarize artifacts into current_context.md and archive noisy intermediates")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald compact\n\nPreserves decision_log.md + evidence; archives summarized intermediates.",
    )
    .action(async (raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      try {
        const ctx = await buildContext({
          projectRoot: cwd,
          config: await resolveConfig(cwd),
          options: {},
        });
        const artifactDir = ctx.config.paths.artifact_dir || DEFAULT_ARTIFACT_DIR;

        // --- Build the summary from whatever artifacts exist. --------------
        const summaryLines: Array<{ label: string; name: string; gist: string }> = [];
        for (const src of SUMMARY_SOURCES) {
          if (await ctx.artifacts.exists(src.name)) {
            const md = await ctx.artifacts.read(src.name);
            summaryLines.push({ label: src.label, name: src.name, gist: firstGist(md) });
          }
        }

        const decisionLogPresent = await ctx.artifacts.exists("decision_log.md");
        const stamp = ctx.clock.nowIso();

        const currentContextMd = ctx.artifacts.renderMarkdown({
          title: "Current Context",
          summary: `Compacted snapshot at ${stamp} — read this first. Full detail lives in the linked artifacts (and \`archive/\` for compacted intermediates).`,
          sections: [
            {
              heading: "Pipeline State",
              body: [
                `- **Phase:** ${ctx.state.status.phase}`,
                `- **Last command:** ${ctx.state.status.last_command ?? "—"}`,
                `- **Next recommended:** ${ctx.state.status.next_recommended_command ?? "—"}`,
                `- **Ticket:** ${ctx.state.ticket.id ?? "—"}`,
                `- **Completeness:** ${(ctx.state.requirements.completeness * 100).toFixed(0)}%`,
                `- **Blockers:** ${ctx.state.status.blockers.length}`,
              ].join("\n"),
            },
            {
              heading: "Artifact Summary",
              body:
                summaryLines.length > 0
                  ? summaryLines
                      .map((s) => `- **${s.label}** (\`${s.name}\`): ${s.gist}`)
                      .join("\n")
                  : "_No summarizable artifacts found._",
            },
            {
              heading: "Open Questions / Unresolved",
              body:
                ctx.state.requirements.unresolved_questions.length > 0
                  ? ctx.state.requirements.unresolved_questions
                      .map((q) => `- ${q}`)
                      .join("\n")
                  : "_None recorded in state._",
            },
            {
              heading: "Preserved References",
              body: [
                `- Decision log: ${decisionLogPresent ? "`decision_log.md` (preserved)" : "_none yet_"}`,
                "- Evidence/source refs and acceptance criteria are preserved, not archived.",
              ].join("\n"),
            },
          ],
        });

        const { content } = ctx.policy.sensitive.redactArtifactContent(currentContextMd);
        const writtenPath = await ctx.artifacts.write(CURRENT_CONTEXT, content);

        // --- Archive the noisy intermediates we just summarized. -----------
        const archived: string[] = [];
        for (const name of ARCHIVABLE) {
          if (PRESERVE.has(name)) continue;
          if (await ctx.artifacts.exists(name)) {
            const dest = await ctx.artifacts.archive(name);
            if (dest) archived.push(name);
          }
        }

        // --- Touch state timestamp (no phase change). ----------------------
        const state = await readState(cwd, artifactDir);
        state.timestamps.updated_at = ctx.clock.nowIso();
        await writeState(state, artifactDir);

        // --- Standard output block. ----------------------------------------
        logger.success(
          `compact: summarized ${summaryLines.length} artifact(s) into ${CURRENT_CONTEXT}; archived ${archived.length} intermediate(s).`,
        );
        logger.info(`  artifacts:`);
        logger.info(`    - ${path.relative(cwd, writtenPath) || writtenPath}`);
        if (archived.length > 0) {
          logger.info(`  archived (${archived.length}): ${archived.join(", ")}`);
        }
        logger.info(`  preserved: decision_log.md + evidence/source refs`);
        const next = ctx.state.status.next_recommended_command;
        logger.info(next ? `  next:  oswald ${next}` : "  next:  (pipeline phase unchanged)");
        process.exitCode = 0;
      } catch (err) {
        logger.error(
          `compact failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
      }
    });
}
