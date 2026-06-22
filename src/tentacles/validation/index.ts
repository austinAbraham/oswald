/**
 * Validation & Quality tentacle.
 *
 * Verifies that generated work satisfies the requirements captured at intake.
 * Deterministic MVP:
 *   - Re-reads the acceptance criteria (from `acceptance_criteria.md`, or
 *     supplied inline) and classifies each into a typed expectation
 *     (grain / uniqueness / non-null / accepted-values / freshness / row-count
 *     / build).
 *   - Optionally runs configured validation commands + `dbt parse/build/test`
 *     when a dbt project exists. This external path is GUARDED: it only runs
 *     when an explicit command runner is wired AND `--skip-external` is false.
 *     The library NEVER spawns a process itself.
 *   - Reconciles a candidate row count against a legacy/reference report when
 *     both are available (otherwise defers — never fabricates a pass).
 *   - Produces a fix plan on any failure, and does NOT declare done while
 *     blocking failures remain (advances state to `blocked` in that case).
 *
 * Outputs (under the artifact dir):
 *   - validation_report.md     — verdict, checks, evidence, fix plan
 *   - test_results.md          — per-check pass/fail/skip + command output
 *   - reconciliation_report.md — legacy-vs-candidate comparison
 *   - known_limitations.md     — what was NOT verified and why
 *
 * ALL acceptance-criteria text is UNTRUSTED ticket-derived content: it is wrapped
 * via the sanitizer and treated as data, never instructions. Every unsourced
 * expectation is tagged assumption/open_question via the evidence ledger.
 */
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
  classifyCriteria,
  evaluateExpectationOffline,
  outcomeToCheck,
  parseCommandString,
  dbtCommands,
  mapDbtResultToChecks,
  reconcileRowCount,
  extractRowCount,
  buildFixPlan,
  computeVerdict,
  type Expectation,
  type CheckResult,
  type CommandRunner,
  type CommandSpec,
  type FixPlanItem,
  type Verdict,
} from "./expectations.js";
import { detectDbtProject, runDbt } from "../../tools/dbt/index.js";
import type { DbtRunResult } from "../../tools/dbt/index.js";

export const ARTIFACT_NAMES = {
  report: "validation_report.md",
  tests: "test_results.md",
  reconciliation: "reconciliation_report.md",
  limitations: "known_limitations.md",
} as const;

const ACCEPTANCE_ARTIFACT = "acceptance_criteria.md";

// --- I/O schemas (zod-free lightweight contract via base patterns) ---------
// NOTE: the foundation uses zod elsewhere; we import it here to keep parity
// with the intake reference (schemas separate from artifacts).
import { z } from "zod";

export const ValidationInputSchema = z.object({
  /** Inline acceptance criteria (overrides reading the artifact). */
  acceptanceCriteria: z.array(z.string()).optional(),
  /** Skip ALL external command/dbt execution; stay fully local + deterministic. */
  skipExternal: z.boolean().optional(),
  /** Extra validation command strings to run (e.g. ["pytest -q"]). */
  validationCommands: z.array(z.string()).optional(),
  /** Whether a dbt project is present (enables dbt parse/build/test). */
  dbtProject: z.boolean().optional(),
  /** Explicit dbt project dir (overrides auto-detection from the project root). */
  dbtProjectDir: z.string().optional(),
  /** dbt invocation string (whitespace-split; defaults to config/`dbt`). */
  dbtCommand: z.string().optional(),
  /** dbt target to run build/test against (must look like a sandbox). */
  dbtTarget: z.string().optional(),
  /** Subprocess timeout in ms for the dbt run. */
  dbtTimeoutMs: z.number().optional(),
  /** Known legacy/reference row count for reconciliation. */
  legacyRowCount: z.number().optional(),
  /** Known candidate (new model) row count for reconciliation. */
  candidateRowCount: z.number().optional(),
});
export type ValidationInput = z.infer<typeof ValidationInputSchema>;

