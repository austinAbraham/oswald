/**
 * Deterministic clarification / scoping heuristics.
 *
 * Pure functions (no LLM, no I/O) that take the structured intake evidence
 * (already extracted + already trust-wrapped upstream) and turn it into:
 *   - a triaged list of questions (blocking vs non-blocking),
 *   - scope risks with severities,
 *   - proposed assumptions (so engineering can proceed under stated defaults),
 *   - a split recommendation when the ask is too large.
 *
 * Everything here is heuristic and conservative: it FLAGS ambiguity for a human,
 * it never resolves a business rule on its own. Every proposed assumption is
 * explicitly an assumption the human must confirm or reject.
 */

// ---------------------------------------------------------------------------
// Questions: triage into blocking vs non-blocking and group by stakeholder.
// ---------------------------------------------------------------------------

export type QuestionPriority = "blocking" | "non_blocking";

export interface ClarificationQuestion {
  /** The question text (already free of injected directives). */
  text: string;
  priority: QuestionPriority;
  /** Stakeholder/team this should be routed to ("unassigned" if unknown). */
  stakeholder: string;
  /** Short rationale for why this is blocking / non-blocking. */
  rationale: string;
}

/**
 * A question is BLOCKING if it concerns something an analytical engineer cannot
 * safely guess: missing acceptance criteria, undefined grain, undefined metric
 * formula, unknown source systems. Everything else (naming, nice-to-haves,
 * formatting) is non-blocking and can proceed under an assumption.
 */
const BLOCKING_SIGNALS: RegExp[] = [
  /\bacceptance criteria\b/i,
  /\bgrain\b/i,
  /\bsource systems?\b/i,
  /\bupstream\b/i,
  /\bmetric\b/i,
  /\bformula\b/i,
  /\bdefinition\b/i,
  /\brequirements?\b/i,
  /\bscope\b/i,
  /\bfilter\b/i,
];

/** Vague terms that, when undefined, must be defined before modeling. */
const VAGUE_METRIC_TERMS = [
  "active",
  "engaged",
  "revenue",
  "recent",
  "top",
  "best",
  "good",
  "successful",
  "churn",
  "retention",
  "conversion",
  "key",
  "core",
  "relevant",
];

export function classifyQuestionPriority(text: string): QuestionPriority {
  return BLOCKING_SIGNALS.some((re) => re.test(text))
    ? "blocking"
    : "non_blocking";
}

/**
 * Route a question to a stakeholder. If the question text references a known
 * stakeholder, use it; otherwise infer a coarse owner from the topic, falling
 * back to "unassigned".
 */
export function routeStakeholder(text: string, stakeholders: string[]): string {
  const lower = text.toLowerCase();
  for (const s of stakeholders) {
    const bare = s.replace(/^@/, "").toLowerCase();
    if (bare && lower.includes(bare)) return s;
  }
  // Topic-based coarse routing (deterministic ordering).
  if (/\b(acceptance|success|sign[- ]?off|kpi|metric|revenue|churn)\b/i.test(text)) {
    return stakeholders[0] ?? "business_owner";
  }
  if (/\b(source|upstream|table|schema|pipeline|grain|filter)\b/i.test(text)) {
    return "data_owner";
  }
  return stakeholders[0] ?? "unassigned";
}

export interface BuildQuestionsInput {
  /** Open questions surfaced by intake (already deterministic). */
  openQuestions: string[];
  /** Vague terms detected in the source text (for extra coverage). */
  ambiguousTerms: string[];
  stakeholders: string[];
  hasAcceptanceCriteria: boolean;
  sourceSystems: string[];
  requirements: string[];
}

/**
 * Build the triaged, deduplicated, stakeholder-routed question set. Pure and
 * deterministic: stable input → stable, sorted output (blocking first).
 */
