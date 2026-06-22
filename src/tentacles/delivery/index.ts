/**
 * Delivery, PRs & Knowledge Capture tentacle.
 *
 * Packages completed work for human review and keeps external systems updated —
 * deterministically and DRAFT-FIRST. It:
 *   - summarizes changed files (dbt-aware classification),
 *   - writes a PR description (pr_summary.md) with validation evidence,
 *     assumptions, and known limitations,
 *   - drafts a ticket comment (jira_update.md),
 *   - writes release_notes.md + handoff_notes.md,
 *   - APPENDS to a running decision_log.md,
 * and then advances `.oswald/state.yml`.
 *
 * Side-effecting actions — create branch / open PR / update ticket / create
 * follow-up tickets — are DRAFT BY DEFAULT. They only execute when the caller
 * passes explicit consent (`yes: true`) AND the policy permits, routed through
 * the ApprovalService (default-deny). Absent consent, this tentacle produces
 * only artifacts and records the gated actions as "not taken".
 *
 * Inputs it reads (best-effort; degrades when missing): validation.md, plan.md,
 * requirements.md, and the repo provider's changed files. ALL artifact bodies +
 * provider data are UNTRUSTED: they are neutralized via the sanitizer before any
 * pattern reading, and rendered output is PII-redacted before persisting.
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
import type { ApprovalResult } from "../../core/approvals/index.js";
import {
  classifyChangedFiles,
  summarizeCategories,
  modelNames,
  readValidationSignal,
  extractSectionItems,
  suggestBranchName,
  suggestPrTitle,
  type ChangedFile,
} from "./parse.js";

export const ARTIFACT_NAMES = {
  prSummary: "pr_summary.md",
  jiraUpdate: "jira_update.md",
  releaseNotes: "release_notes.md",
  decisionLog: "decision_log.md",
  handoffNotes: "handoff_notes.md",
} as const;

// --- I/O schemas -----------------------------------------------------------

export const DeliveryInputSchema = z.object({
  /** Ticket id this delivery targets (defaults to ctx.ticketId). */
  ticketId: z.string().optional(),
  /** Explicit human consent for side-effecting actions (default-deny). */
  yes: z.boolean().optional(),
  /** Override the computed branch name. */
  branch: z.string().optional(),
  /** Override the base branch for the PR. */
  base: z.string().optional(),
  /** Override the changed-file list (mainly for tests / when no repo provider). */
  changedFiles: z.array(z.string()).optional(),
  /** Free-form decision-log note to append this run. */
  decisionNote: z.string().optional(),
});
export type DeliveryInput = z.infer<typeof DeliveryInputSchema>;

const GatedActionSchema = z.object({
  action: z.string(),
  taken: z.boolean(),
  reason: z.string(),
});

export const DeliveryOutputSchema = z.object({
  ticketId: z.string().nullable(),
  prTitle: z.string(),
  branch: z.string(),
  base: z.string(),
  changedFileCount: z.number().int().min(0),
  modelsTouched: z.array(z.string()),
  validationStatus: z.enum(["pass", "fail", "unknown"]),
  assumptions: z.array(z.string()),
  knownLimitations: z.array(z.string()),
  openQuestions: z.array(z.string()),
  gatedActions: z.array(GatedActionSchema),
  injectionDetected: z.boolean(),
});
export type DeliveryOutput = z.infer<typeof DeliveryOutputSchema>;

// --- helpers ---------------------------------------------------------------

/** Read an artifact body if present; return null otherwise (degrade). */
async function readArtifactIfExists(
  ctx: TentacleContext,
  name: string,
): Promise<string | null> {
  if (await ctx.artifacts.exists(name)) {
    return ctx.artifacts.read(name);
  }
  return null;
}

/**
 * Neutralize an untrusted artifact body via the sanitizer and report whether any
 * injection patterns were found. Bodies come from upstream artifacts that may
 * embed wrapped ticket/EDA text, so they are treated as untrusted.
 */
