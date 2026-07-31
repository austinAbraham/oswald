/**
 * Shared CLI runner for tentacle-backed commands.
 *
 * Every pipeline command (intake/clarify/context/eda/design/plan/validate/pr/
 * update-ticket) funnels through {@link runTentacleCommand}. It:
 *   1. builds a fully-wired {@link TentacleContext} via `buildContext`,
 *   2. looks the tentacle up in the registry by id,
 *   3. pre-flights the workflow transition (current phase → the tentacle's
 *      `advancesTo`) and REFUSES an out-of-order command before any side
 *      effect runs, then runs the tentacle,
 *   4. prints the STANDARD output block — what it did, the provider resolution
 *      table (requested vs resolved), where artifacts landed, and the suggested
 *      next command,
 *   5. returns a process exit code (0 on success, non-zero on hard error or a
 *      blocked workflow state).
 *
 * Provider strictness: when `--strict-providers` is passed (or
 * `policies.strict_providers` is true in config) any SILENT provider fallback
 * (e.g. snowflake→mock because `snow` is missing) refuses to run — exit 1 with
 * a remediation hint — so mock results can never masquerade as real evidence.
 * Default behavior is unchanged: fallback with a warning plus a visible table.
 *
 * Approval flags (`--yes`/`--draft`/`--post`/`--open`/`--apply`) are mapped into
 * the tentacle `options` here so each tentacle (and the ApprovalService it
 * consults) sees a single, consistent `yes` consent signal. Writes are
 * default-deny: absent explicit consent AND a permitting policy, side effects
 * never run.
 */
import * as path from "node:path";
import { buildContext } from "../../tentacles/base.js";
import type { TentacleContext, TentacleProviders } from "../../tentacles/base.js";
import { getTentacle } from "../../tentacles/registry.js";
import type { AuditLedger } from "../../core/audit/index.js";
import { readState, updateState } from "../../core/state/index.js";
import {
  assertLegalTransition,
  recommendNextCommand,
} from "../../core/workflow/index.js";
import { logger as defaultLogger, type Logger } from "../../core/logging/index.js";
import { resolveConfig } from "./_config.js";
import {
  renderProviderResolution,
  type ProviderResolutionEntry,
} from "./_providers.js";

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
 *
 * The returned boolean is always explicit: `false` reaches the
 * ApprovalService as an explicit decline, which also blocks policy-granted
 * consent (`policies.autonomy.auto_approve`) — so `--draft` forces draft-only
 * regardless of policy. Policy-granted consent is only reachable via
 * `consentMode: "policy"` (see {@link RunTentacleCommandArgs}), a deliberate
 * opt-in reserved for an autonomous runner — never the interactive CLI.
 */
export function resolveConsent(flags: ApprovalFlags): boolean {
  if (flags.draft) return false;
  return Boolean(flags.yes || flags.post || flags.open || flags.apply);
}

/**
 * Consent mapping for `consentMode: "policy"` — the deliberate opt-in used by
 * an autonomous runner. `--draft` still collapses to an explicit decline and
 * any explicit consent flag still wins; only the flag-less middle ground is
 * left `undefined` so the ApprovalService may consult
 * `policies.autonomy.auto_approve`.
 */
export function resolvePolicyModeConsent(
  flags: ApprovalFlags | undefined,
): boolean | undefined {
  if (!flags) return undefined;
  if (flags.draft) return false;
  return flags.yes || flags.post || flags.open || flags.apply
    ? true
    : undefined;
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
  /**
   * The requested→resolved provider report from `selectProviders`. Printed as
   * a one-line table in the standard output block; under strict providers any
   * `fallback: true` entry is a hard failure before the tentacle runs.
   */
  providerResolution?: ProviderResolutionEntry[];
  /**
   * The `--strict-providers` flag. OR-ed with `policies.strict_providers`
   * from config; when effective, a silent provider fallback exits 1.
   */
  strictProviders?: boolean;
  /** Approval flags → mapped into `options.yes`. */
  approval?: ApprovalFlags;
  /**
   * How consent is derived when approval flags are absent or neutral.
   *
   * - `"explicit"` (the default): the absence of flags collapses to an
   *   explicit `yes: false`, so the ApprovalService can NEVER fall through to
   *   policy-granted consent. Every interactive CLI command uses this mode —
   *   consent flags are never defaults.
   * - `"policy"`: the deliberate opt-in for an autonomous runner. Flag-less
   *   runs pass `yes: undefined`, letting `policies.autonomy.auto_approve`
   *   (level `auto_safe`) speak. `--draft` and explicit flags still win.
   */
  consentMode?: "explicit" | "policy";
  /** Seed initial state if `.oswald/state.yml` does not exist (intake only). */
  initStateIfMissing?: boolean;
  /** Logger override (tests). */
  logger?: Logger;
  /** Audit ledger override (when the command already holds the instance). */
  audit?: AuditLedger;
}

