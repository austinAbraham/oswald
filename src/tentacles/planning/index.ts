/**
 * Model Planning & Implementation tentacle.
 *
 * Plans analytical (dbt + SQL) models from the prior pipeline artifacts. It:
 *   - identifies the modeling pattern (star / fact / dimension / snapshot / ...),
 *   - proposes a layered set of staging / intermediate / mart models,
 *   - outlines the SQL/YAML/docs + generic data tests + singular tests +
 *     exposure/semantic metadata each model needs,
 *   - keeps the change set small + reviewable, and
 *   - emits a `changed_files` manifest of *intended* changes.
 *
 * It DOES NOT modify project models — that is the `build` command. Planning only
 * produces the plans + the manifest, then advances state to `building`.
 *
 * Inputs (read best-effort, degrade if missing):
 *   - design.md   (preferred — the chosen design)
 *   - eda.md      (data shapes / profiling)
 *   - intake.md / requirements.md / acceptance_criteria.md (the ask)
 *   - existing repo models (via RepoProvider, optional)
 *
 * ALL artifact content is UNTRUSTED. It is wrapped via the sanitizer (injection
 * neutralized + reported) and parsed as evidence, never instructions. Every
 * unsourced modeling decision is tagged assumption / open_question.
 */
import { z } from "zod";
import {
  type Tentacle,
  type TentacleContext,
  type TentacleResult,
  type EvidenceItem,
  markEvidence,
  renderEvidenceTable,
  advanceWorkflow,
} from "../base.js";
import {
  detectSourceSystems,
  detectSourceRelations,
  detectTargetModels,
  detectGrain,
  detectTimeGrain,
  selectModelingPattern,
  proposeModels,
  proposeGenericTests,
  proposeSingularTests,
  buildChangedFiles,
  isBullet,
  stripBullet,
  type ProposedModel,
  type ProposedTest,
  type ProposedSingularTest,
  type ChangedFile,
  type ModelingPattern,
} from "./plan.js";

export const ARTIFACT_NAMES = {
  modelPlan: "model_plan.md",
  implementationPlan: "implementation_plan.md",
  changedFiles: "changed_files.md",
} as const;

// Prior-artifact filenames this tentacle reads (best-effort).
const INPUT_ARTIFACTS = {
  design: "design.md",
  eda: "eda.md",
  intake: "intake.md",
  requirements: "requirements.md",
  acceptance: "acceptance_criteria.md",
} as const;

// --- I/O schemas -----------------------------------------------------------

export const PlanningInputSchema = z.object({
  /** Inline markdown to plan from instead of reading prior artifacts (tests). */
  rawText: z.string().optional(),
});
export type PlanningInput = z.infer<typeof PlanningInputSchema>;

const ProposedModelSchema = z.object({
  name: z.string(),
  layer: z.enum(["staging", "intermediate", "marts"]),
  materialization: z.enum(["view", "table", "incremental", "ephemeral"]),
  purpose: z.string(),
  upstream: z.array(z.string()),
  grain: z.string().optional(),
  sourced: z.boolean(),
});

export const PlanningOutputSchema = z.object({
  pattern: z.object({ id: z.string(), title: z.string(), rationale: z.string() }),
  models: z.array(ProposedModelSchema),
  genericTestCount: z.number().int().min(0),
  singularTestCount: z.number().int().min(0),
  changedFileCount: z.number().int().min(0),
  sourceSystems: z.array(z.string()),
  targetModels: z.array(z.string()),
  grain: z.string().nullable(),
  openQuestions: z.array(z.string()),
  injectionDetected: z.boolean(),
  inputsUsed: z.array(z.string()),
});
export type PlanningOutput = z.infer<typeof PlanningOutputSchema>;

// --- helpers ---------------------------------------------------------------

/** Read an artifact if it exists; return null otherwise. */
async function readIfExists(
  ctx: TentacleContext,
  name: string,
): Promise<string | null> {
  if (await ctx.artifacts.exists(name)) {
    return ctx.artifacts.read(name);
  }
  return null;
}

