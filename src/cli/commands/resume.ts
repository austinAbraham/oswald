/**
 * `resume` — first-class recovery from a `blocked` workflow.
 *
 * `blocked` used to be a dead end for `oswald next`. `resume` makes it
 * recoverable: it reads the recorded blockers, re-runs the gate that parked the
 * workflow, and reports where the pipeline stands afterwards.
 *
 * Every blocked entry today is produced by the validation gate — either
 * `validate` directly, or delivery re-reading the validation signal — so the
 * deterministic single-shot recovery is to re-run the validate tentacle
 * (exactly the "re-run the blocking check" step the shared runner hints at when
 * it parks the workflow). On a pass the tentacle leaves `blocked` via a legal
 * transition; when state recorded where the workflow was blocked FROM
 * (`status.blocked_from`) and that phase is legally reachable from where the
 * re-run landed, resume restores it so already-completed phases stay completed.
 * On continued failure the workflow stays `blocked` with a clear report
 * (exit 2 — the same contract as `validate`).
 *
 * Single-shot and deterministic by design: no retry loops, no auto-fixing.
 * The validation execution knobs (`--dbt`, `--command`, …) mirror
 * `oswald validate` so the re-run can produce a REAL verdict; the default stays
 * fully local (no subprocess is ever spawned without explicit opt-in).
 *
 * FIDELITY GUARD: state records the execution mode of the run that blocked
 * (`status.blocked_mode`). When the block came from a REAL external run
 * (dbt build/test or injected validation commands), a local-only re-run would
 * SKIP exactly the checks that failed — so `resume` refuses to run it and stays
 * `blocked` (exit 2), telling the user to re-run with `--dbt`. A block is never
 * cleared at a lower fidelity than the run that produced it.
 */
import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";
import { resolveConfig } from "./_config.js";
import {
  readState,
  updateState,
  StateError,
  type BlockedMode,
} from "../../core/state/index.js";
import {
  canTransition,
  recommendNextCommand,
  type WorkflowState,
} from "../../core/workflow/index.js";
import { logger as defaultLogger, type Logger } from "../../core/logging/index.js";
import { systemClock, type Clock } from "../../utils/time.js";

const OptionsSchema = z.object({
  command: z.array(z.string()).optional(),
  dbt: z.boolean().optional(),
  skipExternal: z.boolean().optional(),
  dbtProjectDir: z.string().optional(),
  dbtCommand: z.string().optional(),
  dbtTarget: z.string().optional(),
  cwd: z.string(),
});

export interface RunResumeArgs {
  /** Project root. */
  cwd: string;
  /** Ticket id the blocked workflow targets. */
  ticketId: string;
  /** Per-run options forwarded to the validate re-run (mirrors `validate`). */
  options?: Record<string, unknown>;
  /** Injected clock (tests pass a fixed clock). Defaults to systemClock. */
  clock?: Clock;
  /** Logger override (tests). */
  logger?: Logger;
}

/** Result of a resume attempt. */
export interface ResumeOutcome {
  /** 0 = unblocked (or nothing to resume); 1 = hard error; 2 = still blocked. */
  exitCode: number;
  /** Workflow phase after the attempt (null when state could not be read). */
  phase: WorkflowState | null;
}

/**
 * Attempt to recover a blocked workflow. Exit codes follow the shared
 * 0/1/2 contract: `0` the workflow is (now) unblocked — including the
 * idempotent no-op when it was never blocked; `1` hard error; `2` the blocking
 * check still fails and the workflow stays `blocked`.
 */
