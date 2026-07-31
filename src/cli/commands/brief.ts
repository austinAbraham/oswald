/**
 * `brief` — stakeholder brief generator.
 *
 * Assembles an exec-readable status brief from artifacts that already exist:
 * what was asked, where the work stands (in business terms), what is confirmed
 * vs assumed vs still open (evidence-ledger tallies), blockers and who is
 * needed to unblock, and known limitations. Plain business language throughout.
 *
 * Deterministic and read-only over the pipeline: it runs no new analysis and
 * changes no workflow phase. Its only write is the `brief.md` artifact itself
 * (skipped with `--stdout-only`), and the brief is always printed. It degrades
 * gracefully — missing artifacts become "not yet known" statements, never
 * errors.
 *
 * Artifact bodies are UNTRUSTED (they can embed wrapped ticket text): they are
 * neutralized via the sanitizer before any gisting/pattern reading, and fenced
 * code blocks — where the wrapped ticket copy lives — are excluded from
 * evidence tallies and section extraction so ticket content cannot forge
 * tallies or steer the stakeholder list. The rendered brief is PII-redacted
 * before persisting — sources were already redacted at write time, and nothing
 * here un-redacts.
 */
import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { buildContext, type TentacleContext } from "../../tentacles/base.js";
import { ARTIFACT_FILES } from "../../core/artifacts/index.js";
import { logger } from "../../core/logging/index.js";
import { extractSectionItems } from "../../tentacles/delivery/parse.js";
import { resolveConfig } from "./_config.js";
import { firstGist } from "./compact.js";
import {
  addTallies,
  describeEvidence,
  describePhase,
  emptyTally,
  extractStakeholders,
  stripFencedBlocks,
  tallyEvidenceTags,
  totalTally,
  type EvidenceTally,
} from "./_brief.js";

const OptionsSchema = z.object({
  cwd: z.string(),
  stdoutOnly: z.boolean().optional(),
});

const BRIEF = ARTIFACT_FILES.brief;

/**
 * The evidence-ledger-bearing artifact scanned per phase. ONE artifact per
 * phase — several tentacles render the same ledger into more than one artifact
 * (e.g. intake.md and requirements.md), so scanning everything would
 * double-count. Fenced code blocks are additionally skipped by
 * `tallyEvidenceTags`, so wrapped ticket text (intake.md) and fenced re-quotes
 * of earlier artifacts (pr_summary.md quoting validation_report.md) cannot
 * forge or double-count rows either.
 */
const EVIDENCE_SOURCES: Array<{ name: string; label: string }> = [
  { name: "intake.md", label: "Intake" },
  { name: "open_questions.md", label: "Clarification" },
  { name: "context_pack.md", label: "Context" },
  { name: "eda_report.md", label: "Data profiling" },
  { name: "semantic_model_plan.md", label: "Design" },
  { name: "implementation_plan.md", label: "Planning" },
  { name: "validation_report.md", label: "Validation" },
  { name: "pr_summary.md", label: "Delivery" },
];

/**
 * Read an artifact if present and neutralize it (bodies may embed wrapped
 * ticket text — untrusted). Returns null when missing (degrade).
 */
async function readNeutralized(
  ctx: TentacleContext,
  name: string,
): Promise<string | null> {
  if (!(await ctx.artifacts.exists(name))) return null;
  const body = await ctx.artifacts.read(name);
  return ctx.policy.sanitizer.wrap(body, name).neutralized;
}

function bulletList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

