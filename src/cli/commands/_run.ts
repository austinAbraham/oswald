/**
 * Shared CLI runner for tentacle-backed commands.
 *
 * Every pipeline command (intake/clarify/context/eda/design/plan/validate/pr/
 * update-ticket) funnels through {@link runTentacleCommand}. It:
 *   1. builds a fully-wired {@link TentacleContext} via `buildContext`,
 *   2. looks the tentacle up in the registry by id,
 *   3. runs it,
 *   4. prints the STANDARD output block — what it did, where artifacts landed,
 *      and the suggested next command,
 *   5. returns a process exit code (0 on success, non-zero on hard error or a
 *      blocked workflow state).
 *
 * Approval flags (`--yes`/`--draft`/`--post`/`--open`/`--apply`) are mapped into
 * the tentacle `options` here so each tentacle (and the ApprovalService it
 * consults) sees a single, consistent `yes` consent signal. Writes are
 * default-deny: absent explicit consent AND a permitting policy, side effects
 * never run.
 *
 * CI / headless mode: with `json: true` the human-formatted block is suppressed
 * and exactly ONE machine-readable JSON step report is emitted on stdout (the
 * {@link StepReport} shape, documented in docs/CLI.md). Incidental diagnostics
 * still go to stderr via the logger, so stdout stays parseable. The document is
 * valid in every outcome — success, blocked, and hard error alike.
 */
import * as path from "node:path";
import { buildContext } from "../../tentacles/base.js";
import type { TentacleProviders } from "../../tentacles/base.js";
import { getTentacle } from "../../tentacles/registry.js";
import { readState, updateState } from "../../core/state/index.js";
import { recommendNextCommand } from "../../core/workflow/index.js";
import { logger as defaultLogger, type Logger } from "../../core/logging/index.js";
import type { ApprovalService } from "../../core/approvals/index.js";
import { resolveConfig } from "./_config.js";

/** Flags that, when present, grant explicit consent for a side-effecting write. */
export interface ApprovalFlags {
  /** Blanket consent (`--yes`). */
  yes?: boolean;
  /** A `--post` flag (clarify/update-ticket) implies consent to post. */
  post?: boolean;
  /** An `--open` flag (pr) implies consent to open the PR. */
  open?: boolean;
  /** An `--apply` flag (build) implies consent to write scaffolding. */
  apply?: boolean;
  /**
   * A `--draft` flag is the OPPOSITE of consent — it forces draft-only even if
   * another consent flag is set. Recorded so callers can express intent.
   */
  draft?: boolean;
}

/**
 * Collapse the approval flags into a single boolean consent signal.
 *
 * `--draft` always wins (forces draft-only). Otherwise any of `--yes/--post/
 * --open/--apply` grants consent. The ApprovalService still independently
 * checks policy, so consent here is necessary but never sufficient.
 */
export function resolveConsent(flags: ApprovalFlags): boolean {
  if (flags.draft) return false;
  return Boolean(flags.yes || flags.post || flags.open || flags.apply);
}

/** Where the (single, collapsed) consent signal for a run came from. */
export type ConsentSource =
  | "--yes"
  | "--post"
  | "--open"
  | "--apply"
  | "--draft"
  | "none";

/**
 * Name the flag that decided consent for this run, mirroring
 * {@link resolveConsent}: `--draft` always wins (it forces draft-only), then
 * the first consent-granting flag in `--yes`/`--post`/`--open`/`--apply`
 * order, else `none`. Reported per approval decision in `--json` output.
 */
export function consentSource(flags: ApprovalFlags | undefined): ConsentSource {
  if (!flags) return "none";
  if (flags.draft) return "--draft";
  if (flags.yes) return "--yes";
  if (flags.post) return "--post";
  if (flags.open) return "--open";
  if (flags.apply) return "--apply";
  return "none";
}

// ---------------------------------------------------------------------------
// Machine-readable step report (`--json`).
// ---------------------------------------------------------------------------

/** Version id stamped on every step report. Bump only on breaking changes. */
export const STEP_REPORT_SCHEMA = "oswald.step_report/v1";

/** One approval decision, as serialized into a step report. */
export interface ApprovalDecisionReport {
  /** The gated action class (e.g. `open_pull_request`, `ticket_update`). */
  action: string;
  decision: "allowed" | "denied" | "prohibited";
  allowed: boolean;
  /** Why the decision was made (default-deny / policy / consent). */
  reason: string;
  /** Which CLI flag decided consent for this run (see {@link ConsentSource}). */
  consent_source: ConsentSource;
}

/**
 * The single JSON document a `--json` run prints on stdout. Keys are
 * snake_case and STABLE — CI consumers parse this. Documented in docs/CLI.md
 * ("CI / machine output"). Paths are always relative to the project root;
 * no absolute user paths and no secrets ever appear here.
 */
