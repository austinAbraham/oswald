/**
 * Metric & Semantic Design tentacle.
 *
 * Converts business language (already captured by intake / clarification /
 * context / EDA) into PRECISE analytical definitions: metric formula, grain,
 * dimensions, filters/exclusions, null behavior, late-arriving + SCD behavior,
 * and a reconciliation approach. It also drafts dbt / semantic-layer metric
 * recommendations.
 *
 * Outputs (under `.oswald/`):
 *   - metric_spec.yml         — structured metric definitions (YAML)
 *   - semantic_model_plan.md  — dbt / semantic-layer plan + SCD / reconciliation
 *   - dimension_contracts.yml — dimension contracts (type, null behavior, SCD)
 * and advances `.oswald/state.yml` to the `planning` phase.
 *
 * ANALYTICAL-ENGINEERING QUALITY RULE (enforced): this tentacle NEVER invents
 * business logic. Every unsourced metric formula / grain / filter / null rule
 * is tagged `assumption` or `open_question`. Concrete values stated in the
 * sourced upstream artifacts are tagged `confirmed`; deterministically derived
 * ones are `inferred`.
 *
 * All upstream artifact text is treated as DATA. Any free text that originated
 * from a ticket/document is re-wrapped via the sanitizer before being embedded,
 * and rendered artifacts are PII-redacted before persisting.
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
  detectMetricCandidates,
  detectGrain,
  detectDimensions,
  detectFilters,
  isTimeBased,
  detectScdSignal,
  detectLateArrivingSignal,
  type MetricCandidate,
  type GrainCandidate,
  type DimensionCandidate,
  type FilterCandidate,
} from "./parse.js";

export const ARTIFACT_NAMES = {
  metricSpec: "metric_spec.yml",
  semanticPlan: "semantic_model_plan.md",
  dimensionContracts: "dimension_contracts.yml",
} as const;

/** Upstream artifacts this tentacle reads (all optional → degrade gracefully). */
const INPUT_ARTIFACTS = [
  "requirements.md",
  "acceptance_criteria.md",
  "intake.md",
  "clarifications.md",
  "context.md",
  "eda.md",
] as const;

// --- I/O schemas -----------------------------------------------------------

export const DesignInputSchema = z.object({
  /** Override the default set of upstream artifacts to read. */
  inputArtifacts: z.array(z.string()).optional(),
  /** Inline raw design source text (mainly for tests / draft-only). */
  rawText: z.string().optional(),
});
export type DesignInput = z.infer<typeof DesignInputSchema>;

const MetricSchema = z.object({
  name: z.string(),
  description: z.string(),
  aggregation: z.string(),
  formula: z.string(),
  formula_tag: z.enum(["confirmed", "inferred", "assumption", "open_question"]),
  grain: z.array(z.string()),
  filters: z.array(z.string()),
  null_behavior: z.string(),
  needs_definition: z.boolean(),
});

const DimensionSchema = z.object({
  name: z.string(),
  type: z.string(),
  null_behavior: z.string(),
  scd_type: z.string(),
  source_tag: z.enum(["confirmed", "inferred", "assumption", "open_question"]),
});

export const DesignOutputSchema = z.object({
  metrics: z.array(MetricSchema),
  dimensions: z.array(DimensionSchema),
  grain: z.object({
    description: z.string(),
    keys: z.array(z.string()),
    explicit: z.boolean(),
  }),
  filters: z.array(
    z.object({ description: z.string(), kind: z.enum(["include", "exclude"]) }),
  ),
  timeBased: z.boolean(),
  scdSignal: z.boolean(),
  lateArrivingSignal: z.boolean(),
  openQuestions: z.array(z.string()),
  injectionDetected: z.boolean(),
});
export type DesignOutput = z.infer<typeof DesignOutputSchema>;

// --- helpers ---------------------------------------------------------------

/**
 * Collect the design source text from prior artifacts (and/or inline rawText),
 * skipping any that are missing. Returns the concatenated text plus the list of
 * artifacts actually read (for evidence + warnings).
 */
async function gatherSourceText(
  ctx: TentacleContext,
  input: DesignInput,
): Promise<{ text: string; read: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const read: string[] = [];
  const parts: string[] = [];

  const names = input.inputArtifacts ?? [...INPUT_ARTIFACTS];
  for (const name of names) {
    if (await ctx.artifacts.exists(name)) {
      parts.push(await ctx.artifacts.read(name));
      read.push(name);
    }
  }

  if (input.rawText !== undefined) {
    parts.push(input.rawText);
    read.push("inline");
  }

  if (read.length === 0) {
    warnings.push(
      "No upstream artifacts (requirements/intake/eda/context) or inline text found; producing a draft-only design skeleton. Run intake/eda first.",
    );
  }

  return { text: parts.join("\n\n"), read, warnings };
}

