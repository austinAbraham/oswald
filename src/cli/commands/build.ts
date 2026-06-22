/**
 * `build` — the only non-tentacle command that can write into the project tree.
 *
 * It is the bridge between the PLAN (which describes intended changes) and real
 * dbt files. Two modes:
 *
 *   - DEFAULT (dry-run): read `.oswald/implementation_plan.md` (+ `model_plan.md`
 *     and the planning `changed_files.md` manifest when present), and write a
 *     CHANGE PREVIEW artifact (`build_preview.md`) plus a machine-readable
 *     `changed_files` manifest. Nothing in the project tree is touched.
 *   - `--apply` (approval-gated): generate REAL, compilable dbt models — one
 *     `.sql` per planned model + a `_schema.yml` per layer carrying the planned
 *     generic tests + docs — under the configured `model_dir`. It NEVER
 *     overwrites an existing file and NEVER deletes anything (an existing target
 *     is written as `<name>.new` alongside instead). Apply requires explicit
 *     consent (`--apply --yes`) AND a policy that does not prohibit it; absent
 *     either, it degrades to a dry-run. After writing, when a dbt project is
 *     present (and not offline), `dbt parse` runs to confirm the SQL compiles.
 *
 * The plan text is UNTRUSTED (it embeds wrapped ticket/EDA content), so it is
 * neutralized via the sanitizer before any pattern reading, and generated file
 * bodies are PII-redacted before writing.
 */
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Command } from "commander";
import { buildContext, advanceWorkflow } from "../../tentacles/base.js";
import { policyFromConfig } from "../../core/approvals/index.js";
import { pathExists } from "../../utils/fs.js";
import { logger } from "../../core/logging/index.js";
import { resolveConfig } from "./_config.js";
import { detectDbtProject, runDbt } from "../../tools/dbt/index.js";
import {
  planModels,
  renderModelSql,
  renderSchemaYml,
  schemaFilesFor,
  type PlannedModel,
} from "./_build_models.js";

const OptionsSchema = z.object({
  dryRun: z.boolean().optional(),
  apply: z.boolean().optional(),
  yes: z.boolean().optional(),
  skipExternal: z.boolean().optional(),
  dbtCommand: z.string().optional(),
  cwd: z.string(),
});

const IMPLEMENTATION_PLAN = "implementation_plan.md";
const MODEL_PLAN = "model_plan.md";
const CHANGED_FILES_PLAN = "changed_files.md";
const BUILD_PREVIEW = "build_preview.md";
const BUILD_MANIFEST = "changed_files.json";