export const ValidationOutputSchema = z.object({
  done: z.boolean(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  blockers: z.array(z.string()),
  expectations: z.array(
    z.object({ kind: z.string(), source: z.string() }),
  ),
  fixPlan: z.array(z.object({ check: z.string(), action: z.string() })),
  injectionDetected: z.boolean(),
});
export type ValidationOutput = z.infer<typeof ValidationOutputSchema>;

// --- acceptance-criteria recovery ------------------------------------------

/**
 * Recover acceptance-criteria lines from the rendered `acceptance_criteria.md`.
 * Intake renders them as a numbered list under "## Acceptance Criteria"; we
 * read that block back deterministically. Returns [] when none are present.
 */
export function parseAcceptanceArtifact(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{2,6}\s+(.*)$/);
    if (heading) {
      inSection = /acceptance criteria/i.test(heading[1]!);
      continue;
    }
    if (!inSection || !line) continue;
    // numbered ("1. x"), bulleted ("- x"), or checkbox ("- [ ] x")
    const m =
      line.match(/^\d+[.)]\s+(.*)$/) ||
      line.match(/^[-*+]\s+(?:\[[ xX]?\]\s+)?(.*)$/);
    if (m) {
      const text = m[1]!.trim();
      // skip the "none found" placeholder line.
      if (text && !/^_?none found/i.test(text)) out.push(text);
    }
  }
  return out;
}

// --- rendering helpers ------------------------------------------------------

function statusIcon(s: CheckResult["status"]): string {
  return s === "passed" ? "✓" : s === "failed" ? "✗" : "○";
}

