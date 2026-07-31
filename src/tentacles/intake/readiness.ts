/**
 * Ticket readiness scorecard — dimension-by-dimension readiness scoring.
 *
 * Promotes intake's single weighted completeness number into an explicit,
 * deterministic scorecard over the dimensions an analytical engineer needs
 * answered before modeling can safely start: grain declared, sources named,
 * acceptance criteria present, targets named, stakeholders identified, metric
 * definitions supplied, due date stated.
 *
 * Pure functions only — no I/O, no LLM, no network. The scorecard is
 * INFORMATIONAL by default; gating happens at the clarification step only when
 * `policies.readiness.min_score` is configured (see the clarification
 * tentacle). Every failed dimension carries the exact "missing information"
 * question a human must answer, so clarification can auto-draft a structured
 * request keyed to the gaps (e.g. "Grain not declared: one row per what?").
 */

/** The fixed, ordered set of readiness dimensions. */
export const READINESS_DIMENSION_IDS = [
  "grain",
  "sources",
  "acceptance_criteria",
  "targets",
  "stakeholders",
  "metric_definitions",
  "due_date",
] as const;

export type ReadinessDimensionId = (typeof READINESS_DIMENSION_IDS)[number];

export function isReadinessDimensionId(
  value: string,
): value is ReadinessDimensionId {
  return (READINESS_DIMENSION_IDS as readonly string[]).includes(value);
}

/** Static definition of a readiness dimension (label + weight). */
export interface ReadinessDimensionDefinition {
  id: ReadinessDimensionId;
  label: string;
  /** Contribution to the overall score when the dimension passes. */
  weight: number;
}

/**
 * The dimension weights mirror intake's completeness weighting: acceptance
 * criteria heaviest (nothing can be validated without them), then grain and
 * sources (nothing can be modeled without them), with targets, stakeholders,
 * metric definitions, and due date as lighter signals. Weights sum to 1.0.
 */
export const READINESS_DIMENSIONS: readonly ReadinessDimensionDefinition[] = [
  { id: "grain", label: "Grain declared", weight: 0.2 },
  { id: "sources", label: "Source systems named", weight: 0.2 },
  {
    id: "acceptance_criteria",
    label: "Acceptance criteria present",
    weight: 0.25,
  },
  { id: "targets", label: "Target deliverable named", weight: 0.1 },
  { id: "stakeholders", label: "Stakeholders identified", weight: 0.1 },
  {
    id: "metric_definitions",
    label: "Metric definitions supplied",
    weight: 0.1,
  },
  { id: "due_date", label: "Due date stated", weight: 0.05 },
] as const;

/** The deterministic signals the scorecard is computed from (intake extracts). */
export interface ReadinessSignals {
  /** The declared grain phrase (e.g. "one row per customer per day"), or null. */
  grain: string | null;
  sourceSystems: string[];
  acceptanceCriteria: string[];
  targets: string[];
  stakeholders: string[];
  /** Vague business terms used without an operational definition. */
  undefinedTerms: string[];
  dueDate: string | null;
}

/** One scored dimension: definition + pass/fail + evidence + gap question. */
export interface ReadinessDimensionResult extends ReadinessDimensionDefinition {
  passed: boolean;
  /** What was observed (deterministic, rendered into the scorecard). */
  observed: string;
  /** The missing-information question a human must answer when it fails. */
  question: string;
}

/** The full scorecard. */
export interface ReadinessScorecard {
  /** Weighted score in [0, 1], rounded to 2 decimal places. */
  score: number;
  dimensions: ReadinessDimensionResult[];
  /** Ids of the dimensions that failed, in canonical dimension order. */
  failedDimensions: ReadinessDimensionId[];
}

/** A missing-information question keyed to a failed dimension. */
export interface MissingInfoQuestion {
  dimension: ReadinessDimensionId;
  label: string;
  question: string;
}

/**
 * The canonical missing-information question per dimension. Kept centralized
 * so the intake scorecard and the clarification draft request stay identical.
 */