export interface StepReport {
  schema: typeof STEP_REPORT_SCHEMA;
  /** True only for a clean success (`exit_code` 0). Blocked/error → false. */
  ok: boolean;
  /** The CLI verb the user ran (e.g. "eda", "pr"). */
  command: string;
  ticket: string | null;
  /** The documented 0/1/2 contract (0 ok, 1 hard error, 2 blocked). */
  exit_code: 0 | 1 | 2;
  /** Workflow phase before the run (null if state was never readable). */
  phase_before: string | null;
  /** Workflow phase after the run (null on hard error). */
  phase_after: string | null;
  blocked: boolean;
  blockers: string[];
  /** The tentacle's one-line summary (null on hard error). */
  summary: string | null;
  warnings: string[];
  open_questions_count: number;
  /** Artifacts written this run, relative to the project root. */
  artifacts: string[];
  /** Every approval decision taken during the run, in call order. */
  approvals: ApprovalDecisionReport[];
  /** Recommended next CLI command (null when terminal or errored). */
  next_command: string | null;
  /** Error message on hard failure; null otherwise. */
  error: string | null;
}

/**
 * Build a hard-failure {@link StepReport} for precondition failures that occur
 * BEFORE the shared runner is reached (e.g. `eda --execute` without a
 * connection). Keeps the "one valid JSON document per step" contract intact on
 * every `--json` code path.
 */
export function failureStepReport(opts: {
  command: string;
  ticket?: string | undefined;
  exitCode: 1 | 2;
  error: string;
}): StepReport {
  return {
    schema: STEP_REPORT_SCHEMA,
    ok: false,
    command: opts.command,
    ticket: opts.ticket ?? null,
    exit_code: opts.exitCode,
    phase_before: null,
    phase_after: null,
    blocked: false,
    blockers: [],
    summary: null,
    warnings: [],
    open_questions_count: 0,
    artifacts: [],
    approvals: [],
    next_command: null,
    error: opts.error,
  };
}

export interface RunTentacleCommandArgs {
  /** Registry id of the tentacle to run (e.g. "intake", "validate"). */
  id: string;
  /** The CLI verb the user typed (for `last_command` + next-step hints). */
  command: string;
  /** Project root. */
  cwd: string;
  /** Ticket id this run targets, if any. */
  ticketId?: string | undefined;
  /** Per-run options forwarded verbatim to the tentacle. */
  options?: Record<string, unknown>;
  /** Providers to wire into the context (degrade by omission). */
  providers?: TentacleProviders;
  /** Approval flags → mapped into `options.yes`. */
  approval?: ApprovalFlags;
  /** Seed initial state if `.oswald/state.yml` does not exist (intake only). */
  initStateIfMissing?: boolean;
  /** Logger override (tests). */
  logger?: Logger;
  /**
   * CI / headless mode: suppress the human output block and emit ONE JSON
   * {@link StepReport} on stdout instead. Never changes what the tentacle does
   * — only how the outcome is printed.
   */
  json?: boolean;
  /** Raw stdout sink for machine output (tests). Defaults to console.log. */
  stdout?: (line: string) => void;
}

/** Result of running a tentacle command. */
export interface RunOutcome {
  exitCode: number;
  artifactsWritten: string[];
  /** The recommended next command after this run (from workflow state). */
  nextCommand: string | null;
  /** The machine-readable step report (always built; printed under --json). */
  report: StepReport;
}

/**
 * Run a registry tentacle and print the standard CLI output block.
 *
 * Exit codes: 0 = success; 1 = hard error (tentacle threw / unknown id); 2 =
 * the workflow landed in `blocked` (validation gate failed, etc.). A blocked
 * state is NOT a crash — artifacts are still written — but it is surfaced as a
 * non-zero code so automation halts.
 */
