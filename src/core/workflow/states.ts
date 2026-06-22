/**
 * Explicit workflow state machine for the Oswald pipeline.
 *
 * The pipeline is linear with a couple of terminal/divergent states. Each state
 * maps to a CLI command that advances the workflow, which powers `oswald next`.
 */

export const WORKFLOW_STATES = [
  "uninitialized",
  "intake",
  "clarification",
  "context",
  "eda",
  "design",
  "planning",
  "building",
  "validating",
  "ready_for_pr",
  "ready_for_ticket_update",
  "shipped",
  "blocked",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Default linear successor for each state. `null` means terminal. */
const LINEAR_NEXT: Record<WorkflowState, WorkflowState | null> = {
  uninitialized: "intake",
  intake: "clarification",
  clarification: "context",
  context: "eda",
  eda: "design",
  design: "planning",
  planning: "building",
  building: "validating",
  validating: "ready_for_pr",
  ready_for_pr: "ready_for_ticket_update",
  ready_for_ticket_update: "shipped",
  shipped: null,
  blocked: null,
};

/**
 * CLI command recommended to move *out of* each state.
 * `null` for terminal states.
 */
const COMMAND_FOR_STATE: Record<WorkflowState, string | null> = {
  uninitialized: "init",
  intake: "intake",
  clarification: "clarify",
  context: "context",
  eda: "eda",
  design: "design",
  planning: "plan",
  building: "build",
  validating: "validate",
  ready_for_pr: "pr",
  ready_for_ticket_update: "update-ticket",
  shipped: null,
  blocked: null,
};

export function isWorkflowState(value: string): value is WorkflowState {
  return (WORKFLOW_STATES as readonly string[]).includes(value);
}

/** Return the default next state, or `null` if the state is terminal. */
export function nextState(current: WorkflowState): WorkflowState | null {
  return LINEAR_NEXT[current];
}

/**
 * Whether a transition from `from` to `to` is allowed.
 *
 * Allowed transitions:
 *  - the default linear successor
 *  - any non-terminal state → `blocked`
 *  - `blocked` → any non-terminal state (resume after unblocking)
 */
export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return false;
  if (LINEAR_NEXT[from] === to) return true;

  const isTerminal = (s: WorkflowState): boolean =>
    s === "shipped" || s === "blocked";

  if (to === "blocked" && from !== "shipped") return true;
  if (from === "blocked" && !isTerminal(to)) return true;

  return false;
}

/**
 * Recommend the CLI command a user should run next from a given state.
 * Returns a human-friendly sentinel for terminal states.
 */
export function recommendNextCommand(state: WorkflowState): string | null {
  return COMMAND_FOR_STATE[state];
}
