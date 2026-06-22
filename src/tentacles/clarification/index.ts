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
 *
 * Side effects are DEFAULT-DENY. Posting the comment or creating follow-up
 * tickets requires BOTH an explicit `yes` AND a permitting policy, routed
 * through the ApprovalService. Without those, this tentacle only ever DRAFTS.
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
} as const;

const INTAKE_ARTIFACTS = {
  brief: "intake.md",
  requirements: "requirements.md",
  acceptance: "acceptance_criteria.md",
} as const;

// --- I/O schemas -----------------------------------------------------------

export const ClarificationInputSchema = z.object({
  /** Ticket id the clarification targets. */
  ticketId: z.string().optional(),
  /** Explicit human consent to POST the comment / CREATE follow-up tickets. */
  yes: z.boolean().optional(),
  /** Audit reason carried into the approval decision. */
  reason: z.string().optional(),
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

// --- the tentacle ----------------------------------------------------------

export const clarificationTentacle: Tentacle<
  typeof ClarificationInputSchema,
  typeof ClarificationOutputSchema
> = {
  id: "clarification",
  title: "Clarification & Scoping",
  description:
    "Identify ambiguity, scope risks, and open questions before engineering — triage blocking vs non-blocking, group by stakeholder, propose assumptions, recommend splitting oversized tickets, and draft an external clarification comment (posting/creating is gated by approval).",

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

    // --- Approval gate for side effects (default-deny). ------------------
    const policy = policyFromConfig(ctx.config.policies);
    let commentPosted = false;
    let followUpTicketsCreated = false;

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

    for (const [name, md] of [
      [ARTIFACT_NAMES.openQuestions, openQuestionsMd],
      [ARTIFACT_NAMES.scopeRisks, scopeRisksMd],
      [ARTIFACT_NAMES.comment, commentMd],
    ] as const) {
      const { content } = ctx.policy.sensitive.redactArtifactContent(md);
      const path = await ctx.artifacts.write(name, content);
      written.push(path);
    }

    // --- Advance workflow state. ------------------------------------------
    // Clarification is complete; move into `context` so `oswald next`
    // recommends `context`. Unresolved blocking questions are recorded as
    // blockers but do not, by themselves, force the `blocked` state — that is a
    // human gate decision.
    const blockerTexts = blocking.map((q) => q.text);
    await advanceWorkflow(ctx, {
      phase: "context",
      lastCommand: "clarify",
      artifacts: {
        open_questions: ARTIFACT_NAMES.openQuestions,
        scope_risks: ARTIFACT_NAMES.scopeRisks,
        clarification_comment: ARTIFACT_NAMES.comment,
      },
      requirements: {
        unresolved_questions: questions.map((q) => q.text),
      },
      blockers: blockerTexts,
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
      degraded,
    });

    ctx.logger.info(
      `clarification: "${evidence.title}" — ${blocking.length} blocking, ${nonBlocking.length} non-blocking, ${scopeRisks.length} risk(s)${split.recommended ? ", split recommended" : ""}`,
    );

    const openQuestionTexts = blocking.map((q) => q.text);

    return {
      artifactsWritten: written,
      summary: `Clarification for "${evidence.title}": ${blocking.length} blocking / ${nonBlocking.length} non-blocking question(s), ${scopeRisks.length} scope risk(s)${split.recommended ? ", split recommended" : ""}.`,
      output,
      ...(openQuestionTexts.length ? { openQuestions: openQuestionTexts } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};
