/**
 * Deterministic validation primitives.
 *
 * Pure functions (no LLM, no network, no I/O except the explicitly-injected
 * command runner) that turn acceptance-criteria text into typed, checkable
 * expectations, evaluate them against available evidence, reconcile against a
 * legacy report, and assemble a fix plan. Everything here is unit-testable in
 * isolation; the tentacle (`index.ts`) wires these to the artifact/provider I/O.
 *
 * IMPORTANT: acceptance-criteria text originates from a ticket and is therefore
 * UNTRUSTED. This module only *reads its structure* as data; it never executes
 * or obeys it. Instruction-neutralization happens in the sanitizer before the
 * text reaches here.
 */

// ---------------------------------------------------------------------------
// Expectation taxonomy
// ---------------------------------------------------------------------------

/** The kinds of deterministic check Oswald knows how to reason about. */
export const EXPECTATION_KINDS = [
  "grain", // one row per <dimensions>
  "uniqueness", // a key/column is unique
  "non_null", // a column is never null
  "accepted_values", // a column is in an enumerated set
  "freshness", // data is recent / refreshed within a window
  "row_count", // row count matches / within tolerance of a reference
  "build", // model compiles / builds cleanly
  "other", // recognized as a criterion but not auto-classifiable
] as const;

export type ExpectationKind = (typeof EXPECTATION_KINDS)[number];

export interface Expectation {
  /** The raw acceptance-criterion text it was derived from. */
  source: string;
  kind: ExpectationKind;
  /** Best-effort structured detail (column, dimensions, tolerance, ...). */
  detail: Record<string, string>;
}

/**
 * Classify a single acceptance-criterion line into a typed expectation.
 * Pure heuristic keyword/grammar matching — deterministic and order-stable.
 */
