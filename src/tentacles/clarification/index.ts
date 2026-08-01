/**
 * Clarification & Scoping tentacle.
 *
 * Sits between intake and context. It reads the intake artifacts
 * (`intake.md` / `requirements.md` / `acceptance_criteria.md`), then
 * deterministically:
 *   - triages questions into BLOCKING vs NON-BLOCKING and groups them by
 *     stakeholder,
 *   - surfaces scope risks with severities,
 *   - proposes explicit assumptions so engineering can proceed safely,
 *   - recommends splitting the ticket if it is too large,
 *   - drafts a Jira/GitHub clarification comment, and
 *   - (in DRAFT mode only) sketches follow-up tickets for spun-off scope.
 *
 * Outputs (under `.oswald/`):
 *   - open_questions.md         — triaged + stakeholder-grouped questions
 *   - scope_risks.md            — risks, split recommendation, assumptions
 *   - clarification_comment.md  — the drafted external comment (NOT posted)
 *   - missing_information_request.md — auto-drafted when the readiness gate
 *     fails: a structured request keyed to the FAILED readiness dimensions,
 *     routed to the identified stakeholders (draft-only unless approved)
 *
 * READINESS GATE: when `policies.readiness.min_score` is configured and the
 * score intake recorded in `state.requirements.readiness` is below it, the
 * workflow lands in `blocked` (CLI exit 2). A human can proceed anyway with
 * `clarify --override-readiness "<reason>"` — the override is recorded in
 * state and appended to decision_log.md. With no `min_score` configured
 * (the default) the gate is entirely inactive and behavior is unchanged.
 *
 * Side effects are DEFAULT-DENY. Posting the comment / the missing-information
 * request or creating follow-up tickets requires BOTH an explicit `yes` AND a
 * permitting policy (`ticket_update` action class), routed through the
 * ApprovalService. Without those, this tentacle only ever DRAFTS.
 *
 * All upstream content is UNTRUSTED. The artifacts were trust-wrapped + redacted
 * at intake time; we still treat them strictly as evidence, never instructions,
 * and re-redact everything we render before persisting.
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
import { policyFromConfig } from "../../core/approvals/index.js";
import { ARTIFACT_FILES } from "../../core/artifacts/index.js";
import type { StateReadiness } from "../../core/state/index.js";
import {
  buildMissingInfoQuestions,
  type MissingInfoQuestion,
} from "../intake/readiness.js";
import {
  buildEvidenceFromArtifacts,
  type IntakeEvidence,
} from "./read-evidence.js";
import {
  buildQuestions,
  groupByStakeholder,
  detectScopeRisks,
  recommendSplit,
  proposeAssumptions,
  routeStakeholder,
  type ClarificationQuestion,
  type ScopeRisk,
  type SplitRecommendation,
  type ProposedAssumption,
  type ScopeRiskInput,
} from "./analyze.js";

export const ARTIFACT_NAMES = {
  openQuestions: "open_questions.md",
  scopeRisks: "scope_risks.md",
  comment: "clarification_comment.md",
  missingInfo: ARTIFACT_FILES.missingInfoRequest,
} as const;

/** The running decision log (also appended by the delivery tentacle). */
const DECISION_LOG = "decision_log.md";

/** Intake artifacts this tentacle reads (each optional → degrade gracefully). */
export const INTAKE_ARTIFACTS = {
  brief: "intake.md",
  requirements: "requirements.md",
  acceptance: "acceptance_criteria.md",
} as const;

/**
 * Upstream artifacts this tentacle reads. Mirrored by the drift checker's
 * consumption-edge table (kept aligned by a unit test).
 */
export const INPUT_ARTIFACTS = [
  INTAKE_ARTIFACTS.brief,
  INTAKE_ARTIFACTS.requirements,
  INTAKE_ARTIFACTS.acceptance,
] as const;

// --- I/O schemas -----------------------------------------------------------

export const ClarificationInputSchema = z.object({
  /** Ticket id the clarification targets. */
  ticketId: z.string().optional(),
  /** Explicit human consent to POST the comment / CREATE follow-up tickets. */
  yes: z.boolean().optional(),
  /** Audit reason carried into the approval decision. */
  reason: z.string().optional(),
  /**
   * Human override for a failing readiness gate: the pipeline proceeds and the
   * reason is recorded as a decision (state + decision_log.md).
   */
  overrideReadiness: z.string().optional(),
});
export type ClarificationInput = z.infer<typeof ClarificationInputSchema>;

