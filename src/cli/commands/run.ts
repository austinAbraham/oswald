/**
 * `run` — the single-command pipeline driver.
 *
 * `oswald run <ticket>` executes exactly ONE recommended next step (the same
 * dispatch `next --run` performs, but pinned to an explicit ticket). With
 * `--auto` it loops — read the phase, dispatch the recommended command, repeat
 * — until one of the stop conditions:
 *   (a) a terminal phase (`shipped`)                          → exit 0
 *   (b) a step exits non-zero (2 = blocked, 1 = hard error)   → that code
 *   (c) an approval gate: the next step's primary action needs
 *       consent the run does not have                         → exit 3
 *   (d) the `--max-steps` cap (default 20)                    → exit 1
 *
 * CRITICAL SAFETY: auto mode NEVER synthesizes consent flags (`--yes` /
 * `--apply` / `--post` / `--open`). Every dispatched step runs draft/dry-run
 * only, exactly as `next --run` would. When the recommended step's primary
 * deliverable is an approval-gated side effect (build --apply, pr --open,
 * update-ticket --post), the run PARKS in front of it with an "awaiting
 * approval" message instead of silently draft-running past the human decision
 * point. The parked step can then be run by a human — with consent flags, or
 * one step at a time via `oswald run <ticket>` for the draft/dry-run variant.
 */
import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { logger } from "../../core/logging/index.js";
import {
  readState,
  StateError,
  type OswaldState,
} from "../../core/state/index.js";
import { recommendNextCommand } from "../../core/workflow/index.js";
import { TICKET_COMMANDS } from "./next.js";

const OptionsSchema = z.object({
  cwd: z.string(),
  auto: z.boolean().optional(),
  maxSteps: z.coerce.number().int().min(1).max(100).default(20),
});

/** Exit code for a run parked in front of an approval gate (auto mode). */
export const EXIT_AWAITING_APPROVAL = 3;

/**
 * Steps whose PRIMARY deliverable is an approval-gated side effect. Auto mode
 * parks in front of these instead of dispatching them without consent — it
 * never supplies the consent flags itself (default-deny stands).
 */
const APPROVAL_GATES: Record<string, { action: string; consentFlags: string }> = {
  build: { action: "commit (write dbt model files)", consentFlags: "--apply --yes" },
  pr: { action: "open_pull_request", consentFlags: "--open --yes" },
  "update-ticket": { action: "ticket_update", consentFlags: "--post --yes" },
};

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("Execute the recommended next step for a ticket (or, with --auto, loop until a gate)")
    .argument("<ticket>", "ticket id this run drives")
    .option("--auto", "keep executing steps until a terminal phase, a blocker, or an approval gate")
    .option("--max-steps <n>", "safety cap on steps executed per --auto run", "20")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald run TICKET-42          # execute exactly one recommended step\n  oswald run TICKET-42 --auto   # drive the pipeline until it needs a human\n\nNote: --auto never grants consent. Gated writes stay draft/dry-run; the run\nparks at the first approval gate (exit code 3) and tells you the exact\ncommand (with consent flags) to proceed.",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const root = path.resolve(opts.cwd);
      const auto = Boolean(opts.auto);
      const maxSteps = auto ? opts.maxSteps : 1;

      let state: OswaldState;
      try {
        state = await readState(root);
      } catch (err) {
        if (err instanceof StateError) {
          logger.error("run: Oswald is not initialized here.");
          logger.info("  next:  oswald init");
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      // One run drives ONE ticket. Refuse to dispatch commands for a ticket
      // other than the one state is tracking (no silent cross-ticket writes).
      if (state.ticket.id && state.ticket.id !== ticket) {
        logger.error(
          `run: state is tracking ticket '${state.ticket.id}' but '${ticket}' was requested; refusing to mix tickets. Run 'oswald run ${state.ticket.id}' or start a fresh project.`,
        );
        process.exitCode = 1;
        return;
      }

      for (let step = 1; ; step += 1) {
        const phase = state.status.phase;

        // (b') Already blocked: nothing to drive; surface the blockers.
        if (phase === "blocked") {
          logger.warn(
            `run: workflow is BLOCKED — ${state.status.blockers.length} blocker(s)`,
          );
          for (const b of state.status.blockers) logger.warn(`    - ${b}`);
          logger.info("  next:  resolve the blocker(s), then re-run validate");
          process.exitCode = 2;
          return;
        }

        // (a) Terminal phase: the pipeline is complete.
        const cmd = recommendNextCommand(phase);
        if (!cmd) {
          logger.success(`run: pipeline complete — phase '${phase}'`);
          process.exitCode = 0;
          return;
        }

        // Intake needs real ticket content (a file, provider, or pasted text)
        // that a driver must never fabricate — hand it back to the human.
        if (cmd === "init" || cmd === "intake") {
          logger.warn(
            `run: the pipeline has not ingested a ticket yet. Run 'oswald intake ${ticket} --from-file <ticket.md>' (or --provider <name>), then re-run 'oswald run ${ticket}'.`,
          );
          process.exitCode = 1;
          return;
        }

        // (c) Approval gate: park — auto mode never synthesizes consent.
        if (auto && APPROVAL_GATES[cmd]) {
          const gate = APPROVAL_GATES[cmd];
          logger.warn(
            `run: awaiting approval for ${gate.action}: run 'oswald ${cmd} ${ticket} ${gate.consentFlags}' to proceed`,
          );
          logger.info(
            `  (or 'oswald run ${ticket}' to execute '${cmd}' draft/dry-run only)`,
          );
          process.exitCode = EXIT_AWAITING_APPROVAL;
          return;
        }

        // (d) Step cap: refuse to run unattended forever.
        if (step > maxSteps) {
          logger.warn(
            `run --auto: reached --max-steps (${maxSteps}) before a terminal phase; re-run 'oswald run ${ticket} --auto' to continue.`,
          );
          process.exitCode = 1;
          return;
        }

        // --- Dispatch the recommended command via the program (as next --run
        // does), streaming its standard output block as it completes.
        const argv = [process.argv[0]!, process.argv[1]!, cmd];
        if (TICKET_COMMANDS.has(cmd)) {
          argv.push(ticket);
        }
        argv.push("--cwd", root);

        logger.info(
          auto
            ? `run: step ${step} — oswald ${argv.slice(2).join(" ")}`
            : `run: oswald ${argv.slice(2).join(" ")}`,
        );

        process.exitCode = 0;
        await program.parseAsync(argv);
        const stepCode =
          typeof process.exitCode === "number" ? process.exitCode : 0;

        // (b) Non-zero step: halt and propagate (2 = blocked, else hard error).
        if (stepCode !== 0) {
          process.exitCode = stepCode;
          return;
        }

        state = await readState(root);

        if (!auto) {
          process.exitCode = 0;
          return;
        }

        // Loop guard: a 0-exit step that did not advance the phase would spin.
        if (state.status.phase === phase) {
          logger.error(
            `run --auto: '${cmd}' exited 0 but the phase did not advance from '${phase}'; stopping.`,
          );
          process.exitCode = 1;
          return;
        }
      }
    });
}