export function classifyCriterion(raw: string): Expectation {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const detail: Record<string, string> = {};

  // grain: "one row per X (per Y)" / "grain: ..."
  const grainMatch =
    lower.match(/\bgrain\s*[:=]\s*(.+)$/) ||
    lower.match(/\bone row per\s+(.+)$/);
  if (grainMatch) {
    detail.dimensions = grainMatch[1]!.trim();
    return { source: text, kind: "grain", detail };
  }

  // uniqueness: "X is unique" / "unique <key>" / "no duplicate ..."
  if (/\bunique\b/.test(lower) || /\bno duplicate/.test(lower)) {
    const col = lower.match(/\b([a-z0-9_]+)\s+(?:is|are|must be)\s+unique\b/);
    if (col) detail.column = col[1]!;
    return { source: text, kind: "uniqueness", detail };
  }

  // non-null: "X is not null" / "no nulls in X" / "every row has ..."
  if (
    /\bnot null\b/.test(lower) ||
    /\bnon[- ]?null\b/.test(lower) ||
    /\bno null/.test(lower) ||
    /\bnever (?:be )?null\b/.test(lower)
  ) {
    const col =
      lower.match(/\b([a-z0-9_]+)\s+(?:is|are|must be|cannot be|should not be)\s+(?:not |non[- ]?)null/) ||
      lower.match(/\bno nulls? in\s+([a-z0-9_]+)/);
    if (col) detail.column = col[1]!;
    return { source: text, kind: "non_null", detail };
  }

  // accepted values: "X in (a, b, c)" / "X is one of a, b" / "accepted values: ..."
  // To avoid matching prose like "builds in the sandbox", the value list must be
  // either parenthesized OR an explicit comma-separated enumeration.
  const parenCol = lower.match(
    /\b([a-z0-9_]+)\s+(?:in|is one of|must be one of|one of)\s*\(([^)]+)\)/,
  );
  const listCol = lower.match(
    /\b([a-z0-9_]+)\s+(?:in|is one of|must be one of|one of)\s+([a-z0-9_]+(?:\s*,\s*[a-z0-9_]+)+)/,
  );
  const acceptedKeyword = /(accepted|allowed)\s+values/.test(lower)
    ? lower.match(/values?\s*[:=]?\s*\(?([^)]+)\)?/)
    : null;
  if (parenCol) {
    detail.column = parenCol[1]!;
    detail.values = parenCol[2]!.trim();
    return { source: text, kind: "accepted_values", detail };
  }
  if (listCol) {
    detail.column = listCol[1]!;
    detail.values = listCol[2]!.trim();
    return { source: text, kind: "accepted_values", detail };
  }
  if (acceptedKeyword && acceptedKeyword[1]) {
    detail.values = acceptedKeyword[1]!.trim();
    return { source: text, kind: "accepted_values", detail };
  }

  // freshness: "fresh", "updated daily", "within N hours/days", "no later than"
  if (
    /\bfresh\b/.test(lower) ||
    /\bup[- ]?to[- ]?date\b/.test(lower) ||
    /\b(?:updated|refreshed)\b/.test(lower) ||
    /\bwithin\s+\d+\s+(?:hour|day|minute)/.test(lower)
  ) {
    const win = lower.match(/within\s+(\d+\s+(?:hour|day|minute)s?)/);
    if (win) detail.window = win[1]!;
    return { source: text, kind: "freshness", detail };
  }

  // row count: "row count matches", "within N%", "count equals", "rows = N"
  if (
    /\brow ?count/.test(lower) ||
    /\bnumber of rows/.test(lower) ||
    /\bcount (?:matches|equals|=)/.test(lower) ||
    /\bmatches the (?:legacy|existing|old|prior) (?:report|table|model)/.test(lower)
  ) {
    const tol = lower.match(/within\s+(\d+(?:\.\d+)?)\s*%/);
    if (tol) detail.tolerancePct = tol[1]!;
    if (/\b(?:legacy|existing|old|prior)\b/.test(lower)) {
      detail.reference = "legacy";
    }
    return { source: text, kind: "row_count", detail };
  }

  // build: "builds cleanly", "compiles", "dbt build/run/test passes"
  if (
    /\bbuilds?\b/.test(lower) ||
    /\bcompiles?\b/.test(lower) ||
    /\bdbt (?:build|run|test|compile|parse)\b/.test(lower) ||
    /\btests? pass/.test(lower)
  ) {
    return { source: text, kind: "build", detail };
  }

  return { source: text, kind: "other", detail };
}

/** Classify a list of acceptance criteria, preserving order. */
export function classifyCriteria(criteria: string[]): Expectation[] {
  return criteria.map(classifyCriterion);
}

// ---------------------------------------------------------------------------
// Check evaluation
// ---------------------------------------------------------------------------

export type CheckStatus = "passed" | "failed" | "skipped";

export interface CheckResult {
  /** What the check derives from (criterion text or command name). */
  name: string;
  kind: ExpectationKind | "command" | "dbt" | "reconciliation";
  status: CheckStatus;
  /** Human-readable detail / reason. */
  detail: string;
  /**
   * Whether a failure here BLOCKS declaring the work done. Skipped checks are
   * never blocking; only `failed` + `blocking` gates the pipeline.
   */
  blocking: boolean;
}

/**
 * Without a live warehouse + built model, deterministic data-expectation checks
 * cannot truly run; the MVP records them as `skipped` (not silently passed) and
 * carries them forward as known limitations + fix-plan items. This keeps the
 * library honest: we never claim a green check we did not actually evaluate.
 */
export function evaluateExpectationOffline(exp: Expectation): CheckResult {
  // `build` expectations can only be confirmed by the external command runner.
  // Everything else is a data-shape assertion needing a warehouse round-trip.
  const blocking = exp.kind === "build" || exp.kind === "row_count";
  return {
    name: exp.source,
    kind: exp.kind,
    status: "skipped",
    detail:
      exp.kind === "other"
        ? "Criterion not auto-classifiable into a deterministic check; needs human/EDA mapping."
        : `Requires ${
            exp.kind === "build" ? "a build/test run" : "a warehouse query against the built model"
          } to evaluate; deferred (run without --skip-external once the model is built).`,
    blocking,
  };
}