function bulletList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

/**
 * Build the structured metric records. A metric with no detected aggregation OR
 * containing a vague business term gets an `open_question` formula — we NEVER
 * fabricate the calculation. A detected aggregation yields an `assumption`
 * formula skeleton that a human must confirm.
 */
function buildMetrics(
  candidates: MetricCandidate[],
  grain: GrainCandidate | null,
  filters: FilterCandidate[],
): {
  metrics: z.infer<typeof MetricSchema>[];
  openQuestions: string[];
  evidence: EvidenceItem[];
} {
  const metrics: z.infer<typeof MetricSchema>[] = [];
  const openQuestions: string[] = [];
  const evidence: EvidenceItem[] = [];
  const grainKeys = grain?.keys ?? [];
  const filterDescs = filters.map(
    (f) => `${f.kind === "exclude" ? "exclude" : "include"}: ${f.description}`,
  );

  for (const c of candidates) {
    const undefinedFormula = !c.aggregation || c.vague;
    const aggregation = c.aggregation ?? "unknown";

    let formula: string;
    let formulaTag: z.infer<typeof MetricSchema>["formula_tag"];
    if (undefinedFormula) {
      formula = "UNDEFINED — requires human definition";
      formulaTag = "open_question";
      if (c.vague) {
        openQuestions.push(
          `Metric "${c.name}" uses undefined term(s) ${c.vagueTerms
            .map((t) => `"${t}"`)
            .join(", ")} — define the exact formula, grain, and qualifying filter.`,
        );
      } else {
        openQuestions.push(
          `Metric "${c.name}" has no detectable aggregation — specify how it is calculated (sum/count/ratio/...).`,
        );
      }
    } else {
      // Deterministic skeleton ONLY — explicitly an assumption to confirm.
      formula = `${aggregation}(<measure_column>) -- ASSUMED skeleton; confirm measure column`;
      formulaTag = "assumption";
      openQuestions.push(
        `Confirm the measure column and exact formula for metric "${c.name}" (assumed ${aggregation}).`,
      );
    }

    evidence.push(
      markEvidence(
        `metric:${c.name}`,
        `${aggregation} — ${c.phrase}`,
        formulaTag,
        "upstream artifacts",
      ),
    );

    metrics.push({
      name: c.name,
      description: c.phrase,
      aggregation,
      formula,
      formula_tag: formulaTag,
      grain: grainKeys,
      filters: filterDescs,
      // Null behavior is never invented; default is a flagged assumption.
      null_behavior:
        "ASSUMPTION: nulls in the measure are excluded from the aggregate; confirm desired treatment (exclude vs coalesce-to-zero).",
      needs_definition: undefinedFormula,
    });
  }

  return { metrics, openQuestions, evidence };
}

/** Build dimension contract records with null + SCD behavior (assumption-tagged). */
function buildDimensionContracts(
  dims: DimensionCandidate[],
  scdSignal: boolean,
): { contracts: z.infer<typeof DimensionSchema>[]; evidence: EvidenceItem[] } {
  const contracts: z.infer<typeof DimensionSchema>[] = [];
  const evidence: EvidenceItem[] = [];

  for (const d of dims) {
    // SCD type is an assumption unless history was explicitly requested.
    const scdType =
      d.type === "time"
        ? "n/a (time spine)"
        : scdSignal
          ? "ASSUMPTION: SCD Type 2 (history requested) — confirm"
          : "ASSUMPTION: SCD Type 1 (overwrite) — confirm if history is needed";

    contracts.push({
      name: d.name,
      type: d.type,
      null_behavior:
        d.type === "identifier"
          ? "ASSUMPTION: non-null key; rows with null key are dropped — confirm"
          : "ASSUMPTION: nulls bucketed as 'unknown' — confirm",
      scd_type: scdType,
      source_tag: d.phrase === "grain key" ? "inferred" : "assumption",
    });

    evidence.push(
      markEvidence(
        `dimension:${d.name}`,
        `${d.type} (${d.phrase})`,
        d.phrase === "grain key" ? "inferred" : "assumption",
        "upstream artifacts",
      ),
    );
  }

  return { contracts, evidence };
}

// --- the tentacle ----------------------------------------------------------

export const designTentacle: Tentacle<
  typeof DesignInputSchema,
  typeof DesignOutputSchema