function questionFor(
  id: ReadinessDimensionId,
  context: { undefinedTerms?: string[] | undefined } = {},
): string {
  switch (id) {
    case "grain":
      return "Grain not declared: one row per what?";
    case "sources":
      return "No source systems named: which upstream systems/tables should this model read from?";
    case "acceptance_criteria":
      return "No acceptance criteria stated: what measurable checks (row counts, value matches, freshness) define done?";
    case "targets":
      return "No target deliverable named: which model/dashboard/report should this produce?";
    case "stakeholders":
      return "No stakeholders identified: who owns sign-off and can answer scoping questions?";
    case "metric_definitions": {
      const terms = context.undefinedTerms ?? [];
      return terms.length > 0
        ? `Business terms (${terms.join(", ")}) are used without definitions: what is the exact formula, grain, and filter for each?`
        : "Business terms are used without definitions: what is the exact formula, grain, and filter for each?";
    }
    case "due_date":
      return "No due date stated: when is this needed by?";
  }
}

function observedFor(
  id: ReadinessDimensionId,
  signals: ReadinessSignals,
): { passed: boolean; observed: string } {
  switch (id) {
    case "grain":
      return signals.grain
        ? { passed: true, observed: signals.grain }
        : { passed: false, observed: "not declared" };
    case "sources":
      return signals.sourceSystems.length > 0
        ? { passed: true, observed: signals.sourceSystems.join(", ") }
        : { passed: false, observed: "none named" };
    case "acceptance_criteria":
      return signals.acceptanceCriteria.length > 0
        ? {
            passed: true,
            observed: `${signals.acceptanceCriteria.length} criterion(a)`,
          }
        : { passed: false, observed: "none found" };
    case "targets":
      return signals.targets.length > 0
        ? { passed: true, observed: signals.targets.join(", ") }
        : { passed: false, observed: "none named" };
    case "stakeholders":
      return signals.stakeholders.length > 0
        ? { passed: true, observed: signals.stakeholders.join(", ") }
        : { passed: false, observed: "none identified" };
    case "metric_definitions":
      return signals.undefinedTerms.length > 0
        ? {
            passed: false,
            observed: `undefined term(s): ${signals.undefinedTerms.join(", ")}`,
          }
        : { passed: true, observed: "no undefined business terms" };
    case "due_date":
      return signals.dueDate
        ? { passed: true, observed: signals.dueDate }
        : { passed: false, observed: "none stated" };
  }
}

/**
 * Score the readiness signals into the dimension-by-dimension scorecard.
 * Deterministic: stable input → stable output; score rounded to 2 dp.
 */
export function scoreReadiness(signals: ReadinessSignals): ReadinessScorecard {
  const dimensions: ReadinessDimensionResult[] = READINESS_DIMENSIONS.map(
    (def) => {
      const { passed, observed } = observedFor(def.id, signals);
      return {
        ...def,
        passed,
        observed,
        question: questionFor(def.id, { undefinedTerms: signals.undefinedTerms }),
      };
    },
  );

  let total = 0;
  for (const d of dimensions) {
    if (d.passed) total += d.weight;
  }

  return {
    score: Math.round(total * 100) / 100,
    dimensions,
    failedDimensions: dimensions.filter((d) => !d.passed).map((d) => d.id),
  };
}

/**
 * Build the missing-information questions for a set of failed dimension ids
 * (e.g. as recorded in `state.requirements.readiness.failed_dimensions`).
 * Unknown ids are ignored (conservative), and output follows the canonical
 * dimension order regardless of input order.
 */
export function buildMissingInfoQuestions(
  failedDimensions: string[],
  context: { undefinedTerms?: string[] | undefined } = {},
): MissingInfoQuestion[] {
  const failed = new Set(failedDimensions);
  return READINESS_DIMENSIONS.filter((def) => failed.has(def.id)).map(
    (def) => ({
      dimension: def.id,
      label: def.label,
      question: questionFor(def.id, context),
    }),
  );
}

/** Render the scorecard as a Markdown table (deterministic ordering). */
export function renderReadinessTable(scorecard: ReadinessScorecard): string {
  const rows = scorecard.dimensions.map(
    (d) =>
      `| ${escapeCell(d.label)} | ${d.weight.toFixed(2)} | ${
        d.passed ? "✅ ready" : "❌ missing"
      } | ${escapeCell(d.observed)} |`,
  );
  return [
    "| Dimension | Weight | Status | Observed |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}