/** Pull acceptance-criteria bullet lines out of the acceptance artifact. */
function extractAcceptanceCriteria(md: string | null): string[] {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = /acceptance/i.test(heading[1]!);
      continue;
    }
    if (!inSection || !line) continue;
    if (isBullet(line)) {
      const item = stripBullet(line);
      // drop the "_None found ..._" placeholder
      if (item && !/^_.*_$/.test(item)) out.push(item);
    } else if (/^\d+\.\s+/.test(line)) {
      out.push(line.replace(/^\d+\.\s+/, "").trim());
    }
  }
  return out;
}

function bulletList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

function renderModelsTable(models: ProposedModel[]): string {
  if (models.length === 0) return "_No models proposed._";
  const rows = models.map(
    (m) =>
      `| \`${m.name}\` | ${m.layer} | ${m.materialization} | ${
        m.grain ?? "—"
      } | ${m.sourced ? "sourced" : "inferred"} | ${m.purpose} |`,
  );
  return [
    "| Model | Layer | Materialization | Grain | Provenance | Purpose |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderGenericTests(tests: ProposedTest[]): string {
  if (tests.length === 0) return "_No generic tests proposed._";
  return tests
    .map((t) => `- \`${t.model}.${t.column}\` → **${t.test}** — ${t.rationale}`)
    .join("\n");
}

function renderSingularTests(tests: ProposedSingularTest[]): string {
  if (tests.length === 0)
    return "_No singular tests proposed (no testable acceptance criteria found)._";
  return tests
    .map(
      (t) =>
        `- \`tests/${t.name}.sql\` — asserts: ${t.assertion} _(traces to ${t.source})_`,
    )
    .join("\n");
}

function renderChangedFiles(files: ChangedFile[]): string {
  if (files.length === 0) return "_No file changes proposed._";
  const rows = files.map(
    (f) => `| \`${f.path}\` | ${f.change} | ${f.note} |`,
  );
  return ["| Path | Change | Note |", "| --- | --- | --- |", ...rows].join(
    "\n",
  );
}

function renderImplementationSteps(
  models: ProposedModel[],
  pattern: ModelingPattern,
  singularTests: ProposedSingularTest[],
): string {
  const steps: string[] = [];
  let n = 1;
  steps.push(
    `${n++}. Confirm the modeling pattern (**${pattern.title}**) and the grain with the requester.`,
  );
  const staging = models.filter((m) => m.layer === "staging");
  if (staging.length) {
    steps.push(
      `${n++}. Build staging models (${staging
        .map((m) => `\`${m.name}\``)
        .join(", ")}): 1:1 with sources, rename + cast only, no business logic.`,
    );
  }
  const inter = models.filter((m) => m.layer === "intermediate");
  if (inter.length) {
    steps.push(
      `${n++}. Build intermediate models (${inter
        .map((m) => `\`${m.name}\``)
        .join(", ")}): joins + reshaping, materialized ephemeral.`,
    );
  }
  const marts = models.filter((m) => m.layer === "marts");
  if (marts.length) {
    steps.push(
      `${n++}. Build mart models (${marts
        .map((m) => `\`${m.name}\``)
        .join(", ")}): apply business logic + enforce grain.`,
    );
  }
  steps.push(
    `${n++}. Add generic tests (unique/not_null on keys) in each layer's \`_schema.yml\` with model + column docs.`,
  );
  if (singularTests.length) {
    steps.push(
      `${n++}. Add ${singularTests.length} singular test(s) under \`tests/\` tracing each testable acceptance criterion.`,
    );
  }
  steps.push(
    `${n++}. Declare an exposure / semantic metadata entry for the final mart so downstream consumers are tracked.`,
  );
  steps.push(
    `${n++}. \`dbt build --select <new models>\` against the sandbox target; reconcile against acceptance criteria.`,
  );
  return steps.join("\n");
}

// --- the tentacle ----------------------------------------------------------

export const planningTentacle: Tentacle<
  typeof PlanningInputSchema,
  typeof PlanningOutputSchema
