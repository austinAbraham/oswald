/**
 * `ship` — the finalize gate.
 *
 * It does NOT do new modeling work; it verifies the pipeline is genuinely
 * shippable and then records that. Guards (any failing → refuse, exit non-zero):
 *   1. The workflow is not in `blocked`, and no blockers are recorded — UNLESS
 *      a `known_limitations.md` documents the exceptions (then it warns but
 *      proceeds, recording the documented exceptions).
 *   2. A validation report exists and did not report blocking failures.
 *   3. A `pr_summary.md` exists (the change is packaged for review).
 *   4. No artifact drift: no upstream artifact was re-generated or edited
 *      after a downstream phase last ran — UNLESS `--allow-drift` explicitly
 *      overrides (then it warns and records the override). Artifacts without
 *      a recorded baseline ("unknown (no baseline)") never block shipping.
 *
 * On success it archives the noisy intermediate phase artifacts (keeping the
 * decision log + evidence-bearing summaries in place), writes a `ship_record.md`,
 * sets state to `shipped`, and clears blockers.
 */
import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { buildContext, advanceWorkflow } from "../../tentacles/base.js";
import { assertLegalTransition } from "../../core/workflow/index.js";
import { checkDrift } from "../../core/drift/index.js";
import { logger } from "../../core/logging/index.js";
import { resolveConfig } from "./_config.js";

const OptionsSchema = z.object({
  cwd: z.string(),
  // Explicit override only — never defaults to true.
  allowDrift: z.boolean().default(false),
});

const PR_SUMMARY = "pr_summary.md";
const VALIDATION_REPORT = "validation_report.md";
const KNOWN_LIMITATIONS = "known_limitations.md";
const SHIP_RECORD = "ship_record.md";

/**
 * Intermediate artifacts that are safe to archive once shipped (context-rot
 * reduction). The evidence-bearing + decision artifacts are deliberately
 * EXCLUDED so they remain available post-ship.
 */
const ARCHIVABLE = [
  "open_questions.md",
  "scope_risks.md",
  "clarification_comment.md",
  "existing_assets.md",
  "lineage_notes.md",
  "source_inventory.md",
  "grain_analysis.md",
  "join_analysis.md",
  "data_quality_findings.md",
  "test_results.md",
  "build_preview.md",
];