const QuestionSchema = z.object({
  text: z.string(),
  priority: z.enum(["blocking", "non_blocking"]),
  stakeholder: z.string(),
  rationale: z.string(),
});

const ScopeRiskSchema = z.object({
  id: z.string(),
  description: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  mitigation: z.string(),
});

export const ClarificationOutputSchema = z.object({
  ticketId: z.string().nullable(),
  title: z.string(),
  questions: z.array(QuestionSchema),
  blockingCount: z.number().int().min(0),
  nonBlockingCount: z.number().int().min(0),
  scopeRisks: z.array(ScopeRiskSchema),
  splitRecommended: z.boolean(),
  splitReason: z.string(),
  suggestedSplits: z.array(z.string()),
  assumptions: z.array(
    z.object({ topic: z.string(), assumption: z.string() }),
  ),
  /** Whether the external comment was actually posted (gated). */
  commentPosted: z.boolean(),
  /** Whether follow-up tickets were actually created (gated). */
  followUpTicketsCreated: z.boolean(),
  /** The readiness gate evaluation for this run. */
  readinessGate: z.object({
    /** Whether `policies.readiness.min_score` is configured at all. */
    configured: z.boolean(),
    /** The recorded readiness score (null when intake never scored). */
    score: z.number().min(0).max(1).nullable(),
    minScore: z.number().min(0).max(1).nullable(),
    /** True when the gate is inactive/unscored or the score met the minimum. */
    passed: z.boolean(),
    /** True when the run landed the workflow in `blocked` (exit 2). */
    blocked: z.boolean(),
    /** True when a recorded human override let the pipeline proceed. */
    overridden: z.boolean(),
    failedDimensions: z.array(z.string()),
  }),
  /** Whether the missing-information request was actually posted (gated). */
  missingInfoRequestPosted: z.boolean(),
  /** True when prior intake artifacts were missing and we degraded. */
  degraded: z.boolean(),
});
export type ClarificationOutput = z.infer<typeof ClarificationOutputSchema>;

// --- helpers ---------------------------------------------------------------

async function safeRead(
  ctx: TentacleContext,
  name: string,
): Promise<string | null> {
  try {
    if (!(await ctx.artifacts.exists(name))) return null;
    return await ctx.artifacts.read(name);
  } catch {
    return null;
  }
}

/**
 * Resolve the structured intake evidence. Primary path: read the prior intake
 * artifacts. Fallback: if all three are missing but a ticket provider + id are
 * available, re-derive a thin evidence object from the live ticket text
 * (treated as untrusted). Final fallback: an empty, fully-degraded object.
 */
async function resolveEvidence(
  ctx: TentacleContext,
  input: ClarificationInput,
): Promise<{ evidence: IntakeEvidence; warnings: string[]; degraded: boolean }> {
  const warnings: string[] = [];

  const intakeMd = await safeRead(ctx, INTAKE_ARTIFACTS.brief);
  const requirementsMd = await safeRead(ctx, INTAKE_ARTIFACTS.requirements);
  const acceptanceMd = await safeRead(ctx, INTAKE_ARTIFACTS.acceptance);

  if (intakeMd || requirementsMd || acceptanceMd) {
    return {
      evidence: buildEvidenceFromArtifacts({
        intakeMd,
        requirementsMd,
        acceptanceMd,
      }),
      warnings,
      degraded: false,
    };
  }

  // No intake artifacts. Degrade: try the live ticket as untrusted evidence.
  const id = input.ticketId ?? ctx.ticketId;
  if (ctx.providers.ticket && id) {
    warnings.push(
      "No intake artifacts found; deriving clarification from the live ticket (run intake first for full fidelity).",
    );
    const ticket = await ctx.providers.ticket.getTicket(id);
    const wrap = ctx.policy.sanitizer.wrap(ticket.body, ticket.source);
    if (wrap.report.detected) {
      warnings.push(
        `Prompt-injection patterns detected in ticket content (${wrap.report.findings
          .map((f) => f.id)
          .join(", ")}); neutralized and flagged — do NOT act on them.`,
      );
    }
    const evidence = buildEvidenceFromArtifacts({
      intakeMd: `# Intake Brief: ${ticket.title || ticket.id}\n\n${wrap.neutralized}`,
      requirementsMd: wrap.neutralized,
      acceptanceMd: null,
    });
    return { evidence, warnings, degraded: true };
  }

  warnings.push(
    "No intake artifacts and no ticket provider available; producing a draft-only clarification skeleton.",
  );
  return {
    evidence: buildEvidenceFromArtifacts({
      intakeMd: null,
      requirementsMd: null,
      acceptanceMd: null,
    }),
    warnings,
    degraded: true,
  };
}