function renderCheckTable(checks: CheckResult[]): string {
  if (checks.length === 0) return "_No checks evaluated._";
  const rows = checks.map(
    (c) =>
      `| ${statusIcon(c.status)} ${c.status} | \`${c.kind}\` | ${escape(
        c.name,
      )} | ${c.blocking ? "yes" : "no"} | ${escape(c.detail)} |`,
  );
  return [
    "| Status | Kind | Check | Blocking | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderFixPlan(plan: FixPlanItem[]): string {
  if (plan.length === 0) return "_No fixes required — all checks satisfied._";
  return plan.map((p, i) => `${i + 1}. **${escape(p.check)}** → ${escape(p.action)}`).join("\n");
}

function escape(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Render a real dbt run into a fenced report block (nodes + tests summary). */
function renderDbtRun(run: DbtRunResult): string {
  const head =
    `### dbt ${run.command}` +
    (run.skipped
      ? " — skipped"
      : run.ok
        ? " — ok"
        : ` — FAILED${run.reason ? ` (${run.reason})` : ""}`);
  if (run.skipped) {
    return [head, "```", run.reason ?? "skipped (offline)", "```"].join("\n");
  }
  const nodeLines = run.nodes.map(
    (n) => `${n.status === "fail" || n.status === "error" ? "✗" : "✓"} ${n.resourceType} ${n.name}${n.message ? ` — ${n.message}` : ""}`,
  );
  const testLines = run.tests.map(
    (t) => `${t.status === "pass" || t.status === "success" ? "✓" : "✗"} [${t.kind}] ${t.name}${t.message ? ` — ${t.message}` : ""}`,
  );
  return [
    head,
    "```",
    `exit ${run.exitCode ?? "n/a"}`,
    `nodes (${run.nodes.length}):`,
    ...(nodeLines.length ? nodeLines : ["  (none)"]),
    `tests (${run.tests.length}):`,
    ...(testLines.length ? testLines : ["  (none)"]),
    ...(run.failed.length ? [`failed: ${run.failed.join(", ")}`] : []),
    "```",
  ].join("\n");
}

// --- the tentacle ----------------------------------------------------------

export const validationTentacle: Tentacle<
  typeof ValidationInputSchema,
  typeof ValidationOutputSchema
> = {
  id: "validate",
  title: "Validation & Quality",
  description:
    "Verify generated work satisfies requirements: classify acceptance criteria into deterministic checks, optionally run configured validation + dbt build/test (guarded), reconcile against a legacy report, and produce a fix plan — never declaring done while blocking failures remain.",

  inputSchema: ValidationInputSchema,
  outputSchema: ValidationOutputSchema,

  requiredTools: [],
  optionalTools: ["warehouse.executeReadOnlySql", "warehouse.describeTable"],

  checklist: [
    "Acceptance criteria recovered (artifact or inline)",
    "Each criterion classified into a deterministic expectation",
    "Build/test run (or explicitly deferred via --skip-external)",
    "Configured validation commands run (or deferred)",
    "Row count reconciled against legacy report (or deferred)",
    "Fix plan generated for every failing/skipped check",
    "Blocking failures gate 'done' (state → blocked)",
    "Unverified checks recorded as known limitations, never silently passed",
    "All acceptance-criteria text wrapped and injection-scanned",
    "Every unsourced expectation tagged assumption/open_question",
  ],

  async run(ctx: TentacleContext): Promise<TentacleResult<ValidationOutput>> {
    const input = ValidationInputSchema.parse({
      acceptanceCriteria: ctx.options.acceptanceCriteria as
        | string[]
        | undefined,
      skipExternal: ctx.options.skipExternal as boolean | undefined,
      validationCommands: ctx.options.validationCommands as
        | string[]
        | undefined,
      dbtProject: ctx.options.dbtProject as boolean | undefined,
      dbtProjectDir: ctx.options.dbtProjectDir as string | undefined,
      dbtCommand: ctx.options.dbtCommand as string | undefined,
      dbtTarget: ctx.options.dbtTarget as string | undefined,
      dbtTimeoutMs: ctx.options.dbtTimeoutMs as number | undefined,
      legacyRowCount: ctx.options.legacyRowCount as number | undefined,
      candidateRowCount: ctx.options.candidateRowCount as number | undefined,
    });

    const warnings: string[] = [];

    // --- 1. Recover acceptance criteria. ----------------------------------
    let criteria: string[] = input.acceptanceCriteria ?? [];
    let criteriaSource = "inline options";
    if (criteria.length === 0) {
      if (await ctx.artifacts.exists(ACCEPTANCE_ARTIFACT)) {
        const md = await ctx.artifacts.read(ACCEPTANCE_ARTIFACT);
        criteria = parseAcceptanceArtifact(md);
        criteriaSource = ACCEPTANCE_ARTIFACT;
      } else {
        warnings.push(
          `No ${ACCEPTANCE_ARTIFACT} artifact and no inline criteria; validation has nothing to check — run intake first.`,
        );
        criteriaSource = "none";
      }
    }

    // --- Trust boundary: wrap each (untrusted) criterion. -----------------
    let injectionDetected = false;
    const safeCriteria: string[] = [];
    for (const c of criteria) {
      const wrap = ctx.policy.sanitizer.wrap(c, criteriaSource);
      if (wrap.report.detected) injectionDetected = true;
      // Classify the NEUTRALIZED text as data.
      safeCriteria.push(wrap.neutralized);
    }
    if (injectionDetected) {
      warnings.push(
        "Prompt-injection patterns detected in acceptance-criteria text; neutralized and flagged — treated as data only.",
      );
    }

    const expectations: Expectation[] = classifyCriteria(safeCriteria);

    // --- 2. Decide what runs externally vs offline. -----------------------
    const skipExternal = input.skipExternal ?? true; // default: stay local.
    const runner = ctx.options.commandRunner as CommandRunner | undefined;

    // Locate the dbt project: explicit dir > config dir > walk up from root.
    // Detection is the trigger for the REAL build/test path. We only auto-detect
    // when not staying local (no spawn at all when --skip-external).
    let dbtProjectDir: string | null = null;
    if (!skipExternal) {
      const explicit =
        input.dbtProjectDir ?? ctx.config.dbt?.project_dir ?? undefined;
      if (explicit) {
        dbtProjectDir = await detectDbtProject(explicit);
        if (!dbtProjectDir) {
          warnings.push(
            `Configured dbt project dir '${explicit}' has no dbt_project.yml; skipping the dbt build/test path.`,
          );
        }
      } else {
        dbtProjectDir = await detectDbtProject(ctx.artifacts.root);
      }
    }
    const willRunDbt = !skipExternal && dbtProjectDir !== null;
    const willRunCommands = !skipExternal && Boolean(runner);
    const willRunExternal = willRunDbt || willRunCommands;

    // Offline (MVP default): data-shape checks are deferred (skipped, never
    // fabricated). When external execution WILL run, the dbt build/test results
    // supply the real `build` + data-shape verdicts and the reconciliation step
    // covers `row_count`, so we don't also emit redundant deferred placeholders
    // for those (the real check replaces the offline stub).
    const dbtCovers = (k: Expectation["kind"]): boolean =>
      k === "build" ||
      k === "row_count" ||
      (willRunDbt &&
        (k === "uniqueness" ||
          k === "non_null" ||
          k === "accepted_values" ||
          k === "freshness"));
    const checks: CheckResult[] = expectations
      .filter((e) => !(willRunExternal && dbtCovers(e.kind)))
      .map(evaluateExpectationOffline);

    // --- 3. External execution (GUARDED). ---------------------------------
    const commandOutput: string[] = [];
    const dbtRuns: DbtRunResult[] = [];

    if (skipExternal) {
      warnings.push(
        "--skip-external set (default): build/test and validation commands were NOT run; their checks are deferred.",
      );
    } else if (!willRunExternal) {
      warnings.push(
        "External execution requested but no dbt project was detected and no command runner is wired; nothing external ran. Checks are deferred.",
      );
    }

    // 3a. The REAL dbt path: `dbt build` then `dbt test` via the guarded runner.
    if (willRunDbt && dbtProjectDir) {
      const dbtInvocation = input.dbtCommand ?? ctx.config.dbt?.command;
      const dbtTarget = input.dbtTarget ?? ctx.config.dbt?.target ?? "sandbox";
      const timeoutMs = input.dbtTimeoutMs ?? ctx.config.dbt?.timeout_ms;
      const baseOpts = {
        projectDir: dbtProjectDir,
        target: dbtTarget,
        ...(dbtInvocation ? { dbtCommand: dbtInvocation } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      };

      // `build` runs seeds + models + tests in dependency order, so it both
      // builds cleanly AND exercises every data test in one pass. We then run
      // `test` to capture an isolated test verdict in the report.
      const buildResult = await runDbt("build", baseOpts);
      dbtRuns.push(buildResult);
      for (const c of mapDbtResultToChecks(buildResult)) checks.push(c);

      // Only run an explicit `test` pass when the build itself succeeded; a
      // failed build already blocks and re-running tests adds noise.
      if (buildResult.ok && !buildResult.skipped) {
        const testResult = await runDbt("test", baseOpts);
        dbtRuns.push(testResult);
        // The build pass already produced the per-test checks; the test pass is
        // a confirmation. Only surface NEW failures it uncovers (defensive).
        if (!testResult.ok) {
          checks.push({
            name: "dbt test (isolated test pass)",
            kind: "build",
            status: "failed",
            detail:
              testResult.reason ??
              `dbt test reported failures: ${testResult.failed.join(", ") || "(unknown)"}.`,
            blocking: true,
          });
        }
      }
    }

    // 3b. Arbitrary injected validation commands (pytest, etc.).
    if (willRunCommands && runner) {
      const specs: CommandSpec[] = [];
      for (const raw of input.validationCommands ?? []) {
        const spec = parseCommandString(`cmd: ${raw}`, raw);
        if (spec) specs.push(spec);
      }
      // When NO real dbt project drove the run but a runner exists and a dbt
      // project was flagged, fall back to runner-based dbt commands (legacy).
      if (input.dbtProject && !willRunDbt) specs.push(...dbtCommands());

      for (const spec of specs) {
        const outcome = await runner(spec);
        checks.push(outcomeToCheck(outcome));
        commandOutput.push(
          [
            `### ${spec.name}`,
            "```",
            `$ ${[outcome.command, ...spec.args].join(" ")}`,
            `exit ${outcome.exitCode}${outcome.errored ? " (spawn error)" : ""}`,
            outcome.stdout.trim(),
            outcome.stderr.trim(),
            "```",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }

    // Render the real dbt runs into the command-output block for the report.
    for (const run of dbtRuns) {
      commandOutput.push(renderDbtRun(run));
    }

    // --- 4. Reconciliation against the legacy report. ---------------------
    // Prefer inline counts; otherwise try to recover them from a prior
    // reconciliation artifact (degrade gracefully).
    let legacyRowCount = input.legacyRowCount;
    const candidateRowCount = input.candidateRowCount;
    if (
      (legacyRowCount === undefined || candidateRowCount === undefined) &&
      (await ctx.artifacts.exists(ARTIFACT_NAMES.reconciliation))
    ) {
      try {
        const prior = await ctx.artifacts.read(ARTIFACT_NAMES.reconciliation);
        const recovered = extractRowCount(prior);
        if (recovered !== null && legacyRowCount === undefined) {
          legacyRowCount = recovered;
        }
      } catch {
        /* ignore — best-effort */
      }
    }
    // Tolerance: from a row_count expectation if one declared a percentage.
    const tolExp = expectations.find(
      (e) => e.kind === "row_count" && e.detail.tolerancePct,
    );
    const tolerancePct = tolExp ? Number(tolExp.detail.tolerancePct) : 0;
    const reconciliation = reconcileRowCount({
      legacyRowCount,
      candidateRowCount,
      tolerancePct,
    });
    checks.push({
      name: "Row-count reconciliation vs legacy",
      kind: "reconciliation",
      status: reconciliation.status,
      detail: reconciliation.detail,
      // A real mismatch blocks; a deferred reconciliation does not.
      blocking: reconciliation.status === "failed",
    });

    // --- 5. Verdict + fix plan. -------------------------------------------
    const verdict: Verdict = computeVerdict(checks);
    const fixPlan = buildFixPlan(checks);

    // --- 6. Evidence ledger. ----------------------------------------------
    const evidence: EvidenceItem[] = [];
    evidence.push(
      markEvidence(
        "acceptance_criteria_source",
        criteriaSource,
        criteriaSource === "none" ? "open_question" : "confirmed",
        criteriaSource,
      ),
    );
    for (const e of expectations) {
      evidence.push(
        markEvidence(
          `expectation:${e.kind}`,
          e.source,
          e.kind === "other" ? "open_question" : "inferred",
          criteriaSource,
        ),
      );
    }
    evidence.push(
      markEvidence(
        "external_execution",
        skipExternal
          ? "skipped (--skip-external)"
          : willRunDbt
            ? `dbt build/test ran (${dbtProjectDir})`
            : willRunCommands
              ? "command runner ran"
              : "nothing ran (no dbt project / runner)",
        skipExternal || !willRunExternal ? "assumption" : "confirmed",
        "config/options",
      ),
    );
    evidence.push(
      markEvidence(
        "reconciliation",
        reconciliation.detail,
        reconciliation.status === "skipped" ? "open_question" : "inferred",
        reconciliation.status === "skipped" ? "—" : "row counts",
      ),
    );

    // --- 7. Open questions (gating clarity). ------------------------------
    const openQuestions: string[] = [];
    if (criteriaSource === "none") {
      openQuestions.push(
        "No acceptance criteria available to validate against — define them (intake) before claiming completion.",
      );
    }
    for (const e of expectations) {
      if (e.kind === "other") {
        openQuestions.push(
          `Acceptance criterion not auto-classifiable: "${e.source}" — map it to a concrete check.`,
        );
      }
    }
    if (reconciliation.status === "skipped" && criteria.length > 0) {
      openQuestions.push(
        "Row-count reconciliation could not run (missing legacy and/or candidate count) — provide both to confirm parity.",
      );
    }

    // --- 8. Render + persist artifacts (redacting PII). -------------------
    const written: string[] = [];

    const verdictLine = verdict.done
      ? "✅ PASS — no blocking failures."
      : `⛔ BLOCKED — ${verdict.blockers.length} blocking failure(s) remain.`;

    const reportMd = ctx.artifacts.renderMarkdown({
      title: "Validation Report",
      summary: `${verdictLine}  (${verdict.passed} passed · ${verdict.failed} failed · ${verdict.skipped} skipped)`,
      sections: [
        {
          heading: "Verdict",
          body: [
            `- **Done:** ${verdict.done ? "yes" : "no"}`,
            `- **Passed:** ${verdict.passed}`,
            `- **Failed:** ${verdict.failed}`,
            `- **Skipped (deferred):** ${verdict.skipped}`,
            `- **Acceptance criteria source:** ${criteriaSource}`,
            `- **Injection scan:** ${injectionDetected ? "⚠ patterns detected (neutralized)" : "clean"}`,
          ].join("\n"),
        },
        ...(verdict.blockers.length
          ? [
              {
                heading: "Blocking Failures",
                body: verdict.blockers.map((b) => `- ${b}`).join("\n"),
              },
            ]
          : []),
        { heading: "Checks", body: renderCheckTable(checks) },
        { heading: "Fix Plan", body: renderFixPlan(fixPlan) },
        { heading: "Evidence Ledger", body: renderEvidenceTable(evidence) },
      ],
    });

    const testsMd = ctx.artifacts.renderMarkdown({
      title: "Test Results",
      summary: `Per-check outcomes for the validation run (${checks.length} check(s)).`,
      sections: [
        { heading: "Results", body: renderCheckTable(checks) },
        {
          heading: "Command Output",
          body:
            commandOutput.length > 0
              ? commandOutput.join("\n\n")
              : skipExternal
                ? "_External execution skipped (--skip-external). No commands were run._"
                : "_No external commands were run._",
        },
      ],
    });

    const reconMd = ctx.artifacts.renderMarkdown({
      title: "Reconciliation Report",
      summary:
        reconciliation.status === "skipped"
          ? "Reconciliation deferred — legacy and/or candidate row count unavailable."
          : `Reconciliation ${reconciliation.status}.`,
      sections: [
        {
          heading: "Row Count",
          body: [
            `- **Legacy / reference:** ${legacyRowCount ?? "_unknown_"}`,
            `- **Candidate (new model):** ${candidateRowCount ?? "_unknown_"}`,
            `- **Tolerance:** ±${tolerancePct}%`,
            `- **Result:** ${reconciliation.status}${
              reconciliation.deviationPct !== undefined
                ? ` (${reconciliation.deviationPct}% deviation)`
                : ""
            }`,
          ].join("\n"),
        },
        { heading: "Detail", body: reconciliation.detail },
      ],
    });

    const skippedChecks = checks.filter((c) => c.status === "skipped");
    const limitationsMd = ctx.artifacts.renderMarkdown({
      title: "Known Limitations",
      summary:
        skippedChecks.length > 0
          ? `${skippedChecks.length} check(s) could not be evaluated in this run and are NOT claimed as passing.`
          : "All checks were evaluated; no deferred limitations from this run.",
      sections: [
        {
          heading: "Not Verified",
          body:
            skippedChecks.length > 0
              ? skippedChecks
                  .map((c) => `- **${escape(c.name)}** (\`${c.kind}\`): ${escape(c.detail)}`)
                  .join("\n")
              : "_None._",
        },
        {
          heading: "Open Questions",
          body:
            openQuestions.length > 0
              ? openQuestions.map((q) => `- ${q}`).join("\n")
              : "_None._",
        },
        {
          heading: "Note",
          body:
            "Deferred checks are NOT failures, but they are also NOT passes. Re-run validation without `--skip-external` against the built model to convert them into real results.",
        },
      ],
    });

    for (const [name, md] of [
      [ARTIFACT_NAMES.report, reportMd],
      [ARTIFACT_NAMES.tests, testsMd],
      [ARTIFACT_NAMES.reconciliation, reconMd],
      [ARTIFACT_NAMES.limitations, limitationsMd],
    ] as const) {
      const { content } = ctx.policy.sensitive.redactArtifactContent(md);
      const path = await ctx.artifacts.write(name, content);
      written.push(path);
    }

    // --- 9. Advance workflow state. ---------------------------------------
    // Done → next pending phase is `ready_for_pr` (recommends `pr`).
    // Not done → park in `blocked` with the blocking failures recorded.
    if (verdict.done) {
      await advanceWorkflow(ctx, {
        phase: "ready_for_pr",
        lastCommand: "validate",
        artifacts: {
          validation: ARTIFACT_NAMES.report,
          test_results: ARTIFACT_NAMES.tests,
          reconciliation_report: ARTIFACT_NAMES.reconciliation,
          known_limitations: ARTIFACT_NAMES.limitations,
        },
        blockers: [],
      });
    } else {
      await advanceWorkflow(ctx, {
        phase: "blocked",
        lastCommand: "validate",
        artifacts: {
          validation: ARTIFACT_NAMES.report,
          test_results: ARTIFACT_NAMES.tests,
          reconciliation_report: ARTIFACT_NAMES.reconciliation,
          known_limitations: ARTIFACT_NAMES.limitations,
        },
        blockers: verdict.blockers,
      });
    }

    const output: ValidationOutput = ValidationOutputSchema.parse({
      done: verdict.done,
      passed: verdict.passed,
      failed: verdict.failed,
      skipped: verdict.skipped,
      blockers: verdict.blockers,
      expectations: expectations.map((e) => ({ kind: e.kind, source: e.source })),
      fixPlan,
      injectionDetected,
    });

    ctx.logger.info(
      `validate: ${verdict.done ? "PASS" : "BLOCKED"} — ${verdict.passed} passed, ${verdict.failed} failed, ${verdict.skipped} skipped`,
    );

    return {
      artifactsWritten: written,
      summary: `Validation ${verdict.done ? "passed" : "BLOCKED"} (${verdict.passed} passed · ${verdict.failed} failed · ${verdict.skipped} skipped).`,
      output,
      ...(openQuestions.length ? { openQuestions } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};