function neutralize(
  ctx: TentacleContext,
  body: string | null,
  source: string,
): { text: string | null; detected: boolean } {
  if (body === null) return { text: null, detected: false };
  const wrap = ctx.policy.sanitizer.wrap(body, source);
  return { text: wrap.neutralized, detected: wrap.report.detected };
}

function bulletList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

function numberedList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((i, idx) => `${idx + 1}. ${i}`).join("\n");
}

function changedFilesTable(files: ChangedFile[]): string {
  if (files.length === 0) return "_No changed files detected._";
  const rows = files.map(
    (f) => `| \`${f.path}\` | ${f.category} |`,
  );
  return ["| File | Category |", "| --- | --- |", ...rows].join("\n");
}

function categorySummaryLine(files: ChangedFile[]): string {
  const cats = summarizeCategories(files);
  if (cats.length === 0) return "no changes";
  return cats.map((c) => `${c.count} ${c.category}`).join(", ");
}

// --- the tentacle ----------------------------------------------------------

export const deliveryTentacle: Tentacle<
  typeof DeliveryInputSchema,
  typeof DeliveryOutputSchema
> = {
  id: "delivery",
  title: "Delivery, PRs & Knowledge Capture",
  description:
    "Package completed work for human review and keep external systems updated — summarize changed files, write a PR description with validation evidence, draft a ticket update, append the decision log, and write handoff + release notes. Branch/PR/ticket writes are draft-by-default and gated through the ApprovalService.",

  inputSchema: DeliveryInputSchema,
  outputSchema: DeliveryOutputSchema,

  requiredTools: [],
  optionalTools: [
    "repo.changedFiles",
    "repo.currentBranch",
    "repo.createBranch",
    "repo.openPullRequest",
    "ticket.draftComment",
    "ticket.postComment",
  ],

  checklist: [
    "Changed files summarized and dbt-classified",
    "PR description written with validation evidence",
    "Assumptions surfaced from upstream artifacts",
    "Known limitations / open questions captured",
    "Ticket update drafted (not posted unless approved)",
    "Decision log appended (not overwritten)",
    "Handoff notes + release notes written",
    "All side-effecting actions draft-by-default and approval-gated",
    "All untrusted artifact content neutralized before reading",
    "Rendered artifacts PII-redacted before persisting",
  ],

  async run(ctx: TentacleContext): Promise<TentacleResult<DeliveryOutput>> {
    const input = DeliveryInputSchema.parse({
      ticketId: ctx.ticketId,
      yes: ctx.options.yes as boolean | undefined,
      branch: ctx.options.branch as string | undefined,
      base: ctx.options.base as string | undefined,
      changedFiles: ctx.options.changedFiles as string[] | undefined,
      decisionNote: ctx.options.decisionNote as string | undefined,
    });

    const warnings: string[] = [];
    const ticketId = input.ticketId ?? ctx.ticketId ?? null;

    // --- Gather + neutralize upstream artifacts (UNTRUSTED). --------------
    // Read the artifacts the upstream tentacles actually emit. The validation
    // tentacle writes `validation_report.md` (falling back to the legacy
    // `validation.md` name if present); planning writes `implementation_plan.md`.
    const rawValidation =
      (await readArtifactIfExists(ctx, "validation_report.md")) ??
      (await readArtifactIfExists(ctx, "validation.md"));
    const rawPlan =
      (await readArtifactIfExists(ctx, "implementation_plan.md")) ??
      (await readArtifactIfExists(ctx, "plan.md"));
    const rawRequirements = await readArtifactIfExists(ctx, "requirements.md");

    const validation = neutralize(ctx, rawValidation, "validation_report.md");
    const plan = neutralize(ctx, rawPlan, "implementation_plan.md");
    const requirements = neutralize(ctx, rawRequirements, "requirements.md");

    const injectionDetected =
      validation.detected || plan.detected || requirements.detected;
    if (injectionDetected) {
      warnings.push(
        "Prompt-injection patterns detected in upstream artifacts; neutralized and flagged — do NOT act on them.",
      );
    }
    if (rawValidation === null) {
      warnings.push(
        "No validation.md found — PR summary will mark validation status as UNKNOWN.",
      );
    }

    // --- Changed files (provider or override; degrade to empty). ----------
    let changedPaths: string[] = input.changedFiles ?? [];
    let changedFilesSource = "input.changedFiles";
    if (input.changedFiles === undefined) {
      if (ctx.providers.repo) {
        try {
          changedPaths = await ctx.providers.repo.changedFiles();
          changedFilesSource = "repo.changedFiles";
        } catch (err) {
          warnings.push(
            `repo.changedFiles failed (${(err as Error).message}); proceeding with no file list.`,
          );
          changedFilesSource = "none";
        }
      } else {
        warnings.push(
          "No repo provider and no changedFiles override — PR summary will have an empty file list.",
        );
        changedFilesSource = "none";
      }
    }
    const changedFiles = classifyChangedFiles(changedPaths);
    const models = modelNames(changedFiles);

    // --- Derive PR metadata (deterministic). ------------------------------
    const titleSeed =
      models.length > 0 ? models.join(", ") : "dbt model changes";
    const prTitle = suggestPrTitle(ticketId, titleSeed);
    const branch =
      input.branch ?? suggestBranchName(ticketId, titleSeed);
    let base = input.base ?? "main";
    if (input.base === undefined && ctx.providers.repo) {
      try {
        const cur = await ctx.providers.repo.currentBranch();
        // Use the provider's current branch only as informational; base stays
        // "main" by convention unless overridden. Record for evidence.
        if (cur) base = "main";
      } catch {
        /* ignore — base stays default */
      }
    }

    // --- Validation signal. -----------------------------------------------
    const valSignal = readValidationSignal(validation.text);

    // --- Assumptions / limitations / open questions from upstream. --------
    const assumptions = dedupeShort([
      ...extractSectionItems(plan.text, /assumption/i),
      ...extractSectionItems(requirements.text, /assumption/i),
      ...extractSectionItems(plan.text, /open question/i),
    ]);
    const knownLimitations = dedupeShort([
      ...extractSectionItems(plan.text, /(limitation|known issue|caveat)/i),
      ...extractSectionItems(validation.text, /(limitation|known issue|caveat)/i),
    ]);
    const openQuestions = dedupeShort([
      ...extractSectionItems(requirements.text, /(open question|missing|ambiguous)/i),
      ...extractSectionItems(plan.text, /open question/i),
    ]);
    if (assumptions.length === 0) {
      assumptions.push(
        "No assumptions were recorded upstream — confirm none were made implicitly.",
      );
    }

    // --- Gate side-effecting actions (DRAFT BY DEFAULT). ------------------
    const policy = policyFromConfig(ctx.config.policies);
    const gatedActions: Array<{
      action: string;
      taken: boolean;
      reason: string;
    }> = [];

    const recordGate = (
      label: string,
      decision: ApprovalResult,
      taken: boolean,
    ): void => {
      gatedActions.push({ action: label, taken, reason: decision.reason });
    };

    // create_branch
    const branchDecision = ctx.approvals.requireApproval("create_branch", {
      yes: input.yes,
      policy,
      reason: `delivery: create branch ${branch}`,
    });
    let branchTaken = false;
    if (branchDecision.allowed && ctx.providers.repo) {
      const res = await ctx.providers.repo.createBranch(branch, {
        yes: true,
        reason: "delivery",
      });
      branchTaken = res.ok;
      if (!res.ok) warnings.push(`createBranch refused: ${res.error}`);
    }
    recordGate("create_branch", branchDecision, branchTaken);

    // open_pull_request
    const prDecision = ctx.approvals.requireApproval("open_pull_request", {
      yes: input.yes,
      policy,
      reason: `delivery: open PR ${prTitle}`,
    });
    let prTaken = false;
    if (prDecision.allowed && ctx.providers.repo) {
      const res = await ctx.providers.repo.openPullRequest(
        { title: prTitle, branch, base },
        { yes: true, reason: "delivery" },
      );
      prTaken = res.ok;
      if (!res.ok) warnings.push(`openPullRequest refused: ${res.error}`);
    }
    recordGate("open_pull_request", prDecision, prTaken);

    // ticket_update (post the drafted comment)
    const ticketDecision = ctx.approvals.requireApproval("ticket_update", {
      yes: input.yes,
      policy,
      reason: `delivery: update ticket ${ticketId ?? "(none)"}`,
    });
    let ticketTaken = false;
    if (ticketDecision.allowed && ctx.providers.ticket && ticketId) {
      const draft = await ctx.providers.ticket.draftComment(
        ticketId,
        `Oswald delivery update for ${prTitle}. See PR on branch ${branch}.`,
      );
      const res = await ctx.providers.ticket.postComment(draft, {
        yes: true,
        reason: "delivery",
      });
      ticketTaken = res.ok;
      if (!res.ok) warnings.push(`postComment refused: ${res.error}`);
    }
    recordGate("ticket_update", ticketDecision, ticketTaken);

    // create_ticket (follow-up tickets for open questions) — draft only here;
    // we never auto-file follow-ups, even with consent, because there is no
    // create-ticket provider capability. Always recorded as "not taken".
    const createTicketDecision = ctx.approvals.requireApproval(
      "create_ticket",
      { yes: input.yes, policy, reason: "delivery: follow-up tickets" },
    );
    recordGate(
      "create_ticket",
      createTicketDecision,
      false,
    );

    // --- Evidence ledger. -------------------------------------------------
    const evidence: EvidenceItem[] = [];
    evidence.push(
      markEvidence(
        "validation_status",
        valSignal.status,
        valSignal.status === "pass"
          ? "confirmed"
          : valSignal.status === "fail"
            ? "confirmed"
            : "open_question",
        rawValidation ? "validation_report.md" : "—",
      ),
    );
    evidence.push(
      markEvidence(
        "changed_files",
        `${changedFiles.length} (${categorySummaryLine(changedFiles)})`,
        changedFilesSource === "none" ? "open_question" : "confirmed",
        changedFilesSource,
      ),
    );
    evidence.push(
      markEvidence(
        "branch",
        branch,
        input.branch ? "confirmed" : "assumption",
        input.branch ? "input" : "derived",
      ),
    );
    evidence.push(
      markEvidence(
        "base_branch",
        base,
        input.base ? "confirmed" : "assumption",
        input.base ? "input" : "default",
      ),
    );
    for (const m of models) {
      evidence.push(markEvidence("model_touched", m, "inferred", "changed files"));
    }

    // --- Render + persist artifacts. --------------------------------------
    const written: string[] = [];

    const validationEvidenceBody =
      valSignal.evidenceLines.length > 0
        ? ["```", ...valSignal.evidenceLines, "```"].join("\n")
        : rawValidation
          ? "_Validation artifact present but no recognizable check lines were found._"
          : "_No validation artifact found — run the Validate phase before merging._";

    const gatedActionsBody = gatedActions
      .map(
        (g) =>
          `- **${g.action}:** ${g.taken ? "EXECUTED" : "draft only (not taken)"} — ${g.reason}`,
      )
      .join("\n");

    const prSummaryMd = ctx.artifacts.renderMarkdown({
      title: `PR: ${prTitle}`,
      summary:
        valSignal.status === "fail"
          ? "⚠ Validation reported failures — this PR should NOT be merged until resolved."
          : valSignal.status === "unknown"
            ? "Validation status is UNKNOWN — confirm the Validate phase ran before merging."
            : "Validation passed. Ready for human review.",
      sections: [
        {
          heading: "Overview",
          body: [
            `- **Ticket:** ${ticketId ?? "_none_"}`,
            `- **Branch:** \`${branch}\``,
            `- **Base:** \`${base}\``,
            `- **Validation status:** ${valSignal.status}`,
            `- **Injection scan:** ${injectionDetected ? "⚠ patterns detected (neutralized)" : "clean"}`,
          ].join("\n"),
        },
        {
          heading: "Changed Files",
          body: [
            `Summary: ${categorySummaryLine(changedFiles)}`,
            "",
            changedFilesTable(changedFiles),
          ].join("\n"),
        },
        {
          heading: "Models Touched",
          body: bulletList(models, "no dbt models detected in the changeset"),
        },
        { heading: "Validation Evidence", body: validationEvidenceBody },
        {
          heading: "Assumptions",
          body: bulletList(assumptions, "none recorded"),
        },
        {
          heading: "Known Limitations",
          body: bulletList(knownLimitations, "none recorded"),
        },
        {
          heading: "Open Questions",
          body: bulletList(openQuestions, "none outstanding"),
        },
        {
          heading: "Side-effecting Actions (gated)",
          body: gatedActionsBody,
        },
        { heading: "Evidence Ledger", body: renderEvidenceTable(evidence) },
      ],
    });

    const jiraUpdateMd = ctx.artifacts.renderMarkdown({
      title: `Ticket Update: ${ticketId ?? "(no ticket)"}`,
      summary:
        "DRAFT comment for the ticket. Not posted unless explicitly approved.",
      sections: [
        {
          heading: "Proposed Comment",
          body: [
            `Work for **${prTitle}** is ready for review.`,
            "",
            `- Branch: \`${branch}\` → \`${base}\``,
            `- Validation status: ${valSignal.status}`,
            `- Models touched: ${models.length ? models.join(", ") : "n/a"}`,
            "",
            openQuestions.length
              ? `Open questions still needing input:\n${bulletList(openQuestions, "")}`
              : "No open questions outstanding.",
          ].join("\n"),
        },
        {
          heading: "Posting Status",
          body: gatedActions.find((g) => g.action === "ticket_update")?.taken
            ? "Posted to the ticket (explicit approval supplied)."
            : "NOT posted — draft only. Re-run with explicit approval to post.",
        },
      ],
    });

    const releaseNotesMd = ctx.artifacts.renderMarkdown({
      title: `Release Notes: ${prTitle}`,
      summary: "Human-facing summary of what shipped in this changeset.",
      sections: [
        {
          heading: "What Changed",
          body: bulletList(
            models.length
              ? models.map((m) => `Added/updated dbt model \`${m}\``)
              : [`Changeset of ${changedFiles.length} file(s): ${categorySummaryLine(changedFiles)}`],
            "no user-facing changes detected",
          ),
        },
        {
          heading: "Validation",
          body: `Status: **${valSignal.status}**.`,
        },
        {
          heading: "Known Limitations",
          body: bulletList(knownLimitations, "none recorded"),
        },
      ],
    });

    const handoffNotesMd = ctx.artifacts.renderMarkdown({
      title: `Handoff Notes: ${prTitle}`,
      summary:
        "Context for the human reviewer / next engineer picking this up.",
      sections: [
        {
          heading: "State at Handoff",
          body: [
            `- Branch: \`${branch}\` (base \`${base}\`)`,
            `- Validation: ${valSignal.status}`,
            `- Changed files: ${changedFiles.length}`,
            `- Models: ${models.length ? models.join(", ") : "none"}`,
          ].join("\n"),
        },
        {
          heading: "Assumptions To Verify",
          body: bulletList(assumptions, "none recorded"),
        },
        {
          heading: "Open Questions",
          body: bulletList(openQuestions, "none outstanding"),
        },
        {
          heading: "Suggested Next Steps",
          body: numberedList(
            [
              valSignal.status === "pass"
                ? "Review the PR and merge if acceptance criteria are met."
                : "Resolve validation issues before merging.",
              "Confirm the assumptions above with the requester.",
              ...(openQuestions.length
                ? ["Answer the open questions, then re-run delivery."]
                : []),
            ],
            "no further steps",
          ),
        },
      ],
    });

    // Redact PII out of the rendered artifacts before writing.
    for (const [name, md] of [
      [ARTIFACT_NAMES.prSummary, prSummaryMd],
      [ARTIFACT_NAMES.jiraUpdate, jiraUpdateMd],
      [ARTIFACT_NAMES.releaseNotes, releaseNotesMd],
      [ARTIFACT_NAMES.handoffNotes, handoffNotesMd],
    ] as const) {
      const { content } = ctx.policy.sensitive.redactArtifactContent(md);
      const path = await ctx.artifacts.write(name, content);
      written.push(path);
    }

    // --- Decision log: APPEND, never overwrite. ---------------------------
    const stamp = ctx.clock.nowIso();
    const decisionEntryLines = [
      `## ${stamp} — delivery`,
      "",
      `- PR title: ${prTitle}`,
      `- Branch: \`${branch}\` → \`${base}\``,
      `- Validation status: ${valSignal.status}`,
      `- Changed files: ${changedFiles.length} (${categorySummaryLine(changedFiles)})`,
      `- Gated actions: ${gatedActions
        .map((g) => `${g.action}=${g.taken ? "executed" : "draft"}`)
        .join(", ")}`,
      ...(input.decisionNote ? [`- Note: ${input.decisionNote}`] : []),
      "",
    ];
    const { content: decisionEntry } =
      ctx.policy.sensitive.redactArtifactContent(
        decisionEntryLines.join("\n"),
      );
    // Seed a heading if the file does not yet exist.
    if (!(await ctx.artifacts.exists(ARTIFACT_NAMES.decisionLog))) {
      await ctx.artifacts.write(
        ARTIFACT_NAMES.decisionLog,
        "# Decision Log\n\n",
      );
    }
    const decisionPath = await ctx.artifacts.append(
      ARTIFACT_NAMES.decisionLog,
      decisionEntry + "\n",
    );
    written.push(decisionPath);

    // --- Advance workflow state. ------------------------------------------
    // Delivery is the final packaging phase; once its artifacts exist the
    // pipeline is shipped (next_recommended_command becomes null).
    const blockers: string[] =
      valSignal.status === "fail"
        ? ["Validation reported failures — resolve before shipping."]
        : [];
    await advanceWorkflow(ctx, {
      phase: valSignal.status === "fail" ? "blocked" : "shipped",
      lastCommand: "delivery",
      artifacts: {
        pr: ARTIFACT_NAMES.prSummary,
        ticketUpdate: ARTIFACT_NAMES.jiraUpdate,
        ship: ARTIFACT_NAMES.releaseNotes,
        decision_log: ARTIFACT_NAMES.decisionLog,
        handoff_notes: ARTIFACT_NAMES.handoffNotes,
      },
      ...(blockers.length ? { blockers } : {}),
    });

    const output: DeliveryOutput = DeliveryOutputSchema.parse({
      ticketId,
      prTitle,
      branch,
      base,
      changedFileCount: changedFiles.length,
      modelsTouched: models,
      validationStatus: valSignal.status,
      assumptions,
      knownLimitations,
      openQuestions,
      gatedActions,
      injectionDetected,
    });

    ctx.logger.info(
      `delivery: ${prTitle} — validation ${valSignal.status}, ${changedFiles.length} file(s), ${gatedActions.filter((g) => g.taken).length}/${gatedActions.length} gated action(s) executed`,
    );

    return {
      artifactsWritten: written,
      summary: `Delivery package for "${prTitle}" (validation ${valSignal.status}, ${changedFiles.length} changed file(s); side-effecting actions ${input.yes ? "approved" : "draft-only"}).`,
      output,
      ...(openQuestions.length ? { openQuestions } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};

/** Dedupe + drop overly-long noise lines (keeps the artifacts readable). */
function dedupeShort(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s || s.length > 280) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
