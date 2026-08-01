/**
 * Upstream → downstream artifact consumption edges for the drift checker.
 *
 * Each entry says: phase `phase` consumes the `consumes` artifacts and writes
 * the `produces` artifacts. If an upstream artifact is re-generated (or edited
 * out-of-band) AFTER the phase last ran, that phase is stale — e.g. intake
 * re-run after clarification answers arrived, while design/plan were never
 * regenerated.
 *
 * The table is deliberately small and explicit, and it mirrors the artifacts
 * each tentacle/command ACTUALLY reads and writes: `consumes` matches the
 * exported `INPUT_ARTIFACTS` of each tentacle (or the input constants in
 * `src/cli/commands/build.ts`), and `produces` matches its `ARTIFACT_NAMES`.
 * A unit test asserts the two never diverge (`tests/unit/drift.test.ts`).
 */

export interface ConsumptionEdge {
  /** Downstream phase (its CLI verb) that consumes the upstream artifacts. */
  phase: string;
  /**
   * The `last_command` value this phase records via `advanceWorkflow`, when it
   * differs from the CLI verb (e.g. `pr` records `delivery`). Used to look up
   * `state.phase_runs`.
   */
  command?: string;
  /** Upstream artifact filenames this phase builds on. */
  consumes: readonly string[];
  /** Artifact filenames this phase writes (its freshness markers). */
  produces: readonly string[];
}

/**
 * Every pipeline phase's output artifacts (CLI verb → filenames), including
 * the source phases (`intake`, `eda`) that consume no pipeline artifacts.
 * Powers producer attribution for `modified` findings: a hand-edited artifact
 * is the PRODUCING phase's to regenerate, not its consumers'.
 */
export const PHASE_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  intake: ["intake.md", "requirements.md", "acceptance_criteria.md", "readiness.md"],
  clarify: [
    "open_questions.md",
    "scope_risks.md",
    "clarification_comment.md",
    "missing_information_request.md",
  ],
  context: [
    "context_pack.md",
    "existing_assets.md",
    "lineage_notes.md",
    "source_inventory.md",
  ],
  eda: [
    "eda_report.md",
    "grain_analysis.md",
    "join_analysis.md",
    "data_quality_findings.md",
  ],
  design: ["metric_spec.yml", "semantic_model_plan.md", "dimension_contracts.yml"],
  plan: ["model_plan.md", "implementation_plan.md", "changed_files.md"],
  build: ["build_preview.md", "changed_files.json"],
  validate: [
    "validation_report.md",
    "test_results.md",
    "reconciliation_report.md",
    "known_limitations.md",
  ],
  pr: [
    "pr_summary.md",
    "jira_update.md",
    "release_notes.md",
    "decision_log.md",
    "handoff_notes.md",
  ],
};

/** The CLI verb of the phase that produces `artifact`, or null if untracked. */
export function producerOf(artifact: string): string | null {
  for (const [phase, outputs] of Object.entries(PHASE_OUTPUTS)) {
    if (outputs.includes(artifact)) return phase;
  }
  return null;
}

export const CONSUMPTION_EDGES: readonly ConsumptionEdge[] = [
  {
    phase: "clarify",
    consumes: ["intake.md", "requirements.md", "acceptance_criteria.md"],
    produces: PHASE_OUTPUTS["clarify"]!,
  },
  {
    phase: "context",
    consumes: ["intake.md", "requirements.md"],
    produces: PHASE_OUTPUTS["context"]!,
  },
  {
    phase: "design",
    consumes: [
      "requirements.md",
      "acceptance_criteria.md",
      "intake.md",
      "context_pack.md",
      "eda_report.md",
    ],
    produces: PHASE_OUTPUTS["design"]!,
  },
  {
    phase: "plan",
    consumes: [
      "semantic_model_plan.md",
      "eda_report.md",
      "intake.md",
      "requirements.md",
      "acceptance_criteria.md",
    ],
    produces: PHASE_OUTPUTS["plan"]!,
  },
  {
    phase: "build",
    consumes: ["implementation_plan.md", "model_plan.md", "changed_files.md"],
    produces: PHASE_OUTPUTS["build"]!,
  },
  {
    phase: "validate",
    consumes: ["acceptance_criteria.md"],
    produces: PHASE_OUTPUTS["validate"]!,
  },
  {
    phase: "pr",
    command: "delivery",
    consumes: ["validation_report.md", "implementation_plan.md", "requirements.md"],
    produces: PHASE_OUTPUTS["pr"]!,
  },
];