export function registerShip(program: Command): void {
  program
    .command("ship")
    .description("Finalize: verify validation + PR summary, archive intermediates, mark shipped")
    .argument("<ticket>", "ticket id to finalize")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .option(
      "--allow-drift",
      "ship despite detected artifact drift (the override is recorded in the ship record)",
    )
    .addHelpText(
      "after",
      "\nExamples:\n  oswald ship TICKET-42\n\nNote: ship refuses to bypass blocking validation failures, and refuses when\nupstream artifacts drifted after downstream phases ran (unless --allow-drift).",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      try {
        const ctx = await buildContext({
          projectRoot: cwd,
          config: await resolveConfig(cwd),
          ticketId: ticket,
          options: {},
        });

        // Pre-flight the state machine BEFORE any side effect: an out-of-order
        // ship must refuse here, while nothing has been archived and no ship
        // record written (advanceWorkflow re-asserts this as the backstop).
        assertLegalTransition(ctx.state.status.phase, "shipped");

        const hasLimitations = await ctx.artifacts.exists(KNOWN_LIMITATIONS);

        // --- Guard 1: blocked state / recorded blockers. -------------------
        const blockers = ctx.state.status.blockers ?? [];
        const isBlocked = ctx.state.status.phase === "blocked";
        if ((isBlocked || blockers.length > 0) && !hasLimitations) {
          logger.error(
            `ship: refusing — workflow is ${isBlocked ? "BLOCKED" : "carrying " + blockers.length + " blocker(s)"} and no ${KNOWN_LIMITATIONS} documents an exception.`,
          );
          for (const b of blockers) logger.error(`    - ${b}`);
          logger.info("  next:  resolve the blocker(s) (oswald validate) or document exceptions");
          process.exitCode = 1;
          return;
        }

        // --- Guard 2: validation report present + not failing. -------------
        if (!(await ctx.artifacts.exists(VALIDATION_REPORT))) {
          logger.error(
            `ship: refusing — no ${VALIDATION_REPORT} found. Run 'oswald validate ${ticket}' first.`,
          );
          process.exitCode = 1;
          return;
        }
        const valText = await ctx.artifacts.read(VALIDATION_REPORT);
        const validationFailed = /⛔\s*BLOCKED/i.test(valText) || /\*\*Done:\*\*\s*no/i.test(valText);
        if (validationFailed && !hasLimitations) {
          logger.error(
            `ship: refusing — ${VALIDATION_REPORT} reports blocking failures and no ${KNOWN_LIMITATIONS} documents an exception.`,
          );
          process.exitCode = 1;
          return;
        }

        // --- Guard 3: PR summary packaged. ---------------------------------
        if (!(await ctx.artifacts.exists(PR_SUMMARY))) {
          logger.error(
            `ship: refusing — no ${PR_SUMMARY} found. Run 'oswald pr ${ticket}' first.`,
          );
          process.exitCode = 1;
          return;
        }

        // --- Guard 4: artifact drift (stale upstreams). ---------------------
        // "unknown (no baseline)" findings (pre-existing runs without recorded
        // hashes) NEVER block; only real stale/modified drift refuses.
        const drift = await checkDrift({
          state: ctx.state,
          artifacts: ctx.artifacts,
        });
        if (drift.drifted.length > 0 && !opts.allowDrift) {
          logger.error(
            `ship: refusing — ${drift.drifted.length} artifact drift finding(s): upstream artifacts changed after downstream phases last ran.`,
          );
          for (const f of drift.drifted) {
            logger.error(`    - ${f.phase} ← ${f.upstream}: ${f.detail}`);
          }
          logger.info(
            "  next:  re-run the flagged phase(s) (stale), keep hand-edits with 'oswald doctor --accept-drift' (modified), or pass --allow-drift to override",
          );
          process.exitCode = 1;
          return;
        }

        const warnings: string[] = [];
        if (drift.drifted.length > 0 && opts.allowDrift) {
          warnings.push(
            `${drift.drifted.length} artifact drift finding(s) overridden via --allow-drift — downstream artifacts may be stale.`,
          );
        }
        if (validationFailed && hasLimitations) {
          warnings.push(
            `Validation reported failures but ${KNOWN_LIMITATIONS} documents exceptions — shipping with documented limitations.`,
          );
        }
        if (blockers.length > 0 && hasLimitations) {
          warnings.push(
            `${blockers.length} blocker(s) recorded but documented in ${KNOWN_LIMITATIONS} — shipping with documented exceptions.`,
          );
        }

        // --- Archive noisy intermediates. ----------------------------------
        const archived: string[] = [];
        for (const name of ARCHIVABLE) {
          if (await ctx.artifacts.exists(name)) {
            const dest = await ctx.artifacts.archive(name);
            if (dest) archived.push(name);
          }
        }

        // --- Write the ship record. ----------------------------------------
        const stamp = ctx.clock.nowIso();
        const recordMd = ctx.artifacts.renderMarkdown({
          title: `Ship Record: ${ticket}`,
          summary: `Finalized at ${stamp}. Validation verified, PR summary present, intermediates archived.`,
          sections: [
            {
              heading: "Gate Results",
              body: [
                `- **Validation report:** present${validationFailed ? " (failures — documented exceptions accepted)" : " (no blocking failures)"}`,
                `- **PR summary:** present (\`${PR_SUMMARY}\`)`,
                `- **Drift check:** ${
                  drift.drifted.length > 0
                    ? `${drift.drifted.length} finding(s) — overridden via \`--allow-drift\``
                    : drift.unknown.length > 0
                      ? `no drift; ${drift.unknown.length} artifact(s) unknown (no baseline)`
                      : "no drift"
                }`,
                `- **Documented exceptions:** ${hasLimitations ? `yes (\`${KNOWN_LIMITATIONS}\`)` : "none"}`,
                `- **Blockers at ship:** ${blockers.length}`,
              ].join("\n"),
            },
            {
              heading: "Archived Intermediates",
              body:
                archived.length > 0
                  ? archived.map((a) => `- \`${a}\` → \`archive/\``).join("\n")
                  : "_None to archive._",
            },
            ...(warnings.length
              ? [{ heading: "Notes", body: warnings.map((w) => `- ${w}`).join("\n") }]
              : []),
          ],
        });
        const { content } = ctx.policy.sensitive.redactArtifactContent(recordMd);
        const recordPath = await ctx.artifacts.write(SHIP_RECORD, content);

        // --- Set state shipped. --------------------------------------------
        await advanceWorkflow(ctx, {
          phase: "shipped",
          lastCommand: "ship",
          artifacts: { ship_record: SHIP_RECORD },
          blockers: [],
        });

        // --- Standard output block. ----------------------------------------
        logger.success(`ship: ${ticket} finalized and marked shipped.`);
        for (const w of warnings) logger.warn(`  warning: ${w}`);
        logger.info(`  artifacts:`);
        logger.info(`    - ${path.relative(cwd, recordPath) || recordPath}`);
        if (archived.length > 0) {
          logger.info(`  archived (${archived.length}) intermediate artifact(s) to archive/`);
        }
        logger.success("  pipeline complete — phase 'shipped'");
        process.exitCode = 0;
      } catch (err) {
        logger.error(
          `ship failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
      }
    });
}