export function registerBrief(program: Command): void {
  program
    .command("brief")
    .description(
      "Assemble an exec-readable stakeholder brief from existing artifacts and write brief.md",
    )
    .option("--stdout-only", "print the brief without writing brief.md")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald brief\n  oswald brief --stdout-only\n\nReads existing artifacts only — runs no new analysis and changes no workflow state.",
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

        // --- What was asked (intake gist; degrade when missing). ----------
        const intake = await readNeutralized(ctx, "intake.md");
        const asked =
          intake === null
            ? "_Not yet captured — the request has not been taken in (run `oswald intake`)._"
            : firstGist(intake);

        // --- Evidence tallies across the phase ledgers. --------------------
        let tally: EvidenceTally = emptyTally();
        const scanned: string[] = [];
        for (const src of EVIDENCE_SOURCES) {
          const body =
            src.name === "intake.md" ? intake : await readNeutralized(ctx, src.name);
          if (body === null) continue;
          tally = addTallies(tally, tallyEvidenceTags(body));
          scanned.push(src.label);
        }

        // --- Blockers + who is needed to unblock. --------------------------
        // Fenced blocks are stripped before extraction: intake.md embeds the
        // raw wrapped ticket in a fence, and a stakeholder-looking heading in
        // that untrusted copy must not steer this list. The heading match is
        // anchored so only a real "Stakeholders" section qualifies.
        const openQuestionsBody = await readNeutralized(ctx, "open_questions.md");
        const stakeholders = extractStakeholders(
          extractSectionItems(stripFencedBlocks(intake), /^stakeholders?\b/i),
          stripFencedBlocks(openQuestionsBody),
        );
        const blockers = ctx.state.status.blockers;
        const unresolved = ctx.state.requirements.unresolved_questions;

        // --- Known limitations. ---------------------------------------------
        const limitations = await readNeutralized(ctx, "known_limitations.md");
        const limitationItems = extractSectionItems(
          stripFencedBlocks(limitations),
          /(not verified|limitation|known issue|caveat)/i,
        );

        // --- Render the brief (plain business language). --------------------
        const phase = ctx.state.status.phase;
        const stamp = ctx.clock.nowIso();
        const briefMd = ctx.artifacts.renderMarkdown({
          title: `Stakeholder Brief: ${ctx.state.ticket.id ?? ctx.state.project.name}`,
          summary: `Status as of ${stamp}. Everything below comes from the project's recorded artifacts — no new analysis was run for this brief.`,
          sections: [
            { heading: "What Was Asked", body: asked },
            {
              heading: "Where It Stands",
              body: [
                describePhase(phase),
                "",
                `- **Requirements understood:** ${(ctx.state.requirements.completeness * 100).toFixed(0)}%`,
                `- **Last step completed:** ${ctx.state.status.last_command ?? "none yet"}`,
                `- **Next step:** ${
                  ctx.state.status.next_recommended_command
                    ? `\`oswald ${ctx.state.status.next_recommended_command}\``
                    : "none — see blockers or completion above"
                }`,
              ].join("\n"),
            },
            {
              heading: "What We Know vs. What We Don't",
              body: [
                describeEvidence(tally),
                "",
                ...(totalTally(tally) > 0
                  ? [
                      "| Standing | Count | What it means |",
                      "| --- | --- | --- |",
                      `| Confirmed | ${tally.confirmed} | Stated directly in the ticket or source material. |`,
                      `| Derived | ${tally.inferred} | Worked out from the confirmed evidence. |`,
                      `| Assumed | ${tally.assumption} | A default we chose — needs a human to confirm. |`,
                      `| Open | ${tally.open_question} | Unknown — someone must answer before we rely on it. |`,
                      "",
                      `_Based on: ${scanned.join(", ")}._`,
                    ]
                  : ["_No phase has recorded evidence yet._"]),
              ].join("\n"),
            },
            {
              heading: "Blockers & Who Is Needed",
              body: [
                blockers.length > 0
                  ? bulletList(blockers, "")
                  : "_No blockers recorded — work can proceed._",
                "",
                "**People/teams to involve:**",
                "",
                bulletList(
                  stakeholders,
                  "no specific stakeholders identified yet",
                ),
              ].join("\n"),
            },
            {
              heading: "Open Questions",
              body: bulletList(unresolved, "none recorded"),
            },
            {
              heading: "Known Limitations",
              body:
                limitations === null
                  ? "_None recorded yet — limitations are captured when the work is validated._"
                  : limitationItems.length > 0
                    ? bulletList(limitationItems, "")
                    : firstGist(limitations),
            },
          ],
        });

        // Redact before persisting/printing (sources are already redacted at
        // write time; this is defense in depth and never un-redacts).
        const { content } = ctx.policy.sensitive.redactArtifactContent(briefMd);

        let writtenPath: string | null = null;
        if (!opts.stdoutOnly) {
          writtenPath = await ctx.artifacts.write(BRIEF, content);
        }

        // --- Print the brief itself, then the standard output block. -------
        console.log(content);
        logger.success(
          `brief: stakeholder brief assembled from ${scanned.length} phase artifact(s).`,
        );
        if (writtenPath) {
          logger.info(`  artifacts:`);
          logger.info(`    - ${path.relative(cwd, writtenPath) || writtenPath}`);
        } else {
          logger.info("  artifacts: none written (--stdout-only)");
        }
        const next = ctx.state.status.next_recommended_command;
        logger.info(next ? `  next:  oswald ${next}` : "  next:  (pipeline phase unchanged)");
        process.exitCode = 0;
      } catch (err) {
        logger.error(
          `brief failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
      }
    });
}
