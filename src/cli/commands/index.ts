import type { Command } from "commander";
import { registerInit } from "./init.js";
import { registerDoctor } from "./doctor.js";
import { registerNext } from "./next.js";
import { registerIntake } from "./intake.js";
import { registerClarify } from "./clarify.js";
import { registerContext } from "./context.js";
import { registerEda } from "./eda.js";
import { registerDesign } from "./design.js";
import { registerPlan } from "./plan.js";
import { registerBuild } from "./build.js";
import { registerValidate } from "./validate.js";
import { registerPr } from "./pr.js";
import { registerUpdateTicket } from "./update-ticket.js";
import { registerShip } from "./ship.js";
import { registerCompact } from "./compact.js";

/**
 * Register every CLI command onto the program, in workflow order.
 *
 * Pipeline commands (intake → … → update-ticket) are tentacle-backed via the
 * shared runner; build/ship/compact are deterministic non-tentacle commands;
 * init/doctor/next are operator commands.
 */
export function registerCommands(program: Command): void {
  // Operator / setup.
  registerInit(program);
  registerDoctor(program);

  // Pipeline (workflow order).
  registerIntake(program);
  registerClarify(program);
  registerContext(program);
  registerEda(program);
  registerDesign(program);
  registerPlan(program);
  registerBuild(program);
  registerValidate(program);
  registerPr(program);
  registerUpdateTicket(program);
  registerShip(program);

  // Maintenance + navigation.
  registerCompact(program);
  registerNext(program);
}