// ---------------------------------------------------------------------------
// External command runner (injected — never spawns by default)
// ---------------------------------------------------------------------------

export interface CommandSpec {
  /** Display name for the report. */
  name: string;
  /** The command + args (already split). */
  command: string;
  args: string[];
}

export interface CommandOutcome {
  name: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if the command could not be spawned at all. */
  errored: boolean;
}

/**
 * A function that actually runs a command. Injected so the tentacle stays pure
 * and tests can supply a deterministic stub. In production the CLI wires a real
 * child-process runner; the library NEVER spawns a process on its own.
 */
export type CommandRunner = (spec: CommandSpec) => Promise<CommandOutcome>;

/** Map a raw command outcome to a check result. */
export function outcomeToCheck(outcome: CommandOutcome): CheckResult {
  const passed = !outcome.errored && outcome.exitCode === 0;
  return {
    name: outcome.name,
    kind: outcome.command.includes("dbt") ? "dbt" : "command",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `Exited 0.`
      : outcome.errored
        ? `Failed to run: ${outcome.stderr || "spawn error"}.`
        : `Exited ${outcome.exitCode}: ${truncate(outcome.stderr || outcome.stdout, 300)}`,
    // A failing validation command blocks "done".
    blocking: !passed,
  };
}

/**
 * Parse a config-supplied validation command string into a CommandSpec.
 * Whitespace-split is intentional (deterministic, no shell interpolation, no
 * injection surface — we never pass through a shell).
 */
export function parseCommandString(name: string, raw: string): CommandSpec | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { name, command: parts[0]!, args: parts.slice(1) };
}

/** Standard dbt validation commands, in pipeline order. */
export function dbtCommands(): CommandSpec[] {
  return [
    { name: "dbt parse", command: "dbt", args: ["parse"] },
    { name: "dbt build", command: "dbt", args: ["build"] },
    { name: "dbt test", command: "dbt", args: ["test"] },
  ];
}

// ---------------------------------------------------------------------------
// dbt runner → CheckResult mapping (the REAL build/test path)
// ---------------------------------------------------------------------------

/**
 * The subset of a {@link DbtRunResult} this mapper reasons over. Declared
 * structurally (not imported) so this module stays free of a dependency on the
 * dbt tools layer and remains trivially unit-testable against plain objects.
 */
export interface DbtResultLike {
  ok: boolean;
  command: "parse" | "seed" | "build" | "test";
  skipped: boolean;
  reason?: string | undefined;
  exitCode?: number | null;
  nodes: Array<{
    name: string;
    resourceType: string;
    status: string;
    message?: string | undefined;
  }>;
  tests: Array<{
    name: string;
    status: string;
    kind: string;
    column?: string | undefined;
    message?: string | undefined;
  }>;
  failed: string[];
}

/** A dbt logical-check kind → the validation expectation kind it satisfies. */
const DBT_KIND_TO_EXPECTATION: Record<string, ExpectationKind> = {
  unique: "uniqueness",
  not_null: "non_null",
  accepted_values: "accepted_values",
  freshness: "freshness",
  relationships: "other",
  row_count: "row_count",
  other: "other",
};

function isPassStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "pass" || s === "success";
}

function isFailStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "fail" || s === "error" || s.includes("fail") || s.includes("error");
}

/**
 * Map a real dbt `build`/`test`/`parse` run into concrete {@link CheckResult}s.
 *
 * This is the heart of "real verdicts": a clean build/test produces PASSED
 * checks for "builds cleanly into sandbox", per-model materialization, and each
 * logical data test (uniqueness / not-null / accepted-values / ...). A failed
 * build or any failed/errored node/test produces a BLOCKING failed check, so the
 * verdict can never silently ship a real dbt failure.
 *
 * A `skipped` result (offline / policy-blocked) yields a single non-blocking
 * skipped check — the deterministic offline posture is preserved.
 */