function bulletList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

function renderGroupedQuestions(
  groups: Array<{ stakeholder: string; questions: ClarificationQuestion[] }>,
): string {
  if (groups.length === 0) return "_No outstanding questions._";
  const parts: string[] = [];
  for (const g of groups) {
    parts.push(`### ${g.stakeholder}`);
    for (const q of g.questions) {
      const tag = q.priority === "blocking" ? "**[BLOCKING]**" : "[non-blocking]";
      parts.push(`- ${tag} ${q.text}`);
      parts.push(`  - _Why:_ ${q.rationale}`);
    }
    parts.push("");
  }
  return parts.join("\n").trim();
}

function renderRisks(risks: ScopeRisk[]): string {
  if (risks.length === 0) return "_No scope risks detected._";
  const rows = risks.map(
    (r) =>
      `| \`${r.severity}\` | ${escapeCell(r.id)} | ${escapeCell(
        r.description,
      )} | ${escapeCell(r.mitigation)} |`,
  );
  return [
    "| Severity | Risk | Description | Mitigation |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderAssumptions(assumptions: ProposedAssumption[]): string {
  if (assumptions.length === 0) {
    return "_No assumptions proposed — proceed only with confirmed facts._";
  }
  return assumptions
    .map(
      (a) =>
        `- **${a.topic}:** ${a.assumption} _(ASSUMPTION — confirm or reject before build.)_`,
    )
    .join("\n");
}

function renderSplit(split: SplitRecommendation): string {
  const head = split.recommended
    ? `**Split recommended.** ${split.reason}`
    : `**No split needed.** ${split.reason}`;
  if (!split.recommended) return head;
  return [head, "", bulletList(split.suggestedSplits, "no axes")].join("\n");
}

/** Build the external comment body that would be posted to the ticket. */
function renderCommentBody(
  title: string,
  questions: ClarificationQuestion[],
  split: SplitRecommendation,
  assumptions: ProposedAssumption[],
): string {
  const blocking = questions.filter((q) => q.priority === "blocking");
  const nonBlocking = questions.filter((q) => q.priority === "non_blocking");

  const parts: string[] = [
    `Thanks for the ticket "${title}". Before we start modeling, we need a few clarifications.`,
    "",
    "**Blocking questions** (we cannot start until these are answered):",
    blocking.length
      ? blocking.map((q, i) => `${i + 1}. ${q.text}`).join("\n")
      : "_None — thank you, scope is clear enough to begin._",
    "",
    "**Non-blocking questions** (we will proceed under assumptions; please correct if wrong):",
    nonBlocking.length
      ? nonBlocking.map((q, i) => `${i + 1}. ${q.text}`).join("\n")
      : "_None._",
    "",
    "**Assumptions we will proceed under unless told otherwise:**",
    assumptions.length
      ? assumptions.map((a) => `- ${a.topic}: ${a.assumption}`).join("\n")
      : "_None._",
  ];

  if (split.recommended) {
    parts.push(
      "",
      "**Scope note:** this ticket looks large for a single deliverable. " +
        `We suggest splitting it (${split.suggestedSplits.join("; ")}). ` +
        "Let us know if you'd like us to break it into follow-up tickets.",
    );
  }

  return parts.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function pct(v: number): string {
  return (v * 100).toFixed(0);
}

// --- readiness gate --------------------------------------------------------

/** A missing-information question routed to a stakeholder. */
interface RoutedMissingInfoQuestion extends MissingInfoQuestion {
  stakeholder: string;
}

/** The evaluated readiness gate for this run. */
interface ReadinessGateEvaluation {
  configured: boolean;
  score: number | null;
  minScore: number | null;
  /** True when inactive/unscored or the score met the minimum. */
  passed: boolean;
  /** True when the pipeline must land in `blocked`. */
  blocked: boolean;
  /** True when a human override (new or previously recorded) lets it pass. */
  overridden: boolean;
  failedDimensions: string[];
  warnings: string[];
}

/**
 * Evaluate the readiness gate. Default behavior is UNCHANGED: with no
 * `policies.readiness.min_score` configured the gate is inactive. When
 * configured but intake never recorded a score, the gate warns and stays open
 * (run `oswald intake` to score) rather than guessing a score here.
 */
function evaluateReadinessGate(args: {
  minScore: number | null;
  recorded: StateReadiness | null;
  overrideReason: string | undefined;
}): ReadinessGateEvaluation {
  const { minScore, recorded, overrideReason } = args;
  const gate: ReadinessGateEvaluation = {
    configured: minScore !== null,
    score: recorded?.score ?? null,
    minScore,
    passed: true,
    blocked: false,
    overridden: false,
    failedDimensions: recorded?.failed_dimensions ?? [],
    warnings: [],
  };

  if (!gate.configured) return gate;

  if (gate.score === null) {
    gate.warnings.push(
      `Readiness gating is configured (policies.readiness.min_score=${minScore}) but no readiness score is recorded — run \`oswald intake\` to score the ticket. Proceeding ungated.`,
    );
    return gate;
  }

  if (gate.score >= minScore!) return gate;

  gate.passed = false;
  if (overrideReason) {
    gate.overridden = true;
  } else if (recorded?.override) {
    gate.overridden = true;
    gate.warnings.push(
      `Readiness ${pct(gate.score)}% is below the required ${pct(minScore!)}% — honoring the override recorded at ${recorded.override.at} ("${recorded.override.reason}"). Re-run intake to re-score and clear it.`,
    );
  } else {
    gate.blocked = true;
  }
  return gate;
}

/** The external missing-information comment body (what would be posted). */
function renderMissingInfoBody(
  title: string,
  gate: ReadinessGateEvaluation,
  questions: RoutedMissingInfoQuestion[],
): string {
  return [
    `The ticket "${title}" is not yet ready for engineering: readiness ${pct(
      gate.score ?? 0,
    )}% is below the required ${pct(gate.minScore ?? 0)}%.`,
    "",
    "**Missing information** (please provide before modeling can start):",
    questions.length
      ? questions
          .map((q, i) => `${i + 1}. ${q.question} _(→ ${q.stakeholder})_`)
          .join("\n")
      : "_See the readiness scorecard for details._",
    "",
    "Once answered, we will re-run intake to re-score readiness and continue.",
  ].join("\n");
}

/** Render the missing-information request artifact (DRAFT by default). */
function renderMissingInfoDoc(
  ctx: TentacleContext,
  args: {
    title: string;
    gate: ReadinessGateEvaluation;
    questions: RoutedMissingInfoQuestion[];
    body: string;
    posted: boolean;
    ticketId: string | null;
  },
): string {
  const { title, gate, questions, body, posted, ticketId } = args;
  const rows = questions.map(
    (q) =>
      `| ${escapeCell(q.label)} | ${escapeCell(q.question)} | ${escapeCell(q.stakeholder)} |`,
  );
  return ctx.artifacts.renderMarkdown({
    title: `Missing Information Request (DRAFT): ${title}`,
    summary: posted
      ? "This request was POSTED to the ticket (approved)."
      : "This is a DRAFT. It has NOT been posted. Posting requires explicit approval (--yes + policy).",
    sections: [
      {
        heading: "Readiness Gate",
        body: [
          `- **Score:** ${pct(gate.score ?? 0)}% (required ≥ ${pct(gate.minScore ?? 0)}%)`,
          `- **Failed dimensions:** ${gate.failedDimensions.join(", ") || "—"}`,
          `- **Outcome:** ${
            gate.blocked
              ? "BLOCKED — provide the missing information and re-run intake, or record a human override (`clarify --override-readiness \"<reason>\"`)."
              : "proceeding under a recorded human override."
          }`,
        ].join("\n"),
      },
      {
        heading: "Requested Information",
        body:
          rows.length > 0
            ? [
                "| Dimension | Question | Routed to |",
                "| --- | --- | --- |",
                ...rows,
              ].join("\n")
            : "_No dimension-level questions derived._",
      },
      { heading: "Comment Body", body: ["```", body, "```"].join("\n") },
      {
        heading: "Status",
        body: [
          `- **Posted:** ${posted ? "yes" : "no (draft)"}`,
          `- **Target ticket:** ${ticketId ?? "_none_"}`,
        ].join("\n"),
      },
    ],
  });
}

// --- the tentacle ----------------------------------------------------------

export const clarificationTentacle: Tentacle<
  typeof ClarificationInputSchema,
  typeof ClarificationOutputSchema
> = {
  id: "clarification",
  title: "Clarification & Scoping",
  description:
    "Identify ambiguity, scope risks, and open questions before engineering — triage blocking vs non-blocking, group by stakeholder, propose assumptions, recommend splitting oversized tickets, and draft an external clarification comment (posting/creating is gated by approval).",

  advancesTo: "context",

  inputSchema: ClarificationInputSchema,
  outputSchema: ClarificationOutputSchema,

  requiredTools: [],
  optionalTools: [
    "ticket.getTicket",
    "ticket.draftComment",
    "ticket.postComment",
  ],

  checklist: [
    "Prior intake artifacts read (or degraded gracefully)",
    "Questions triaged into blocking vs non-blocking",
    "Questions grouped by stakeholder",
    "Scope risks surfaced with severities",
    "Split recommendation made for oversized tickets",
    "Explicit assumptions proposed for every gap",
    "Clarification comment drafted (never posted without approval)",
    "Readiness gate evaluated against policies.readiness.min_score (when set)",
    "Missing-information request drafted for failed readiness dimensions (gated posting)",
    "Follow-up tickets created in DRAFT mode only (gated)",
    "All upstream content treated as untrusted evidence",
    "Every unsourced rule tagged assumption/open_question",
  ],

  async run(
    ctx: TentacleContext,
  ): Promise<TentacleResult<ClarificationOutput>> {
    const input = ClarificationInputSchema.parse({
      ticketId: ctx.ticketId,
      yes: ctx.options.yes as boolean | undefined,
      reason: ctx.options.reason as string | undefined,
      overrideReadiness: ctx.options.overrideReadiness as string | undefined,
    });

    const { evidence, warnings, degraded } = await resolveEvidence(ctx, input);

    // --- Deterministic analysis. ------------------------------------------
    const riskInput: ScopeRiskInput = {
      requirements: evidence.requirements,
      acceptanceCriteria: evidence.acceptanceCriteria,
      sourceSystems: evidence.sourceSystems,
      targets: evidence.targets,
      ambiguousTerms: evidence.ambiguousTerms,
      dependencies: evidence.dependencies,
      injectionDetected: evidence.injectionDetected,
    };

    const questions = buildQuestions({
      openQuestions: evidence.priorOpenQuestions,
      ambiguousTerms: evidence.ambiguousTerms,
      stakeholders: evidence.stakeholders,
      hasAcceptanceCriteria: evidence.acceptanceCriteria.length > 0,
      sourceSystems: evidence.sourceSystems,
      requirements: evidence.requirements,
    });
    const grouped = groupByStakeholder(questions);
    const scopeRisks = detectScopeRisks(riskInput);
    const split = recommendSplit(riskInput);
    const assumptions = proposeAssumptions(riskInput);

    const blocking = questions.filter((q) => q.priority === "blocking");
    const nonBlocking = questions.filter((q) => q.priority === "non_blocking");

    // --- Evidence ledger (the quality rule). ------------------------------
    const ledger: EvidenceItem[] = [];
    ledger.push(
      markEvidence(
        "acceptance_criteria",
        evidence.acceptanceCriteria.length
          ? `${evidence.acceptanceCriteria.length} criterion(a)`
          : "none",
        evidence.acceptanceCriteria.length ? "confirmed" : "open_question",
        evidence.acceptanceCriteria.length ? "acceptance_criteria.md" : "—",
      ),
    );
    ledger.push(
      markEvidence(
        "source_systems",
        evidence.sourceSystems.length
          ? evidence.sourceSystems.join(", ")
          : "unknown",
        evidence.sourceSystems.length ? "inferred" : "open_question",
        evidence.sourceSystems.length ? "intake artifacts" : "—",
      ),
    );
    for (const a of assumptions) {
      ledger.push(
        markEvidence(a.topic, a.assumption, "assumption", "clarification default"),
      );
    }
    for (const term of evidence.ambiguousTerms) {
      ledger.push(
        markEvidence(
          `definition: ${term}`,
          "undefined — needs human definition",
          "open_question",
          "intake artifacts",
        ),
      );
    }

    // --- Draft the external comment (NEVER auto-posted). ------------------
    const commentBody = renderCommentBody(
      evidence.title,
      questions,
      split,
      assumptions,
    );

    // --- Readiness gate (policies.readiness.min_score). --------------------
    // Default behavior unchanged: no configured min_score → gate inactive.
    // The score is the one intake recorded in state.requirements.readiness;
    // an override (this run's flag, or one recorded earlier) is a human
    // decision that lets the pipeline proceed despite a failing score.
    const overrideReason = input.overrideReadiness?.trim() || undefined;
    const gate = evaluateReadinessGate({
      minScore: ctx.config.policies.readiness.min_score,
      recorded: ctx.state.requirements.readiness,
      overrideReason,
    });
    warnings.push(...gate.warnings);

    // Auto-draft the structured missing-information request whenever the
    // score is below the configured threshold (blocked OR overridden), keyed
    // to the FAILED dimensions and routed to the identified stakeholders.
    let missingInfoQuestions: RoutedMissingInfoQuestion[] = [];
    let missingInfoBody: string | null = null;
    if (!gate.passed) {
      missingInfoQuestions = buildMissingInfoQuestions(gate.failedDimensions, {
        undefinedTerms: evidence.ambiguousTerms,
      }).map((q) => ({
        ...q,
        stakeholder: routeStakeholder(q.question, evidence.stakeholders),
      }));
      missingInfoBody = renderMissingInfoBody(
        evidence.title,
        gate,
        missingInfoQuestions,
      );
    }

    // A NEW override supplied this run is recorded as a decision (state +
    // decision log). The reason is redacted before persisting anywhere.
    let newOverride: { reason: string; at: string } | null = null;
    if (gate.overridden && overrideReason) {
      const { content: safeReason } =
        ctx.policy.sensitive.redactArtifactContent(overrideReason);
      newOverride = { reason: safeReason, at: ctx.clock.nowIso() };
      warnings.push(
        `Readiness ${pct(gate.score ?? 0)}% is below the required ${pct(
          gate.minScore ?? 0,
        )}% — proceeding under a recorded human override: "${safeReason}".`,
      );
    }

    // --- Approval gate for side effects (default-deny). ------------------
    const policy = policyFromConfig(ctx.config.policies);
    let commentPosted = false;
    let followUpTicketsCreated = false;
    let missingInfoPosted = false;

    const wantsSideEffect = input.yes === true;
    if (wantsSideEffect) {
      // Posting the comment.
      const postDecision = ctx.approvals.requireApproval("ticket_update", {
        yes: input.yes,
        policy,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      if (postDecision.allowed && ctx.providers.ticket && (input.ticketId ?? ctx.ticketId)) {
        const id = (input.ticketId ?? ctx.ticketId)!;
        const draft = await ctx.providers.ticket.draftComment(id, commentBody);
        const res = await ctx.providers.ticket.postComment(draft, {
          yes: input.yes,
          ...(input.reason ? { reason: input.reason } : {}),
        });
        commentPosted = res.ok;
        if (!res.ok && res.error) warnings.push(`Comment not posted: ${res.error}`);

        // The missing-information request rides the SAME ticket_update
        // approval: explicit consent + permitting policy, or it stays a draft.
        if (missingInfoBody) {
          const infoDraft = await ctx.providers.ticket.draftComment(
            id,
            missingInfoBody,
          );
          const infoRes = await ctx.providers.ticket.postComment(infoDraft, {
            yes: input.yes,
            ...(input.reason ? { reason: input.reason } : {}),
          });
          missingInfoPosted = infoRes.ok;
          if (!infoRes.ok && infoRes.error) {
            warnings.push(
              `Missing-information request not posted: ${infoRes.error}`,
            );
          }
        }
      } else if (!postDecision.allowed) {
        warnings.push(`Comment not posted: ${postDecision.reason}`);
      } else {
        warnings.push(
          "Comment not posted: no ticket provider / ticket id available.",
        );
      }

      // Creating follow-up tickets (only when a split is recommended).
      if (split.recommended) {
        const createDecision = ctx.approvals.requireApproval("create_ticket", {
          yes: input.yes,
          policy,
          ...(input.reason ? { reason: input.reason } : {}),
        });
        if (!createDecision.allowed) {
          warnings.push(
            `Follow-up tickets not created: ${createDecision.reason}`,
          );
        } else {
          // No deterministic create-ticket provider method exists; we keep
          // follow-up tickets in DRAFT mode (sketched in scope_risks.md) even
          // when approved, and flag that creation is left to the operator.
          followUpTicketsCreated = false;
          warnings.push(
            "Follow-up tickets approved but kept in DRAFT mode (no create-ticket provider wired); see scope_risks.md.",
          );
        }
      }
    }

    // --- Render + persist artifacts (redacting PII). ----------------------
    const written: string[] = [];

    const openQuestionsMd = ctx.artifacts.renderMarkdown({
      title: `Open Questions: ${evidence.title}`,
      summary: `${blocking.length} blocking, ${nonBlocking.length} non-blocking question(s) before engineering can safely proceed.`,
      sections: [
        {
          heading: "Blocking Questions",
          body: blocking.length
            ? blocking.map((q, i) => `${i + 1}. ${q.text} _(→ ${q.stakeholder})_`).join("\n")
            : "_None — scope is clear enough to begin._",
        },
        {
          heading: "Non-Blocking Questions",
          body: nonBlocking.length
            ? nonBlocking.map((q, i) => `${i + 1}. ${q.text} _(→ ${q.stakeholder})_`).join("\n")
            : "_None._",
        },
        { heading: "Grouped by Stakeholder", body: renderGroupedQuestions(grouped) },
        { heading: "Evidence Ledger", body: renderEvidenceTable(ledger) },
      ],
    });

    const scopeRisksMd = ctx.artifacts.renderMarkdown({
      title: `Scope Risks: ${evidence.title}`,
      summary:
        scopeRisks.length > 0
          ? `${scopeRisks.length} scope risk(s) identified.`
          : "No scope risks identified.",
      sections: [
        { heading: "Risks", body: renderRisks(scopeRisks) },
        { heading: "Split Recommendation", body: renderSplit(split) },
        {
          heading: "Follow-up Tickets (DRAFT)",
          body: split.recommended
            ? [
                "These follow-up tickets are DRAFTS only. They are not created without explicit approval.",
                "",
                split.suggestedSplits
                  .map((s, i) => `${i + 1}. Split ${s} — carve out of "${evidence.title}".`)
                  .join("\n"),
              ].join("\n")
            : "_No split recommended; no follow-up tickets drafted._",
        },
        { heading: "Proposed Assumptions", body: renderAssumptions(assumptions) },
      ],
    });

    const commentMd = ctx.artifacts.renderMarkdown({
      title: `Clarification Comment (DRAFT): ${evidence.title}`,
      summary: commentPosted
        ? "This comment was POSTED to the ticket (approved)."
        : "This is a DRAFT. It has NOT been posted. Posting requires explicit approval (--yes + policy).",
      sections: [
        { heading: "Comment Body", body: ["```", commentBody, "```"].join("\n") },
        {
          heading: "Status",
          body: [
            `- **Posted:** ${commentPosted ? "yes" : "no (draft)"}`,
            `- **Target ticket:** ${input.ticketId ?? ctx.ticketId ?? "_none_"}`,
          ].join("\n"),
        },
      ],
    });

    const toWrite: Array<[string, string]> = [
      [ARTIFACT_NAMES.openQuestions, openQuestionsMd],
      [ARTIFACT_NAMES.scopeRisks, scopeRisksMd],
      [ARTIFACT_NAMES.comment, commentMd],
    ];
    if (missingInfoBody) {
      toWrite.push([
        ARTIFACT_NAMES.missingInfo,
        renderMissingInfoDoc(ctx, {
          title: evidence.title,
          gate,
          questions: missingInfoQuestions,
          body: missingInfoBody,
          posted: missingInfoPosted,
          ticketId: (input.ticketId ?? ctx.ticketId) || null,
        }),
      ]);
    }
    for (const [name, md] of toWrite) {
      const { content } = ctx.policy.sensitive.redactArtifactContent(md);
      const path = await ctx.artifacts.write(name, content);
      written.push(path);
    }

    // --- Decision log: record a NEW readiness override (APPEND-only). ------
    if (newOverride) {
      const entryLines = [
        `## ${newOverride.at} — clarify (readiness override)`,
        "",
        `- Ticket: ${input.ticketId ?? ctx.ticketId ?? "—"}`,
        `- Readiness: ${pct(gate.score ?? 0)}% (required ≥ ${pct(gate.minScore ?? 0)}%)`,
        `- Failed dimensions: ${gate.failedDimensions.join(", ") || "—"}`,
        `- Override reason: ${newOverride.reason}`,
        "",
      ];
      const { content: entry } = ctx.policy.sensitive.redactArtifactContent(
        entryLines.join("\n"),
      );
      if (!(await ctx.artifacts.exists(DECISION_LOG))) {
        await ctx.artifacts.write(DECISION_LOG, "# Decision Log\n\n");
      }
      const decisionPath = await ctx.artifacts.append(DECISION_LOG, entry + "\n");
      written.push(decisionPath);
    }

    // --- Advance workflow state. ------------------------------------------
    // Clarification is complete; move into `context` so `oswald next`
    // recommends `context`. Unresolved blocking questions are recorded as
    // blockers but do not, by themselves, force the `blocked` state — that is a
    // human gate decision. The READINESS gate is the exception: when it is
    // configured and fails without an override, the workflow lands in
    // `blocked` (CLI exit 2) until the missing information is provided (and
    // intake re-scores) or a human override is recorded.
    const blockerTexts = blocking.map((q) => q.text);
    const readinessBlockers = gate.blocked
      ? [
          `Readiness gate failed: score ${pct(gate.score ?? 0)}% is below policies.readiness.min_score (${pct(
            gate.minScore ?? 0,
          )}%) — failed dimension(s): ${gate.failedDimensions.join(", ") || "unknown"}. Answer ${ARTIFACT_NAMES.missingInfo} and re-run intake, or record an override with \`clarify --override-readiness "<reason>"\`.`,
        ]
      : [];
    const recordedReadiness = ctx.state.requirements.readiness;
    await advanceWorkflow(ctx, {
      phase: gate.blocked ? "blocked" : "context",
      lastCommand: "clarify",
      artifacts: {
        open_questions: ARTIFACT_NAMES.openQuestions,
        scope_risks: ARTIFACT_NAMES.scopeRisks,
        clarification_comment: ARTIFACT_NAMES.comment,
        ...(missingInfoBody
          ? { missing_information_request: ARTIFACT_NAMES.missingInfo }
          : {}),
      },
      requirements: {
        unresolved_questions: questions.map((q) => q.text),
        ...(newOverride && recordedReadiness
          ? { readiness: { ...recordedReadiness, override: newOverride } }
          : {}),
      },
      blockers: [...readinessBlockers, ...blockerTexts],
    });

    const output: ClarificationOutput = ClarificationOutputSchema.parse({
      ticketId: (input.ticketId ?? ctx.ticketId) || null,
      title: evidence.title,
      questions,
      blockingCount: blocking.length,
      nonBlockingCount: nonBlocking.length,
      scopeRisks,
      splitRecommended: split.recommended,
      splitReason: split.reason,
      suggestedSplits: split.suggestedSplits,
      assumptions,
      commentPosted,
      followUpTicketsCreated,
      readinessGate: {
        configured: gate.configured,
        score: gate.score,
        minScore: gate.minScore,
        passed: gate.passed,
        blocked: gate.blocked,
        overridden: gate.overridden,
        failedDimensions: gate.failedDimensions,
      },
      missingInfoRequestPosted: missingInfoPosted,
      degraded,
    });

    const gateNote = gate.blocked
      ? `, readiness gate BLOCKED (${pct(gate.score ?? 0)}% < ${pct(gate.minScore ?? 0)}%)`
      : gate.overridden
        ? `, readiness gate overridden (${pct(gate.score ?? 0)}% < ${pct(gate.minScore ?? 0)}%)`
        : "";
    ctx.logger.info(
      `clarification: "${evidence.title}" — ${blocking.length} blocking, ${nonBlocking.length} non-blocking, ${scopeRisks.length} risk(s)${split.recommended ? ", split recommended" : ""}${gateNote}`,
    );

    const openQuestionTexts = blocking.map((q) => q.text);

    return {
      artifactsWritten: written,
      summary: `Clarification for "${evidence.title}": ${blocking.length} blocking / ${nonBlocking.length} non-blocking question(s), ${scopeRisks.length} scope risk(s)${split.recommended ? ", split recommended" : ""}${gateNote}.`,
      output,
      ...(openQuestionTexts.length ? { openQuestions: openQuestionTexts } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};