/** Result of running a tentacle command. */
export interface RunOutcome {
  exitCode: number;
  artifactsWritten: string[];
  /** The recommended next command after this run (from workflow state). */
  nextCommand: string | null;
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
  const tentacle = getTentacle(args.id);
  if (!tentacle) {
    log.error(`No tentacle registered for id '${args.id}'.`);
    return { exitCode: 1, artifactsWritten: [], nextCommand: null };
  }

  const consent =
    args.consentMode === "policy"
      ? resolvePolicyModeConsent(args.approval)
      : resolveConsent(args.approval ?? {});
  const options: Record<string, unknown> = {
    ...(args.options ?? {}),
    ...(consent !== undefined ? { yes: consent } : {}),
  };

  let outcome: RunOutcome;
  let ctx: TentacleContext | undefined;
  let phaseBefore: string | undefined;
  try {
    const config = await resolveConfig(args.cwd);

    // --- Provider strictness gate. Runs BEFORE the tentacle so a mock never
    // masquerades as real evidence: under `--strict-providers` (or
    // `policies.strict_providers: true`) any silent fallback is a hard failure.
    const resolution = args.providerResolution ?? [];
    const strict = Boolean(args.strictProviders) || config.policies.strict_providers;
    const fallbacks = resolution.filter((e) => e.fallback);
    if (strict && fallbacks.length > 0) {
      log.error(
        `${args.command}: provider fallback refused (strict providers) — ${renderProviderResolution(resolution)}`,
      );
      for (const f of fallbacks) {
        log.error(
          `  ${f.slot}: requested '${f.requested}' but resolved '${f.resolved}'${
            f.reason ? ` — ${f.reason}` : ""
          }${f.remediation ? `. Fix: ${f.remediation}` : ""}`,
        );
      }
      return { exitCode: 1, artifactsWritten: [], nextCommand: null };
    }

    ctx = await buildContext({
      projectRoot: args.cwd,
      config,
      ...(args.ticketId ? { ticketId: args.ticketId } : {}),
      options,
      ...(args.providers ? { providers: args.providers } : {}),
      ...(args.initStateIfMissing ? { initStateIfMissing: true } : {}),
      logger: log,
      ...(args.audit ? { audit: args.audit } : {}),
    });
    phaseBefore = ctx.state.status.phase;

    // Pre-flight the state machine BEFORE any side effect: an out-of-order
    // command must refuse here — while nothing has been posted, written, or
    // archived — not after the tentacle has already committed external writes.
    // `advanceWorkflow` re-asserts the same rule afterwards as the backstop.
    assertLegalTransition(ctx.state.status.phase, tentacle.advancesTo);

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

    // --- Standard output block. -------------------------------------------
    log.success(`${args.command}: ${result.summary}`);

    log.info(`  providers: ${renderProviderResolution(resolution)}`);

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

    outcome = {
      exitCode: blocked ? 2 : 0,
      artifactsWritten: result.artifactsWritten,
      nextCommand,
    };

    // Persist the step outcome to the audit ledger (paths project-relative).
    ctx.audit.record("step_outcome", {
      command: args.command,
      tentacle: args.id,
      ...(args.ticketId ? { ticket: args.ticketId } : {}),
      ...(phaseBefore ? { phase_before: phaseBefore } : {}),
      phase_after: state.status.phase,
      exit_code: outcome.exitCode,
      artifacts: result.artifactsWritten.map(
        (p) => path.relative(args.cwd, p) || p,
      ),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${args.command} failed: ${message}`);
    outcome = { exitCode: 1, artifactsWritten: [], nextCommand: null };

    // Best-effort failure record; the ledger never sees absolute user paths.
    ctx?.audit.record("step_outcome", {
      command: args.command,
      tentacle: args.id,
      ...(args.ticketId ? { ticket: args.ticketId } : {}),
      ...(phaseBefore ? { phase_before: phaseBefore } : {}),
      exit_code: 1,
      error: message.split(args.cwd).join("."),
    });
  }

  return outcome;
}
