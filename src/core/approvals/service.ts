/**
 * Approval service — the human-in-the-loop gate for every side-effecting action.
 *
 * Oswald's safety posture is DEFAULT-DENY for writes. A write only proceeds when
 * BOTH conditions hold:
 *   1. an explicit `yes` is supplied by the caller (e.g. a `--yes` flag, never a
 *      default), AND
 *   2. the configured policy permits that action class
 *      (`config.policies.require_approval_for` lists actions that are *gated*;
 *      `config.policies.prohibit` lists actions that are *never* allowed).
 *
 * In non-interactive / test mode there is no prompt: absent an explicit `yes`,
 * the action is denied. This keeps tests deterministic and makes the autonomous
 * runtime safe by construction.
 */

/** The fixed set of side-effecting action classes Oswald can gate. */
export const APPROVAL_ACTIONS = [
  "ticket_update",
  "create_ticket",
  "create_branch",
  "commit",
  "push",
  "open_pull_request",
  "execute_write_sql",
  "write_external_document",
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export function isApprovalAction(value: string): value is ApprovalAction {
  return (APPROVAL_ACTIONS as readonly string[]).includes(value);
}

/**
 * Maps spec-level action names to the looser action labels that may appear in a
 * config's `require_approval_for` / `prohibit` lists, so either vocabulary works.
 */
const ACTION_ALIASES: Record<ApprovalAction, string[]> = {
  ticket_update: ["ticket_update", "update_ticket"],
  create_ticket: ["create_ticket"],
  create_branch: ["create_branch", "branch"],
  commit: ["commit"],
  push: ["push", "direct_push_to_protected_branch"],
  open_pull_request: ["open_pull_request", "pr_open", "open_pr", "pull_request"],
  execute_write_sql: ["execute_write_sql", "warehouse_write"],
  write_external_document: ["write_external_document", "external_document"],
};

export interface ApprovalPolicy {
  /** Actions that require explicit approval to proceed (the gated set). */
  requireApprovalFor: string[];
  /** Actions that are categorically prohibited regardless of approval. */
  prohibit: string[];
}

export interface RequireApprovalOptions {
  /** Explicit caller consent. Must be literally true to allow a write. */
  yes?: boolean;
  /** The active policy (from config). */
  policy: ApprovalPolicy;
  /** Optional human-readable context for the audit trail. */
  reason?: string;
}

export type ApprovalDecision = "allowed" | "denied" | "prohibited";

export interface ApprovalResult {
  action: ApprovalAction;
  decision: ApprovalDecision;
  allowed: boolean;
  /** Why the decision was made. */
  reason: string;
}

function matchesAny(action: ApprovalAction, list: string[]): boolean {
  const aliases = ACTION_ALIASES[action];
  const set = new Set(list.map((s) => s.toLowerCase().trim()));
  return aliases.some((a) => set.has(a)) || set.has(action);
}

/**
 * Decide whether a side-effecting action may proceed.
 *
 * Decision table:
 *  - prohibited list match → `prohibited` (never allowed)
 *  - gated by policy and no explicit `yes` → `denied`
 *  - gated by policy and explicit `yes` → `allowed`
 *  - not gated (not in require_approval_for) → still requires `yes` for writes:
 *    we DEFAULT-DENY any side-effecting action without explicit consent, even if
 *    the policy did not list it. (Fail closed.)
 */
export class ApprovalService {
  requireApproval(
    action: ApprovalAction,
    options: RequireApprovalOptions,
  ): ApprovalResult {
    const { yes, policy } = options;

    if (matchesAny(action, policy.prohibit)) {
      return {
        action,
        decision: "prohibited",
        allowed: false,
        reason: `Action '${action}' is prohibited by policy (policies.prohibit).`,
      };
    }

    const isGated = matchesAny(action, policy.requireApprovalFor);

    if (yes !== true) {
      return {
        action,
        decision: "denied",
        allowed: false,
        reason: isGated
          ? `Action '${action}' requires approval; no explicit consent supplied (default-deny).`
          : `Action '${action}' is a side-effecting write; explicit consent required (default-deny).`,
      };
    }

    return {
      action,
      decision: "allowed",
      allowed: true,
      reason: isGated
        ? `Action '${action}' approved with explicit consent.`
        : `Action '${action}' permitted with explicit consent (not separately gated).`,
    };
  }

  /** Convenience: throwing variant for call sites that want fail-fast. */
  assertApproved(
    action: ApprovalAction,
    options: RequireApprovalOptions,
  ): ApprovalResult {
    const result = this.requireApproval(action, options);
    if (!result.allowed) {
      throw new ApprovalDeniedError(result);
    }
    return result;
  }
}

export class ApprovalDeniedError extends Error {
  readonly result: ApprovalResult;
  constructor(result: ApprovalResult) {
    super(result.reason);
    this.name = "ApprovalDeniedError";
    this.result = result;
  }
}

/** Build an ApprovalPolicy from the config policies shape. */
export function policyFromConfig(policies: {
  require_approval_for: string[];
  prohibit: string[];
}): ApprovalPolicy {
  return {
    requireApprovalFor: policies.require_approval_for,
    prohibit: policies.prohibit,
  };
}