> = {
  id: "planning",
  title: "Model Planning & Implementation",
  description:
    "Plan analytical dbt + SQL models from the design/EDA/intake artifacts: identify the modeling pattern, propose layered staging/intermediate/mart models, outline SQL/YAML/docs/tests/exposures, keep changes small, and emit a changed_files manifest of intended changes — without touching project models.",

  inputSchema: PlanningInputSchema,
  outputSchema: PlanningOutputSchema,

  requiredTools: [],
  optionalTools: ["repo.changedFiles", "repo.currentBranch"],

  checklist: [
    "Modeling pattern identified with a stated rationale",
    "Staging models proposed (one per source) with view materialization",
    "Intermediate models proposed only when joins are needed",
    "Mart models proposed per target with grain enforced",
    "Generic tests (unique/not_null) proposed on key columns",
    "Singular tests trace back to acceptance criteria",
    "Exposure / semantic metadata outlined for the final mart",
    "changed_files manifest lists every intended create/modify",
    "Change set kept small and reviewable",
    "All untrusted artifact content wrapped and injection-scanned",
    "Every unsourced modeling decision tagged assumption/open_question",
  ],

  async run(ctx: TentacleContext): Promise<TentacleResult<PlanningOutput>> {
    const input = PlanningInputSchema.parse({
      rawText: ctx.options.rawText as string | undefined,
    });

    const warnings: string[] = [];
    const inputsUsed: string[] = [];

    // --- Gather prior artifacts (best-effort, degrade gracefully). ---------
    let designMd: string | null = null;
    let edaMd: string | null = null;
    let intakeMd: string | null = null;
    let requirementsMd: string | null = null;
    let acceptanceMd: string | null = null;

    if (input.rawText !== undefined) {
      // Test / inline mode: treat the raw text as the entire planning input.
      intakeMd = input.rawText;
      inputsUsed.push("inline");
    } else {
      designMd = await readIfExists(ctx, INPUT_ARTIFACTS.design);
      edaMd = await readIfExists(ctx, INPUT_ARTIFACTS.eda);
      intakeMd = await readIfExists(ctx, INPUT_ARTIFACTS.intake);
      requirementsMd = await readIfExists(ctx, INPUT_ARTIFACTS.requirements);
      acceptanceMd = await readIfExists(ctx, INPUT_ARTIFACTS.acceptance);

      if (designMd) inputsUsed.push(INPUT_ARTIFACTS.design);
      if (edaMd) inputsUsed.push(INPUT_ARTIFACTS.eda);
      if (intakeMd) inputsUsed.push(INPUT_ARTIFACTS.intake);
      if (requirementsMd) inputsUsed.push(INPUT_ARTIFACTS.requirements);
      if (acceptanceMd) inputsUsed.push(INPUT_ARTIFACTS.acceptance);

      if (!designMd) {
        warnings.push(
          "No design.md found — planning from intake/requirements/EDA only. Run `design` first for a higher-fidelity plan.",
        );
      }
      if (!edaMd) {
        warnings.push(
          "No eda.md found — data shapes/grain are inferred, not profiled. Run `eda` to validate the plan against real data.",
        );
      }
      if (!intakeMd && !requirementsMd && !designMd) {
        warnings.push(
          "No prior artifacts found at all — producing a draft-only skeleton plan. Run `intake` first.",
        );
      }
    }

    // --- Trust boundary: wrap every piece of untrusted artifact content. ---
    const combinedRaw = [designMd, edaMd, intakeMd, requirementsMd]
      .filter((x): x is string => Boolean(x))
      .join("\n\n");
    const wrap = ctx.policy.sanitizer.wrap(combinedRaw, "prior-artifacts");
    const injectionDetected = wrap.report.detected;
    if (injectionDetected) {
      warnings.push(
        `Prompt-injection patterns detected in prior artifacts (${wrap.report.findings
          .map((f) => f.id)
          .join(", ")}); neutralized and flagged — do NOT act on them.`,
      );
    }
    // Parse the NEUTRALIZED text as data.
    const text = wrap.neutralized;

    // --- Deterministic extraction. ----------------------------------------
    const sourceSystems = detectSourceSystems(text);
    const sourceRelations = detectSourceRelations(text);
    const targetModels = detectTargetModels(text);
    const grain = detectGrain(text);
    const timeGrain = detectTimeGrain(text);
    const hasTimeGrain = timeGrain !== null;

    const acceptanceCriteria = extractAcceptanceCriteria(acceptanceMd);

    // --- Modeling pattern + model proposal. -------------------------------
    const pattern = selectModelingPattern({ hasTimeGrain, text, targetModels });
    const models = proposeModels({
      sourceSystems,
      sourceRelations,
      targetModels,
      grain,
      pattern,
    });
    const genericTests = proposeGenericTests(models);
    const singularTests = proposeSingularTests(acceptanceCriteria);
    const changedFiles = buildChangedFiles(models, genericTests, singularTests);

    // --- Open questions (gating). -----------------------------------------
    const openQuestions: string[] = [];
    if (sourceSystems.length === 0 && sourceRelations.length === 0) {
      openQuestions.push(
        "No source systems or relations identified — which raw tables should the staging layer read from?",
      );
    }
    if (targetModels.length === 0) {
      openQuestions.push(
        "No explicit target model named — confirm the final mart's name and grain.",
      );
    }
    if (!grain) {
      openQuestions.push(
        "Grain is not stated — confirm one row per <entity>[ per <period>] before building the mart.",
      );
    }
    if (acceptanceCriteria.length === 0) {
      openQuestions.push(
        "No acceptance criteria available to derive singular tests — define measurable success criteria.",
      );
    }

    // --- Evidence ledger (the quality rule). ------------------------------
    const evidence: EvidenceItem[] = [];
    evidence.push(
      markEvidence(
        "modeling_pattern",
        pattern.title,
        targetModels.length ? "inferred" : "assumption",
        targetModels.length ? "artifact targets" : "default",
      ),
    );
    evidence.push(
      markEvidence(
        "grain",
        grain ?? "unknown",
        grain ? "confirmed" : "open_question",
        grain ? "artifact text" : "—",
      ),
    );
    for (const s of sourceSystems) {
      evidence.push(
        markEvidence("source_system", s, "inferred", "artifact text"),
      );
    }
    if (sourceSystems.length === 0 && sourceRelations.length === 0) {
      evidence.push(
        markEvidence("source_system", "unknown", "open_question", "—"),
      );
    }
    for (const m of models) {
      evidence.push(
        markEvidence(
          `model:${m.name}`,
          `${m.layer} / ${m.materialization}`,
          m.sourced ? "inferred" : "assumption",
          m.sourced ? "artifact targets" : "planning default",
        ),
      );
    }

    // --- Render artifacts. ------------------------------------------------
    const written: string[] = [];

    const modelPlanMd = ctx.artifacts.renderMarkdown({
      title: "Model Plan",
      summary: `Modeling pattern: **${pattern.title}** — ${pattern.rationale}`,
      sections: [
        {
          heading: "Inputs Used",
          body: bulletList(
            inputsUsed,
            "no prior artifacts found — draft-only plan",
          ),
        },
        {
          heading: "Modeling Pattern",
          body: [
            `- **Pattern:** ${pattern.title} (\`${pattern.id}\`)`,
            `- **Rationale:** ${pattern.rationale}`,
            `- **Grain:** ${grain ?? "_undetermined — OPEN QUESTION_"}`,
            `- **Time grain:** ${timeGrain ?? "_none detected_"}`,
          ].join("\n"),
        },
        {
          heading: "Sources",
          body: [
            `**Source systems:** ${
              sourceSystems.length ? sourceSystems.join(", ") : "_undetermined_"
            }`,
            "",
            `**Source relations:** ${
              sourceRelations.length
                ? sourceRelations.map((r) => `\`${r.source}.${r.relation}\``).join(", ")
                : "_undetermined_"
            }`,
          ].join("\n"),
        },
        { heading: "Proposed Models", body: renderModelsTable(models) },
        {
          heading: "Generic (schema) Tests",
          body: renderGenericTests(genericTests),
        },
        { heading: "Singular Tests", body: renderSingularTests(singularTests) },
        {
          heading: "Exposure / Semantic Metadata",
          body: [
            "Declare an exposure for the final mart so downstream consumers are tracked, e.g.:",
            "",
            "```yaml",
            "exposures:",
            "  - name: requested_data_product",
            "    type: analysis",
            "    depends_on:",
            ...models
              .filter((m) => m.layer === "marts")
              .map((m) => `      - ref('${m.name}')`),
            "    owner: { name: TBD, email: TBD }   # CONFIRM owner",
            "```",
          ].join("\n"),
        },
        {
          heading: "Open Questions",
          body: bulletList(openQuestions, "none — plan appears complete"),
        },
        { heading: "Evidence Ledger", body: renderEvidenceTable(evidence) },
      ],
    });

    const implementationPlanMd = ctx.artifacts.renderMarkdown({
      title: "Implementation Plan",
      summary:
        "Ordered, reviewable build steps. The `build` command executes these; planning only describes them. Keep each model a small, separately-reviewable change.",
      sections: [
        {
          heading: "Build Order",
          body: renderImplementationSteps(models, pattern, singularTests),
        },
        {
          heading: "Reviewability",
          body: [
            `- Total proposed files: **${changedFiles.length}** (${models.length} models, ${singularTests.length} singular tests).`,
            "- Each staging model is independently reviewable (rename/cast only).",
            "- Business logic is isolated to mart models for focused review.",
          ].join("\n"),
        },
        {
          heading: "Acceptance Criteria Traceability",
          body:
            acceptanceCriteria.length > 0
              ? acceptanceCriteria
                  .map((c, i) => `${i + 1}. ${c}`)
                  .join("\n")
              : "_No acceptance criteria found — define them before building so the plan can be validated._",
        },
      ],
    });

    const changedFilesMd = ctx.artifacts.renderMarkdown({
      title: "Changed Files (Intended)",
      summary:
        "Manifest of files the `build` command is INTENDED to create/modify. Planning does NOT write these — this is the proposed change set for human review.",
      sections: [
        { heading: "Intended Changes", body: renderChangedFiles(changedFiles) },
        {
          heading: "Scope Note",
          body: "Planning is read-only with respect to project models. No SQL/YAML files are written by this phase — `build` consumes this manifest.",
        },
      ],
    });

    // --- Redact PII then persist. -----------------------------------------
    for (const [name, md] of [
      [ARTIFACT_NAMES.modelPlan, modelPlanMd],
      [ARTIFACT_NAMES.implementationPlan, implementationPlanMd],
      [ARTIFACT_NAMES.changedFiles, changedFilesMd],
    ] as const) {
      const { content } = ctx.policy.sensitive.redactArtifactContent(md);
      const path = await ctx.artifacts.write(name, content);
      written.push(path);
    }

    // --- Advance workflow: planning complete → next phase is `building`. ---
    await advanceWorkflow(ctx, {
      phase: "building",
      lastCommand: "plan",
      artifacts: {
        model_plan: ARTIFACT_NAMES.modelPlan,
        implementation_plan: ARTIFACT_NAMES.implementationPlan,
        changed_files: ARTIFACT_NAMES.changedFiles,
      },
      requirements: {
        unresolved_questions: openQuestions,
      },
    });

    const output: PlanningOutput = PlanningOutputSchema.parse({
      pattern,
      models,
      genericTestCount: genericTests.length,
      singularTestCount: singularTests.length,
      changedFileCount: changedFiles.length,
      sourceSystems,
      targetModels,
      grain,
      openQuestions,
      injectionDetected,
      inputsUsed,
    });

    ctx.logger.info(
      `planning: pattern=${pattern.id}, ${models.length} model(s), ${changedFiles.length} file(s), ${openQuestions.length} open question(s)`,
    );

    return {
      artifactsWritten: written,
      summary: `Model plan: ${pattern.title} — ${models.length} model(s), ${genericTests.length} generic + ${singularTests.length} singular test(s), ${changedFiles.length} intended file change(s).`,
      output,
      ...(openQuestions.length ? { openQuestions } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};