export async function runResume(args: RunResumeArgs): Promise<ResumeOutcome> {
  const log = args.logger ?? defaultLogger;
  const clock = args.clock ?? systemClock;

  let artifactDir: string;
  let phase: WorkflowState;
  let blockedFrom: WorkflowState | null;
  let blockedMode: BlockedMode | null;
  let blockers: string[];
  try {
    const config = await resolveConfig(args.cwd);
    artifactDir = config.paths.artifact_dir;
    const state = await readState(args.cwd, artifactDir);
    phase = state.status.phase;
    blockedFrom = state.status.blocked_from ?? null;
    blockedMode = state.status.blocked_mode ?? null;
    blockers = state.status.blockers;
  } catch (err) {
    if (err instanceof StateError) {
      log.error("resume: Oswald is not initialized here — run 'oswald init' first.");
      return { exitCode: 1, phase: null };
    }
    throw err;
  }

  // --- Not blocked: nothing to resume (idempotent no-op). -----------------
  if (phase !== "blocked") {
    log.info(`resume: workflow is not blocked (phase '${phase}') — nothing to resume.`);
    const cmd = recommendNextCommand(phase);
    if (cmd) {
      log.info(`  next:  oswald ${cmd}`);
    } else {
      log.success(`  pipeline complete — phase '${phase}'`);
    }
    return { exitCode: 0, phase };
  }

  // --- Report what blocked the workflow. -----------------------------------
  log.warn(
    `resume: workflow is BLOCKED${blockedFrom ? ` (entered from '${blockedFrom}')` : ""} — ${blockers.length} recorded blocker(s):`,
  );
  for (const b of blockers) log.warn(`    - ${b}`);
  if (blockers.length === 0) log.warn("    - (no blocker detail recorded)");

  // --- Fidelity guard: never clear an external block with a local re-run. --
  // The run that blocked executed REAL external checks; re-running locally
  // would mark exactly those checks skipped (non-blocking) and wave the gate
  // through with zero evidence. Refuse and stay blocked instead.
  const rerunIsLocal =
    (args.options?.skipExternal as boolean | undefined) ?? true;
  if (blockedMode === "external" && rerunIsLocal) {
    log.error(
      "resume: this block came from a REAL external run (dbt build/test / validation commands) — a local-only re-run cannot clear it.",
    );
    log.info(
      `  re-run at the same fidelity:  oswald resume ${args.ticketId} --dbt`,
    );
    log.warn("  the workflow stays BLOCKED (nothing was re-run).");
    return { exitCode: 2, phase: "blocked" };
  }

  // --- Re-run the gate that blocked (single-shot, no retry loop). ----------
  log.info(`  re-running the blocking check: validate ${args.ticketId}`);
  const rerun = await runTentacleCommand({
    id: "validate",
    command: "resume",
    cwd: args.cwd,
    ticketId: args.ticketId,
    options: args.options ?? {},
    logger: log,
  });
  if (rerun.exitCode === 1) {
    // Hard error already reported by the runner; the workflow is unchanged.
    return { exitCode: 1, phase: "blocked" };
  }

  // --- Report the outcome. --------------------------------------------------
  let after = await readState(args.cwd, artifactDir);
  if (after.status.phase === "blocked") {
    log.warn(
      "resume: the blocking check still fails — the workflow stays BLOCKED (see the report above).",
    );
    return { exitCode: 2, phase: "blocked" };
  }

  // The re-run passed and left `blocked` via a legal transition. When the
  // workflow was blocked from a LATER phase than where the check landed (e.g.
  // delivery blocked at ready_for_ticket_update; a passing validate lands on
  // ready_for_pr), restore the recorded origin — but only over a legal edge,
  // never as a regression.
  if (
    blockedFrom !== null &&
    blockedFrom !== after.status.phase &&
    canTransition(after.status.phase, blockedFrom)
  ) {
    const target = blockedFrom;
    after = await updateState(
      args.cwd,
      (s) => {
        const status = {
          ...s.status,
          phase: target,
          last_command: "resume",
          next_recommended_command: recommendNextCommand(target),
          blockers: [],
        };
        delete status.blocked_from;
        delete status.blocked_mode;
        return { ...s, status };
      },
      { clock, artifactDir },
    );
    log.info(`  restored the pre-blocked phase '${target}' (legal transition).`);
  }

  const next = recommendNextCommand(after.status.phase);
  log.success(`resume: unblocked — phase '${after.status.phase}'.`);
  if (next) {
    log.info(`  next:  oswald ${next}`);
  } else {
    log.success(`  pipeline complete — phase '${after.status.phase}'`);
  }
  return { exitCode: 0, phase: after.status.phase };
}

export function registerResume(program: Command): void {
  program
    .command("resume")
    .description("Recover from a blocked workflow: re-run the blocking check and report the next step")
    .argument("<ticket>", "ticket id the blocked workflow targets")
    .option(
      "--command <cmd>",
      "extra validation command to run (repeatable)",
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .option(
      "--dbt",
      "re-run with real dbt build + test via the runner when a dbt project is detected (turns on external execution)",
    )
    .option("--skip-external", "stay fully local: never run any external command (default)")
    .option("--dbt-project-dir <dir>", "explicit dbt project dir (else auto-detected)")
    .option("--dbt-command <cmd>", "dbt invocation (e.g. 'uvx --from dbt-core --with dbt-duckdb dbt')")
    .option("--dbt-target <target>", "dbt target to build/test against (must look like a sandbox)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald resume TICKET-42              # re-run the blocking check locally\n  oswald resume TICKET-42 --dbt        # re-run with REAL dbt build + test\n\nNote: single-shot — on continued failure the workflow stays 'blocked' (exit 2).\nA block produced by a REAL external run (state.status.blocked_mode = external)\nrequires --dbt: a local-only resume refuses to run and stays 'blocked' (exit 2).",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      // Same option mapping as `validate`: fully-local by default; any explicit
      // dbt knob opts INTO external execution; `--skip-external` always wins.
      const wantsExternal =
        Boolean(opts.dbt) ||
        Boolean(opts.dbtProjectDir) ||
        Boolean(opts.dbtCommand) ||
        Boolean(opts.dbtTarget);
      const skipExternal = opts.skipExternal ? true : !wantsExternal;

      const options: Record<string, unknown> = { skipExternal };
      if (opts.command && opts.command.length > 0) {
        options.validationCommands = opts.command;
      }
      if (opts.dbt) options.dbtProject = true;
      if (opts.dbtProjectDir) options.dbtProjectDir = opts.dbtProjectDir;
      if (opts.dbtCommand) options.dbtCommand = opts.dbtCommand;
      if (opts.dbtTarget) options.dbtTarget = opts.dbtTarget;

      const { exitCode } = await runResume({ cwd, ticketId: ticket, options });
      process.exitCode = exitCode;
    });
}