export function buildQuestions(
  input: BuildQuestionsInput,
): ClarificationQuestion[] {
  const seen = new Set<string>();
  const out: ClarificationQuestion[] = [];

  const push = (text: string, rationale: string): void => {
    const key = text.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const priority = classifyQuestionPriority(text);
    out.push({
      text: text.trim(),
      priority,
      stakeholder: routeStakeholder(text, input.stakeholders),
      rationale,
    });
  };

  // 1. Carry forward intake's open questions verbatim (they are already specific).
  for (const q of input.openQuestions) {
    push(q, "Raised during intake; unresolved.");
  }

  // 2. Structural gaps that always block if absent.
  if (!input.hasAcceptanceCriteria) {
    push(
      "What are the measurable acceptance criteria (row counts, value matches, freshness) that define done?",
      "Without acceptance criteria the result cannot be validated.",
    );
  }
  if (input.sourceSystems.length === 0) {
    push(
      "Which upstream source systems / tables should this model read from?",
      "Source systems are required before any modeling can begin.",
    );
  }
  if (input.requirements.length === 0) {
    push(
      "What exactly is the requested data product and its grain (one row per ___)?",
      "The requested data product and grain are undefined.",
    );
  }

  // 3. Each undefined vague term → a definition question.
  for (const term of input.ambiguousTerms) {
    push(
      `How is "${term}" defined (exact formula, grain, and filters)?`,
      `"${term}" is used but not operationally defined.`,
    );
  }

  // Stable sort: blocking first, then by stakeholder, then text.
  return out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "blocking" ? -1 : 1;
    if (a.stakeholder !== b.stakeholder)
      return a.stakeholder.localeCompare(b.stakeholder);
    return a.text.localeCompare(b.text);
  });
}

/** Extract the bare vague terms present in a body of text (deterministic). */
export function detectAmbiguousTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const term of VAGUE_METRIC_TERMS) {
    if (new RegExp(`\\b${term}\\b`, "i").test(lower)) hits.push(term);
  }
  return [...new Set(hits)];
}

