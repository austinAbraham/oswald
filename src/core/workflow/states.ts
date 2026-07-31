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
 * Deliberate, enumerated exceptions to the linear rule — transitions the
 * pipeline legitimately performs that the linear table alone forbids. Every
 * entry must carry a rationale and a test; extending this list is the ONLY
 * sanctioned way to allow a new non-linear transition (never bypass the
 * `canTransition` check at a call site).
 */
const EXTRA_TRANSITIONS: ReadonlyArray<readonly [WorkflowState, WorkflowState]> = [
  // `intake` bootstraps a fresh project straight through the intake phase
  // in a single run (`init` leaves the phase at `uninitialized`).
  ["uninitialized", "clarification"],
  // `context` may run when the advisory clarification step was skipped.
  ["clarification", "eda"],
  // `design` may run when EDA was skipped (e.g. no warehouse available).
  ["eda", "planning"],
  // Delivery packages the PR and the ticket update in one run, so `pr` (and
  // `ship`) finalize directly from `ready_for_pr`.
  ["ready_for_pr", "shipped"],
  // `ship` may finalize a blocked workflow when `known_limitations.md`
  // documents the exceptions (the ship command enforces that guard).
  ["blocked", "shipped"],
];

/**
 * Whether a transition from `from` to `to` is allowed.
 *
 * Allowed transitions:
 *  - the default linear successor
 *  - a deliberate exception from {@link EXTRA_TRANSITIONS}
 *  - any non-terminal state → `blocked`
 *  - `blocked` → any non-terminal state (resume after unblocking)
 */
export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return false;
  if (LINEAR_NEXT[from] === to) return true;
  if (EXTRA_TRANSITIONS.some(([f, t]) => f === from && t === to)) return true;

  const isTerminal = (s: WorkflowState): boolean =>
    s === "shipped" || s === "blocked";

  if (to === "blocked" && from !== "shipped") return true;
  if (from === "blocked" && !isTerminal(to)) return true;

  return false;
}

/**
 * Error thrown when a phase change violates {@link canTransition}. Carrying
 * the endpoints lets callers render a precise, loud rejection.
 */
export class WorkflowTransitionError extends Error {
  constructor(
    readonly from: WorkflowState,
    readonly to: WorkflowState,
  ) {
    super(
      `Illegal workflow transition '${from}' → '${to}'. Allowed: the linear ` +
        `successor, a deliberate exception, any non-terminal state → 'blocked', ` +
        `or 'blocked' → a non-terminal state (resume).`,
    );
    this.name = "WorkflowTransitionError";
  }
}

/**
 * Assert that moving the workflow from `from` into `to` is legal: either an
 * idempotent same-phase re-run or a move {@link canTransition} allows. Throws
 * a {@link WorkflowTransitionError} otherwise.
 *
 * Commands call this BEFORE doing any work (pre-flight) so an out-of-order
 * invocation refuses loudly without committing side effects — external posts,
 * project-tree writes, artifact archival all stay untouched. `advanceWorkflow`
 * applies the same assertion again as the backstop.
 */
export function assertLegalTransition(
  from: WorkflowState,
  to: WorkflowState,
): void {
  if (to !== from && !canTransition(from, to)) {
    throw new WorkflowTransitionError(from, to);
  }
}

/**
 * Recommend the CLI command a user should run next from a given state.
 * Returns a human-friendly sentinel for terminal states.
 */
export function recommendNextCommand(state: WorkflowState): string | null {
  return COMMAND_FOR_STATE[state];
}