export function mapDbtResultToChecks(result: DbtResultLike): CheckResult[] {
  const checks: CheckResult[] = [];
  const label = `dbt ${result.command}`;

  // --- Skipped (offline / policy guard): defer, never fabricate. ----------
  if (result.skipped) {
    checks.push({
      name: `${label} (build cleanly into sandbox)`,
      kind: "build",
      status: "skipped",
      detail:
        result.reason ??
        "dbt run was skipped; build/test checks deferred (run without --skip-external against a sandbox).",
      // A deferred build check is blocking — we never declare done on an
      // unverified must-pass criterion (matches the offline posture).
      blocking: true,
    });
    return checks;
  }

  // --- The overall build/parse verdict (the "builds cleanly" criterion). --
  if (result.command === "parse") {
    checks.push({
      name: "dbt parse (project compiles)",
      kind: "build",
      status: result.ok ? "passed" : "failed",
      detail: result.ok
        ? "dbt parse succeeded — the project + generated SQL compile cleanly."
        : result.reason ?? "dbt parse failed; the project/SQL does not compile.",
      blocking: !result.ok,
    });
    return checks;
  }

  // build / test / seed
  const buildPassed =
    result.ok && !result.nodes.some((n) => isFailStatus(n.status));
  checks.push({
    name: "Builds cleanly into the sandbox",
    kind: "build",
    status: buildPassed ? "passed" : "failed",
    detail: buildPassed
      ? `dbt ${result.command} completed with no failed/errored nodes (${result.nodes.length} node(s)).`
      : result.reason ??
        `dbt ${result.command} reported failed/errored node(s): ${result.failed.join(", ") || "(unknown)"}.`,
    blocking: !buildPassed,
  });

  // --- Per-data-test logical checks (uniqueness / not-null / ...). --------
  for (const t of result.tests) {
    const expectationKind = DBT_KIND_TO_EXPECTATION[t.kind] ?? "other";
    const passed = isPassStatus(t.status);
    const failed = isFailStatus(t.status);
    const status: CheckStatus = passed ? "passed" : failed ? "failed" : "skipped";
    const col = t.column ? ` (\`${t.column}\`)` : "";
    checks.push({
      name: `${t.name}${col}`,
      kind: expectationKind,
      status,
      detail: passed
        ? `dbt ${t.kind} test passed.`
        : failed
          ? `dbt ${t.kind} test FAILED${t.message ? `: ${t.message}` : ""}.`
          : `dbt ${t.kind} test status '${t.status}' — not a clear pass; treated as unverified.`,
      // A failed data test blocks; a passed/skipped one does not.
      blocking: status === "failed",
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Reconciliation against a legacy / reference report
// ---------------------------------------------------------------------------

export interface ReconciliationInput {
  /** Reference (legacy) row count, if known. */
  legacyRowCount?: number | undefined;
  /** Candidate (new model) row count, if known. */
  candidateRowCount?: number | undefined;
  /** Allowed deviation as a percentage (e.g. 1 = ±1%). Defaults to 0. */
  tolerancePct?: number | undefined;
}

export interface ReconciliationResult {
  status: CheckStatus;
  detail: string;
  /** Absolute % difference between candidate and legacy, when computable. */
  deviationPct?: number;
}

/**
 * Deterministically reconcile a candidate row count against a legacy reference
 * within a tolerance. If either side is unknown, the result is `skipped` (we
 * never fabricate a pass) and surfaced as a known limitation.
 */
export function reconcileRowCount(
  input: ReconciliationInput,
): ReconciliationResult {
  const { legacyRowCount, candidateRowCount } = input;
  const tolerancePct = input.tolerancePct ?? 0;
  if (legacyRowCount === undefined || candidateRowCount === undefined) {
    return {
      status: "skipped",
      detail:
        "No legacy reference and/or candidate row count available; reconciliation deferred until both are measured.",
    };
  }
  if (legacyRowCount === 0) {
    return {
      status: candidateRowCount === 0 ? "passed" : "failed",
      detail: `Legacy count is 0; candidate is ${candidateRowCount}.`,
      deviationPct: candidateRowCount === 0 ? 0 : 100,
    };
  }
  const deviationPct =
    (Math.abs(candidateRowCount - legacyRowCount) / Math.abs(legacyRowCount)) *
    100;
  const rounded = Math.round(deviationPct * 1000) / 1000;
  const passed = rounded <= tolerancePct;
  return {
    status: passed ? "passed" : "failed",
    deviationPct: rounded,
    detail: `Candidate ${candidateRowCount} vs legacy ${legacyRowCount} → ${rounded}% deviation (tolerance ±${tolerancePct}%).`,
  };
}

/**
 * Extract a labelled integer row count from free-form report text.
 * Recognizes patterns like "row count: 1234", "rows = 1,234", "1234 rows".
 * Returns null if no count is found (so the caller can degrade, not guess).
 */
export function extractRowCount(text: string): number | null {
  const labelled =
    text.match(/\brow ?count\s*[:=]?\s*([\d,]+)/i) ||
    text.match(/\brows?\s*[:=]\s*([\d,]+)/i) ||
    text.match(/\b([\d,]+)\s+rows?\b/i);
  if (!labelled) return null;
  const n = Number(labelled[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Fix plan
// ---------------------------------------------------------------------------

export interface FixPlanItem {
  check: string;
  action: string;
}

/**
 * Build a deterministic fix plan from the failing + skipped checks. Failures
 * get a concrete remediation; skipped checks get a "to evaluate, do X" item so
 * nothing is silently dropped.
 */
export function buildFixPlan(checks: CheckResult[]): FixPlanItem[] {
  const plan: FixPlanItem[] = [];
  for (const c of checks) {
    if (c.status === "passed") continue;
    plan.push({ check: c.name, action: remediationFor(c) });
  }
  return plan;
}

function remediationFor(c: CheckResult): string {
  if (c.status === "skipped") {
    switch (c.kind) {
      case "row_count":
      case "reconciliation":
        return "Measure the candidate (and legacy) row count, then re-run validation without --skip-external.";
      case "build":
      case "dbt":
        return "Run `dbt build` against the sandbox (omit --skip-external) to confirm the model compiles and tests pass.";
      case "other":
        return "Map this acceptance criterion to a concrete dbt test or warehouse query with a human/EDA review.";
      default:
        return `Add a dbt ${c.kind} test (or warehouse assertion) for this criterion and re-run validation against the built model.`;
    }
  }
  // failed
  switch (c.kind) {
    case "dbt":
    case "command":
      return "Inspect the command output above, fix the model/test, and re-run.";
    case "reconciliation":
    case "row_count":
      return "Investigate the row-count discrepancy (filters, joins, grain) until within tolerance of the legacy report.";
    default:
      return "Correct the model so this assertion holds, then re-run validation.";
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export interface Verdict {
  /** True only when no blocking failures remain. */
  done: boolean;
  passed: number;
  failed: number;
  skipped: number;
  /** The blocking failures that prevent declaring done. */
  blockers: string[];
}

/**
 * Compute the overall verdict from all checks.
 *
 * A `blocking` check gates "done" whenever it is NOT passing — both `failed`
 * (the assertion broke) and `skipped` (a mandatory check we could not verify).
 * Treating an unverified mandatory check as a blocker is the honest stance:
 * Oswald never declares done on a must-pass criterion it never evaluated.
 */
export function computeVerdict(checks: CheckResult[]): Verdict {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const blockers: string[] = [];
  for (const c of checks) {
    if (c.status === "passed") {
      passed += 1;
      continue;
    }
    if (c.status === "failed") failed += 1;
    else skipped += 1;
    if (c.blocking) {
      const why = c.status === "skipped" ? "not verified" : c.detail;
      blockers.push(`${c.name} — ${why}`);
    }
  }
  return { done: blockers.length === 0, passed, failed, skipped, blockers };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