export async function runTentacleCommand(
  args: RunTentacleCommandArgs,
): Promise<RunOutcome> {
  const log = args.logger ?? defaultLogger;
  const json = args.json === true;
  const emit = args.stdout ?? ((line: string) => console.log(line));
  const source = consentSource(args.approval);

  // In JSON mode stdout must carry ONLY the report document: informational
  // chatter (from the runner AND from tentacles via ctx.logger) is silenced,
  // while warnings/errors keep flowing to stderr.
  const runLog: Logger = json
    ? {
        info: () => {},
        success: () => {},
        warn: (m) => log.warn(m),
        error: (m) => log.error(m),
      }
    : log;

  const tentacle = getTentacle(args.id);
  if (!tentacle) {
    log.error(`No tentacle registered for id '${args.id}'.`);
    const report = failureStepReport({
      command: args.command,
      ticket: args.ticketId,
      exitCode: 1,
      error: `No tentacle registered for id '${args.id}'.`,
    });
    if (json) emit(JSON.stringify(report));
    return { exitCode: 1, artifactsWritten: [], nextCommand: null, report };
  }

  const consent = args.approval ? resolveConsent(args.approval) : undefined;
  const options: Record<string, unknown> = {
    ...(args.options ?? {}),
    ...(consent !== undefined ? { yes: consent } : {}),
  };

  // Tracked across try/catch so the error report can still carry the phase we
  // started from and any approval decisions taken before the failure.
  let phaseBefore: string | null = null;
  let approvals: ApprovalService | null = null;

  let outcome: RunOutcome;
  try {
    const config = await resolveConfig(args.cwd);
    const ctx = await buildContext({
      projectRoot: args.cwd,
      config,
      ...(args.ticketId ? { ticketId: args.ticketId } : {}),
      options,
      ...(args.providers ? { providers: args.providers } : {}),
      ...(args.initStateIfMissing ? { initStateIfMissing: true } : {}),
      logger: runLog,
    });
    phaseBefore = ctx.state.status.phase;
    approvals = ctx.approvals;

    // Persist the targeted ticket id into state so downstream commands and
    // `next --run` can recover it. (Tentacles advance the phase but do not own
    // ticket identity; the CLI does.)
    if (args.ticketId && ctx.state.ticket.id !== args.ticketId) {
      await updateState(
        args.cwd,
        (s) => ({ ...s, ticket: { ...s.ticket, id: args.ticketId! } }),
        { clock: ctx.clock, artifactDir: ctx.config.paths.artifact_dir },
      );
    }

    const result = await tentacle.run(ctx);

    // Re-read state to learn the phase the tentacle advanced into (it owns the
    // transition) and the next recommended command.
    const state = await readState(args.cwd, ctx.config.paths.artifact_dir);
    const blocked = state.status.phase === "blocked";
    const nextCommand = recommendNextCommand(state.status.phase);

    const report: StepReport = {
      schema: STEP_REPORT_SCHEMA,
      ok: !blocked,
      command: args.command,
      ticket: args.ticketId ?? state.ticket.id ?? null,
      exit_code: blocked ? 2 : 0,
      phase_before: phaseBefore,
      phase_after: state.status.phase,
      blocked,
      blockers: [...state.status.blockers],
      summary: result.summary,
      warnings: result.warnings ?? [],
      open_questions_count: result.openQuestions?.length ?? 0,
      artifacts: result.artifactsWritten.map(
        (p) => path.relative(args.cwd, p) || p,
      ),
      approvals: ctx.approvals.decisions().map((d) => ({
        action: d.action,
        decision: d.decision,
        allowed: d.allowed,
        reason: d.reason,
        consent_source: source,
      })),
      next_command: nextCommand,
      error: null,
    };

    if (json) {
      // Machine output: exactly one JSON document on stdout, nothing else.
      emit(JSON.stringify(report));
    } else {
      // --- Standard output block. -----------------------------------------
      log.success(`${args.command}: ${result.summary}`);

      if (result.warnings && result.warnings.length > 0) {
        for (const w of result.warnings) log.warn(`  warning: ${w}`);
      }
      if (result.openQuestions && result.openQuestions.length > 0) {
        log.info(`  open question(s) (${result.openQuestions.length}):`);
        for (const q of result.openQuestions) log.info(`    - ${q}`);
      }

      if (result.artifactsWritten.length > 0) {
        log.info(`  artifacts (${result.artifactsWritten.length}):`);
        for (const p of result.artifactsWritten) {
          log.info(`    - ${path.relative(args.cwd, p) || p}`);
        }
      } else {
        log.info("  artifacts: none written");
      }

      if (blocked) {
        log.warn(`  state: BLOCKED — ${state.status.blockers.length} blocker(s)`);
        for (const b of state.status.blockers) log.warn(`    - ${b}`);
        log.info("  next:  resolve the blocker(s), then re-run validate");
      } else if (nextCommand) {
        log.info(`  next:  oswald ${nextCommand}`);
      } else {
        log.success(`  pipeline complete — phase '${state.status.phase}'`);
      }
    }

    outcome = {
      exitCode: blocked ? 2 : 0,
      artifactsWritten: result.artifactsWritten,
      nextCommand,
      report,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Diagnostics always go to stderr, so `--json` stdout stays parseable.
    log.error(`${args.command} failed: ${message}`);
    const report: StepReport = {
      ...failureStepReport({
        command: args.command,
        ticket: args.ticketId,
        exitCode: 1,
        error: message,
      }),
      phase_before: phaseBefore,
      approvals: (approvals?.decisions() ?? []).map((d) => ({
        action: d.action,
        decision: d.decision,
        allowed: d.allowed,
        reason: d.reason,
        consent_source: source,
      })),
    };
    if (json) emit(JSON.stringify(report));
    outcome = { exitCode: 1, artifactsWritten: [], nextCommand: null, report };
  }

  return outcome;
}
