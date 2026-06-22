/**
 * Tentacle registry — maps a tentacle id to its implementation.
 *
 * The CLI / host runtime looks tentacles up by id (which is also the workflow
 * phase and CLI verb). All eight tentacles are registered here following one
 * pattern: import the exported `Tentacle` instance and key it by its `.id`.
 */
import type { Tentacle } from "./base.js";
import { intakeTentacle } from "./intake/index.js";
import { clarificationTentacle } from "./clarification/index.js";
import { contextTentacle } from "./context/index.js";
import { edaTentacle } from "./eda/index.js";
import { designTentacle } from "./design/index.js";
import { planningTentacle } from "./planning/index.js";
import { validationTentacle } from "./validation/index.js";
import { deliveryTentacle } from "./delivery/index.js";

/**
 * The live registry. Keyed by tentacle id.
 *
 * Order here is the linear pipeline order (intake → … → delivery); the keys are
 * the tentacle `.id` values, which double as workflow phases / CLI verbs.
 */
export const TENTACLE_REGISTRY: Record<string, Tentacle> = {
  [intakeTentacle.id]: intakeTentacle,
  [clarificationTentacle.id]: clarificationTentacle,
  [contextTentacle.id]: contextTentacle,
  [edaTentacle.id]: edaTentacle,
  [designTentacle.id]: designTentacle,
  [planningTentacle.id]: planningTentacle,
  [validationTentacle.id]: validationTentacle,
  [deliveryTentacle.id]: deliveryTentacle,
};

/** Look up a tentacle by id, or undefined if not registered. */
export function getTentacle(id: string): Tentacle | undefined {
  return TENTACLE_REGISTRY[id];
}

/** All registered tentacle ids (deterministic order). */
export function tentacleIds(): string[] {
  return Object.keys(TENTACLE_REGISTRY).sort();
}

/** All registered tentacles. */
export function allTentacles(): Tentacle[] {
  return tentacleIds().map((id) => TENTACLE_REGISTRY[id]!);
}