/** Group questions by stakeholder (deterministic key ordering). */
export function groupByStakeholder(
  questions: ClarificationQuestion[],
): Array<{ stakeholder: string; questions: ClarificationQuestion[] }> {
  const map = new Map<string, ClarificationQuestion[]>();
  for (const q of questions) {
    const list = map.get(q.stakeholder) ?? [];
    list.push(q);
    map.set(q.stakeholder, list);
  }
  return [...map.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((stakeholder) => ({ stakeholder, questions: map.get(stakeholder)! }));
}

// ---------------------------------------------------------------------------
// Scope risks.
// ---------------------------------------------------------------------------

export type RiskSeverity = "high" | "medium" | "low";

export interface ScopeRisk {
  id: string;
  description: string;
  severity: RiskSeverity;
  /** What to do about it (deterministic mitigation hint). */
  mitigation: string;
}

export interface ScopeRiskInput {
  requirements: string[];
  acceptanceCriteria: string[];
  sourceSystems: string[];
  targets: string[];
  ambiguousTerms: string[];
  dependencies: string[];
  injectionDetected: boolean;
}

/** Heuristic threshold above which an ask is considered "large". */
export const LARGE_REQUIREMENTS_THRESHOLD = 7;
export const MANY_TARGETS_THRESHOLD = 3;
export const MANY_SOURCES_THRESHOLD = 3;

/**
 * Derive deterministic scope risks from the structured intake evidence.
 * Conservative: each risk is a flag for a human, never a blocker by itself.
 */
export function detectScopeRisks(input: ScopeRiskInput): ScopeRisk[] {
  const risks: ScopeRisk[] = [];

  if (input.requirements.length > LARGE_REQUIREMENTS_THRESHOLD) {
    risks.push({
      id: "oversized_scope",
      description: `The ticket lists ${input.requirements.length} requirements, which is large for a single model.`,
      severity: "high",
      mitigation:
        "Split into multiple tickets/models along grain or source boundaries.",
    });
  }

  if (input.targets.length > MANY_TARGETS_THRESHOLD) {
    risks.push({
      id: "multiple_targets",
      description: `${input.targets.length} distinct target models/deliverables are implied by one ticket.`,
      severity: "medium",
      mitigation: "Confirm whether each target should be its own deliverable.",
    });
  }

  if (input.sourceSystems.length > MANY_SOURCES_THRESHOLD) {
    risks.push({
      id: "many_sources",
      description: `Joins across ${input.sourceSystems.length} source systems increase integration and grain-mismatch risk.`,
      severity: "medium",
      mitigation:
        "Validate join keys and grain compatibility across sources during EDA.",
    });
  }

  if (input.acceptanceCriteria.length === 0) {
    risks.push({
      id: "no_acceptance_criteria",
      description:
        "No acceptance criteria — the deliverable cannot be objectively validated.",
      severity: "high",
      mitigation: "Define measurable acceptance criteria before modeling.",
    });
  }

  if (input.ambiguousTerms.length > 0) {
    risks.push({
      id: "undefined_metrics",
      description: `Undefined business terms (${input.ambiguousTerms.join(
        ", ",
      )}) risk building the wrong metric.`,
      severity: "high",
      mitigation:
        "Obtain exact definitions (formula, grain, filters) for each term.",
    });
  }

  if (input.dependencies.length > 0) {
    risks.push({
      id: "external_dependencies",
      description: `Work depends on ${input.dependencies.length} external item(s); these may not be ready.`,
      severity: "medium",
      mitigation: "Confirm dependency status before starting build.",
    });
  }

  if (input.injectionDetected) {
    risks.push({
      id: "untrusted_directives",
      description:
        "The ticket text contained instruction-like / injection patterns (neutralized).",
      severity: "low",
      mitigation:
        "Ignore embedded directives; treat ticket text strictly as evidence.",
    });
  }

  // Stable sort: severity high→low, then id.
  const rank: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 };
  return risks.sort((a, b) =>
    rank[a.severity] !== rank[b.severity]
      ? rank[a.severity] - rank[b.severity]
      : a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Split recommendation.
// ---------------------------------------------------------------------------

export interface SplitRecommendation {
  recommended: boolean;
  reason: string;
  /** Suggested split axes (deterministic), empty when not recommended. */
  suggestedSplits: string[];
}

/**
 * Recommend splitting a ticket when it is too large along any obvious axis.
 * Deterministic: based purely on counts, never on judgement.
 */
export function recommendSplit(input: ScopeRiskInput): SplitRecommendation {
  const reasons: string[] = [];
  const splits: string[] = [];

  if (input.requirements.length > LARGE_REQUIREMENTS_THRESHOLD) {
    reasons.push(`${input.requirements.length} requirements in one ticket`);
    splits.push("by requirement cluster");
  }
  if (input.targets.length > MANY_TARGETS_THRESHOLD) {
    reasons.push(`${input.targets.length} target deliverables`);
    splits.push("one ticket per target model/dashboard");
  }
  if (input.sourceSystems.length > MANY_SOURCES_THRESHOLD) {
    reasons.push(`${input.sourceSystems.length} source systems`);
    splits.push("by source system / staging layer");
  }

  const recommended = reasons.length > 0;
  return {
    recommended,
    reason: recommended
      ? `Ticket appears oversized: ${reasons.join("; ")}.`
      : "Ticket is appropriately scoped for a single deliverable.",
    suggestedSplits: [...new Set(splits)],
  };
}

// ---------------------------------------------------------------------------
// Proposed assumptions.
// ---------------------------------------------------------------------------

export interface ProposedAssumption {
  /** What the assumption is about. */
  topic: string;
  /** The default the team would proceed under absent an answer. */
  assumption: string;
}

/**
 * Propose safe, explicit defaults so engineering can proceed under stated
 * assumptions while questions are outstanding. Each MUST be confirmed by a
 * human — these are never asserted as fact.
 */
export function proposeAssumptions(
  input: ScopeRiskInput,
): ProposedAssumption[] {
  const out: ProposedAssumption[] = [];

  if (input.sourceSystems.length > 0) {
    out.push({
      topic: "source systems",
      assumption: `Model reads only from the detected sources: ${input.sourceSystems.join(
        ", ",
      )}.`,
    });
  }

  if (input.acceptanceCriteria.length === 0) {
    out.push({
      topic: "acceptance criteria",
      assumption:
        "In the absence of stated criteria, the model must at minimum build cleanly and pass schema/not-null tests on its primary key.",
    });
  }

  for (const term of input.ambiguousTerms) {
    out.push({
      topic: `definition of "${term}"`,
      assumption: `Pending a definition, "${term}" is treated as an OPEN QUESTION and will not be hard-coded.`,
    });
  }

  if (input.targets.length === 0) {
    out.push({
      topic: "target model",
      assumption:
        "A single dbt mart model will be produced unless a different deliverable is specified.",
    });
  }

  return out;
}