export function registerBuild(program: Command): void {
  program
    .command("build")
    .description("Turn the plan into a change preview (or, with --apply, real dbt models + schema.yml)")
    .argument("<ticket>", "ticket id this build targets")
    .option("--dry-run", "write a change preview + manifest only; touch no project files (default)")
    .option("--apply", "generate real dbt model SQL + per-layer schema.yml under the model dir (approval-gated)")
    .option("-y, --yes", "grant explicit approval required by --apply")
    .option("--skip-external", "do not run dbt parse after generating (stay fully local)")
    .option("--dbt-command <cmd>", "dbt invocation for the post-apply parse (else config/`dbt`)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald build TICKET-42                 # dry-run preview (default)\n  oswald build TICKET-42 --apply --yes   # generate real dbt models + run dbt parse\n\nNote: --apply never overwrites or deletes existing files (writes <path>.new alongside).",
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

        // --- Read the implementation plan (required input). -----------------
        if (!(await ctx.artifacts.exists(IMPLEMENTATION_PLAN))) {
          logger.error(
            `build: no ${IMPLEMENTATION_PLAN} found under ${ctx.artifacts.artifactDir}/. Run 'oswald plan ${ticket}' first.`,
          );
          process.exitCode = 1;
          return;
        }
        const rawPlan = await ctx.artifacts.read(IMPLEMENTATION_PLAN);
        const changedFilesMd = (await ctx.artifacts.exists(CHANGED_FILES_PLAN))
          ? await ctx.artifacts.read(CHANGED_FILES_PLAN)
          : null;
        const modelPlanRaw = (await ctx.artifacts.exists(MODEL_PLAN))
          ? await ctx.artifacts.read(MODEL_PLAN)
          : null;

        // Trust boundary: neutralize the (untrusted) plan text before reading.
        const wrap = ctx.policy.sanitizer.wrap(rawPlan, IMPLEMENTATION_PLAN);
        if (wrap.report.detected) {
          logger.warn(
            "build: prompt-injection patterns detected in the implementation plan; neutralized and treated as data only.",
          );
        }
        const planText = wrap.neutralized;
        const modelPlanText = modelPlanRaw
          ? ctx.policy.sanitizer.wrap(modelPlanRaw, MODEL_PLAN).neutralized
          : null;

        const modelDir = ctx.config.paths.model_dir || "models";
        const models: PlannedModel[] = planModels({
          modelPlanMd: modelPlanText,
          changedFilesMd,
          implementationMd: planText,
          modelDir,
        });
        const planSource = modelPlanText
          ? MODEL_PLAN
          : changedFilesMd
            ? CHANGED_FILES_PLAN
            : IMPLEMENTATION_PLAN;

        if (models.length === 0) {
          logger.warn(
            "build: no models could be derived from the plan — nothing to generate. Confirm the plan named concrete model(s).",
          );
        }

        // --- Decide apply vs dry-run (apply is approval-gated). -------------
        const wantsApply = Boolean(opts.apply);
        const policy = policyFromConfig(ctx.config.policies);
        // Treat generating model files as a "commit"-class write for the gate.
        const decision = ctx.approvals.requireApproval("commit", {
          yes: Boolean(opts.yes),
          policy,
          reason: "build --apply: write dbt model files",
        });
        const willApply = wantsApply && !opts.dryRun && decision.allowed;

        if (wantsApply && !willApply) {
          logger.warn(
            `build: --apply not honored (${
              opts.dryRun ? "--dry-run also set" : decision.reason
            }); falling back to a dry-run preview.`,
          );
        }

        // --- Build the manifest of intended/created files. -----------------
        const schemaFiles = schemaFilesFor(models, modelDir);
        const planned: Array<{ path: string; action: string; status: string }> = [];
        for (const m of models) {
          planned.push({ path: m.relPath, action: "create", status: "planned" });
        }
        for (const sf of schemaFiles) {
          planned.push({ path: sf.relPath, action: "create", status: "planned" });
        }

        const writtenArtifacts: string[] = [];
        const createdProjectFiles: string[] = [];
        const skippedProjectFiles: string[] = [];

        /**
         * Write a generated file NON-DESTRUCTIVELY: if the target already exists,
         * write `<path>.new` alongside it instead (never overwrite/delete). The
         * content is PII-redacted before hitting disk.
         */
        const writeNonDestructive = async (
          relPath: string,
          body: string,
        ): Promise<void> => {
          const abs = path.resolve(cwd, relPath);
          const { content } = ctx.policy.sensitive.redactArtifactContent(body);
          const entry = planned.find((p) => p.path === relPath);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          if (await pathExists(abs)) {
            // Never overwrite — emit a side-by-side `.new` for human merge.
            const newRel = `${relPath}.new`;
            const newAbs = path.resolve(cwd, newRel);
            if (await pathExists(newAbs)) {
              // Even the `.new` exists — refuse, record as skipped.
              skippedProjectFiles.push(relPath);
              if (entry) entry.status = "skipped (exists; .new also present)";
              return;
            }
            await fs.writeFile(newAbs, content, "utf8");
            createdProjectFiles.push(newRel);
            skippedProjectFiles.push(relPath);
            if (entry) entry.status = "exists → wrote .new";
            return;
          }
          await fs.writeFile(abs, content, "utf8");
          createdProjectFiles.push(relPath);
          if (entry) entry.status = "created";
        };

        // --- Apply: write REAL model SQL + per-layer schema.yml. ------------
        if (willApply) {
          for (const m of models) {
            await writeNonDestructive(m.relPath, renderModelSql(m));
          }
          for (const sf of schemaFiles) {
            await writeNonDestructive(sf.relPath, renderSchemaYml(sf.models));
          }
        }

        // --- Apply: confirm the generated SQL compiles via `dbt parse`. -----
        // Read-only; never blocked on target. Skipped offline or when no dbt
        // project is present. A parse failure is surfaced (warning) but does not
        // delete anything we wrote — the human reviews the `.new`/created files.
        let parseSummary: string | null = null;
        if (willApply && createdProjectFiles.length > 0) {
          const skipExternal = Boolean(opts.skipExternal);
          const dbtProjectDir = skipExternal
            ? null
            : await detectDbtProject(cwd);
          if (skipExternal) {
            parseSummary = "skipped (--skip-external)";
          } else if (!dbtProjectDir) {
            parseSummary = "skipped (no dbt project detected)";
          } else {
            const dbtInvocation = opts.dbtCommand ?? ctx.config.dbt?.command;
            const parseResult = await runDbt("parse", {
              projectDir: dbtProjectDir,
              ...(dbtInvocation ? { dbtCommand: dbtInvocation } : {}),
              ...(ctx.config.dbt?.timeout_ms
                ? { timeoutMs: ctx.config.dbt.timeout_ms }
                : {}),
            });
            if (parseResult.skipped) {
              parseSummary = parseResult.reason ?? "skipped";
            } else if (parseResult.ok) {
              parseSummary = "ok — generated SQL compiles";
            } else {
              parseSummary = `FAILED — ${parseResult.reason ?? "dbt parse error"}`;
              logger.warn(
                `build: dbt parse failed after generation. The files were written for human review; fix the TODO(human) markers and re-parse.\n${parseResult.stderr.slice(0, 500)}`,
              );
            }
          }
        }

        // --- Write the preview artifact + JSON manifest. -------------------
        const mode = willApply ? "apply" : "dry-run";
        const previewMd = ctx.artifacts.renderMarkdown({
          title: "Build Preview",
          summary: willApply
            ? `Real dbt models generated under \`${modelDir}/\` (${createdProjectFiles.length} created, ${skippedProjectFiles.length} pre-existing left intact). Existing files were never overwritten.`
            : `DRY-RUN: ${planned.length} file change(s) are PROPOSED from the plan. No project files were written. Re-run with \`--apply --yes\` to generate them.`,
          sections: [
            {
              heading: "Mode",
              body: [
                `- **Mode:** ${mode}`,
                `- **Model dir:** \`${modelDir}\``,
                `- **Models derived from plan:** ${models.length}`,
                `- **Source:** ${planSource}`,
                ...(parseSummary ? [`- **dbt parse:** ${parseSummary}`] : []),
              ].join("\n"),
            },
            {
              heading: "Changed Files",
              body:
                planned.length > 0
                  ? [
                      "| Path | Action | Status |",
                      "| --- | --- | --- |",
                      ...planned.map(
                        (p) => `| \`${p.path}\` | ${p.action} | ${p.status} |`,
                      ),
                    ].join("\n")
                  : "_No file changes derived from the plan._",
            },
            ...(willApply
              ? [
                  {
                    heading: "Created",
                    body:
                      createdProjectFiles.length > 0
                        ? createdProjectFiles.map((f) => `- \`${f}\``).join("\n")
                        : "_None (all targets already existed)._",
                  },
                  {
                    heading: "Left Intact (already exist)",
                    body:
                      skippedProjectFiles.length > 0
                        ? skippedProjectFiles.map((f) => `- \`${f}\``).join("\n")
                        : "_None._",
                  },
                ]
              : []),
            {
              heading: "Safety",
              body: [
                "- `build` is non-destructive: it only ever CREATES files; an existing target is written as `<path>.new` alongside, never overwritten or deleted.",
                "- Generated SQL is valid + compilable but carries `TODO(human)` markers where business logic must be supplied — Oswald never fabricates a metric formula.",
                "- Each generated model is documented and (where the plan named tests) carries its generic tests in `_schema.yml`.",
                "- The plan text was treated as untrusted (neutralized) before reading.",
                ...(parseSummary ? [`- After generation, \`dbt parse\` was run to confirm the SQL compiles: **${parseSummary}**.`] : []),
              ].join("\n"),
            },
          ],
        });

        const { content: redactedPreview } =
          ctx.policy.sensitive.redactArtifactContent(previewMd);
        writtenArtifacts.push(await ctx.artifacts.write(BUILD_PREVIEW, redactedPreview));

        const manifest = {
          version: 1,
          generated_by: "build",
          mode,
          model_dir: modelDir,
          plan_source: planSource,
          dbt_parse: parseSummary ?? "n/a",
          changed_files: planned,
          created: createdProjectFiles,
          skipped: skippedProjectFiles,
        };
        writtenArtifacts.push(
          await ctx.artifacts.write(BUILD_MANIFEST, ctx.artifacts.renderYaml(manifest)),
        );

        // --- Advance workflow → validating. --------------------------------
        await advanceWorkflow(ctx, {
          phase: "validating",
          lastCommand: "build",
          artifacts: {
            build: BUILD_PREVIEW,
            build_manifest: BUILD_MANIFEST,
          },
        });

        // --- Standard output block. ----------------------------------------
        logger.success(
          `build (${mode}): ${
            willApply
              ? `${createdProjectFiles.length} file(s) created, ${skippedProjectFiles.length} skipped`
              : `${planned.length} change(s) previewed`
          }.`,
        );
        logger.info(`  artifacts (${writtenArtifacts.length}):`);
        for (const p of writtenArtifacts) {
          logger.info(`    - ${path.relative(cwd, p) || p}`);
        }
        if (willApply && createdProjectFiles.length > 0) {
          logger.info(`  project files (${createdProjectFiles.length}):`);
          for (const f of createdProjectFiles) logger.info(`    - ${f}`);
        }
        logger.info("  next:  oswald validate " + ticket);
        process.exitCode = 0;
      } catch (err) {
        logger.error(
          `build failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
      }
    });
}