> = {
  id: "design",
  title: "Metric & Semantic Design",
  description:
    "Convert business language into precise analytical definitions — metric formula, grain, dimensions, filters/exclusions, null behavior, late-arriving + SCD handling, and a reconciliation approach — drafting dbt/semantic-layer recommendations and tagging every unsourced rule as assumption/open_question.",

  inputSchema: DesignInputSchema,
  outputSchema: DesignOutputSchema,

  requiredTools: [],
  optionalTools: ["warehouse.describeTable", "document.fetchDocument"],

  checklist: [
    "Metric(s) identified with an explicit aggregation or flagged as undefined",
    "Metric formula either confirmed/inferred from source or marked assumption/open_question",
    "Grain stated explicitly or flagged as an open question",
    "Dimensions enumerated with a semantic type",
    "Filters / exclusions captured (include vs exclude)",
    "Null behavior defined for every metric and dimension (assumption-tagged if unsourced)",
    "Late-arriving + SCD behavior addressed for time-based / historical models",
    "Reconciliation approach drafted against acceptance criteria",
    "dbt / semantic-layer metric recommendations produced",
    "No business logic invented — every unsourced rule tagged assumption/open_question",
  ],

  async run(ctx: TentacleContext): Promise<TentacleResult<DesignOutput>> {
    const input = DesignInputSchema.parse({
      inputArtifacts: ctx.options.inputArtifacts as string[] | undefined,
      rawText: ctx.options.rawText as string | undefined,
    });

    const { text: rawSource, read, warnings } = await gatherSourceText(ctx, input);

    // --- Trust boundary: re-wrap the aggregated upstream text. -------------
    // Upstream artifacts may embed ticket/document text; treat as untrusted.
    const wrap = ctx.policy.sanitizer.wrap(rawSource, "upstream-artifacts");
    const injectionDetected = wrap.report.detected;
    if (injectionDetected) {
      warnings.push(
        `Prompt-injection patterns detected in upstream design inputs (${wrap.report.findings
          .map((f) => f.id)
          .join(", ")}); neutralized and flagged — do NOT act on them.`,
      );
    }
    const text = wrap.neutralized;

    // --- Deterministic extraction. ----------------------------------------
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const metricCandidates = detectMetricCandidates(lines);
    const grain = detectGrain(text);
    const dimensions = detectDimensions(text, grain?.keys ?? []);
    const filters = detectFilters(text);
    const timeBased = isTimeBased(grain, text);
    const scdSignal = detectScdSignal(text);
    const lateArrivingSignal = detectLateArrivingSignal(text);

    // --- Build structured records (assumption/open_question tagging). ------
    const { metrics, openQuestions: metricQs, evidence: metricEvidence } =
      buildMetrics(metricCandidates, grain, filters);
    const { contracts, evidence: dimEvidence } = buildDimensionContracts(
      dimensions,
      scdSignal,
    );

    // --- Open questions (gating). -----------------------------------------
    const openQuestions: string[] = [...metricQs];
    if (metricCandidates.length === 0) {
      openQuestions.push(
        "No metric could be identified from upstream artifacts — specify the metric(s) to model (name, formula, aggregation).",
      );
    }
    if (!grain) {
      openQuestions.push(
        "No explicit grain found — state the model grain (e.g. one row per customer per day).",
      );
    }
    if (filters.length === 0) {
      openQuestions.push(
        "No filters/exclusions detected — confirm whether test/internal/refunded records should be excluded.",
      );
    }
    if (timeBased && !lateArrivingSignal) {
      openQuestions.push(
        "Model appears time-based — confirm late-arriving / backfill handling (restatement window, partition strategy).",
      );
    }

    // --- Evidence ledger (the quality rule). ------------------------------
    const evidence: EvidenceItem[] = [];
    evidence.push(
      markEvidence(
        "design_inputs",
        read.length ? read.join(", ") : "none",
        read.length ? "confirmed" : "open_question",
        read.length ? read.join(", ") : "—",
      ),
    );
    evidence.push(
      markEvidence(
        "grain",
        grain ? grain.description : "undetermined",
        grain ? (grain.explicit ? "confirmed" : "inferred") : "open_question",
        grain ? "upstream artifacts" : "—",
      ),
    );
    evidence.push(...metricEvidence);
    evidence.push(...dimEvidence);
    evidence.push(
      markEvidence(
        "scd_handling",
        scdSignal ? "history requested → SCD Type 2 (assumed)" : "no history signal → SCD Type 1 (assumed)",
        "assumption",
        scdSignal ? "upstream artifacts" : "default",
      ),
    );
    evidence.push(
      markEvidence(
        "late_arriving",
        lateArrivingSignal ? "late-arriving handling requested" : "not mentioned",
        lateArrivingSignal ? "confirmed" : "assumption",
        lateArrivingSignal ? "upstream artifacts" : "default",
      ),
    );

    // --- Render + persist artifacts. --------------------------------------
    const written: string[] = [];

    // metric_spec.yml (YAML)
    const metricSpecObj = {
      version: 1,
      generated_by: "design",
      grain: grain
        ? { description: grain.description, keys: grain.keys, tag: grain.explicit ? "confirmed" : "inferred" }
        : { description: "UNDETERMINED", keys: [], tag: "open_question" },
      metrics:
        metrics.length > 0
          ? metrics
          : [
              {
                name: "UNDETERMINED",
                description: "No metric identified from upstream artifacts.",
                aggregation: "unknown",
                formula: "UNDEFINED — requires human definition",
                formula_tag: "open_question",
                grain: grain?.keys ?? [],
                filters: [],
                null_behavior: "UNDEFINED",
                needs_definition: true,
              },
            ],
      filters: filters.map((f) => ({ description: f.description, kind: f.kind })),
      open_questions: openQuestions,
    };

    const dimContractsObj = {
      version: 1,
      generated_by: "design",
      dimensions:
        contracts.length > 0
          ? contracts
          : [
              {
                name: "UNDETERMINED",
                type: "unknown",
                null_behavior: "UNDEFINED",
                scd_type: "UNDEFINED",
                source_tag: "open_question",
              },
            ],
    };

    // semantic_model_plan.md (Markdown)
    const dbtRecs = buildDbtRecommendations(metrics, grain, timeBased);
    const planMd = ctx.artifacts.renderMarkdown({
      title: "Semantic Model Plan",
      summary:
        "Deterministic design draft. All unsourced rules are tagged assumption/open_question and MUST be confirmed by a human before modeling.",
      sections: [
        {
          heading: "Inputs",
          body: bulletList(
            read.length ? read : [],
            "no upstream artifacts found — draft only",
          ),
        },
        {
          heading: "Grain",
          body: grain
            ? `**${grain.description}** (keys: ${grain.keys.length ? grain.keys.join(", ") : "none extracted"}) — \`${grain.explicit ? "confirmed" : "inferred"}\``
            : "_UNDETERMINED — OPEN QUESTION: state the model grain._",
        },
        {
          heading: "Metrics",
          body:
            metrics.length > 0
              ? metrics
                  .map(
                    (m) =>
                      `### ${m.name}\n- **Description:** ${m.description}\n- **Aggregation:** ${m.aggregation}\n- **Formula:** \`${m.formula}\` (\`${m.formula_tag}\`)\n- **Null behavior:** ${m.null_behavior}`,
                  )
                  .join("\n\n")
              : "_No metric identified — OPEN QUESTION: define the metric(s)._",
        },
        {
          heading: "Dimensions",
          body:
            contracts.length > 0
              ? contracts
                  .map((d) => `- **${d.name}** (${d.type}) — null: ${d.null_behavior}; SCD: ${d.scd_type}`)
                  .join("\n")
              : "_No dimensions identified._",
        },
        {
          heading: "Filters & Exclusions",
          body: bulletList(
            filters.map((f) => `**${f.kind}**: ${f.description}`),
            "none detected — confirm whether test/internal/refunded records are excluded",
          ),
        },
        {
          heading: "Late-Arriving & SCD Behavior",
          body: [
            `- **Time-based:** ${timeBased ? "yes" : "no"}`,
            `- **Late-arriving signal:** ${lateArrivingSignal ? "yes — design a restatement/backfill window" : "none stated (ASSUMPTION: no late-arriving handling — confirm)"}`,
            `- **SCD signal:** ${scdSignal ? "history requested → SCD Type 2 (ASSUMPTION — confirm)" : "no history signal → SCD Type 1 overwrite (ASSUMPTION — confirm)"}`,
          ].join("\n"),
        },
        {
          heading: "Reconciliation Approach",
          body: buildReconciliationPlan(metrics, grain),
        },
        {
          heading: "dbt / Semantic-Layer Recommendations",
          body: dbtRecs,
        },
        {
          heading: "Open Questions",
          body: bulletList(openQuestions, "none — design appears complete"),
        },
        { heading: "Evidence Ledger", body: renderEvidenceTable(evidence) },
      ],
    });

    // Render YAML, then redact PII out of every artifact before writing.
    const metricSpecYaml = ctx.artifacts.renderYaml(metricSpecObj);
    const dimContractsYaml = ctx.artifacts.renderYaml(dimContractsObj);

    for (const [name, content] of [
      [ARTIFACT_NAMES.metricSpec, metricSpecYaml],
      [ARTIFACT_NAMES.semanticPlan, planMd],
      [ARTIFACT_NAMES.dimensionContracts, dimContractsYaml],
    ] as const) {
      const { content: redacted } = ctx.policy.sensitive.redactArtifactContent(content);
      const path = await ctx.artifacts.write(name, redacted);
      written.push(path);
    }

    // --- Advance workflow state. ------------------------------------------
    // Design complete; move into the next pending phase (`planning`) so
    // `oswald next` recommends `plan`.
    await advanceWorkflow(ctx, {
      phase: "planning",
      lastCommand: "design",
      artifacts: {
        metric_spec: ARTIFACT_NAMES.metricSpec,
        semantic_model_plan: ARTIFACT_NAMES.semanticPlan,
        dimension_contracts: ARTIFACT_NAMES.dimensionContracts,
      },
      requirements: {
        unresolved_questions: openQuestions,
      },
    });

    const output: DesignOutput = DesignOutputSchema.parse({
      metrics,
      dimensions: contracts,
      grain: grain
        ? { description: grain.description, keys: grain.keys, explicit: grain.explicit }
        : { description: "UNDETERMINED", keys: [], explicit: false },
      filters: filters.map((f) => ({ description: f.description, kind: f.kind })),
      timeBased,
      scdSignal,
      lateArrivingSignal,
      openQuestions,
      injectionDetected,
    });

    ctx.logger.info(
      `design: ${metrics.length} metric(s), ${contracts.length} dimension(s), ${openQuestions.length} open question(s)`,
    );

    return {
      artifactsWritten: written,
      summary: `Design draft: ${metrics.length} metric(s), ${contracts.length} dimension(s), grain ${grain ? `"${grain.description}"` : "UNDETERMINED"}, ${openQuestions.length} open question(s).`,
      output,
      ...(openQuestions.length ? { openQuestions } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};

/** Draft dbt / semantic-layer metric recommendations (deterministic). */
function buildDbtRecommendations(
  metrics: z.infer<typeof MetricSchema>[],
  grain: GrainCandidate | null,
  timeBased: boolean,
): string {
  if (metrics.length === 0) {
    return "_No metric to recommend until the metric(s) are defined (see Open Questions)._";
  }
  const lines: string[] = [];
  lines.push(
    "Recommend defining these as **dbt Semantic Layer metrics** on a curated mart model (do NOT bake the calculation into ad-hoc SQL):",
    "",
  );
  if (timeBased) {
    lines.push(
      "- Add a `time` dimension (date spine) and an `agg_time_dimension` on the semantic model.",
    );
  }
  if (grain && grain.keys.length) {
    lines.push(`- Primary entity / grain keys: ${grain.keys.join(", ")}.`);
  }
  for (const m of metrics) {
    const slType =
      m.aggregation === "ratio"
        ? "ratio metric (numerator / denominator)"
        : m.aggregation === "count_distinct"
          ? "simple metric over a `count_distinct` measure"
          : `simple metric over a \`${m.aggregation}\` measure`;
    lines.push(
      `- \`${m.name}\`: ${slType}. Measure formula is **${m.formula_tag}** — \`${m.formula}\`.`,
    );
  }
  lines.push(
    "",
    "All measure columns marked `assumption`/`open_question` must be confirmed before the metric is published.",
  );
  return lines.join("\n");
}

/** Draft a reconciliation approach tying metrics back to acceptance criteria. */
function buildReconciliationPlan(
  metrics: z.infer<typeof MetricSchema>[],
  grain: GrainCandidate | null,
): string {
  const lines: string[] = [
    "Each metric must be reconciled deterministically at the Validate phase:",
    "",
  ];
  if (metrics.length === 0) {
    lines.push("- _Define the metric(s) first; reconciliation depends on the formula._");
    return lines.join("\n");
  }
  for (const m of metrics) {
    lines.push(
      `- **${m.name}**: compare the aggregated value (and row count at grain ${
        grain ? `\`${grain.keys.join(" × ") || grain.description}\`` : "TBD"
      }) against the legacy/source-of-truth figure within an agreed tolerance.`,
    );
  }
  lines.push(
    "",
    "Tolerance, comparison source, and time window are OPEN QUESTIONS unless stated in the acceptance criteria.",
  );
  return lines.join("\n");
}
