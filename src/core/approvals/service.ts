/**
 * Approval service — the human-in-the-loop gate for every side-effecting action.
 *
 * Oswald's safety posture is DEFAULT-DENY for writes. A write only proceeds when
 * BOTH conditions hold:
 *   1. consent is supplied — either an explicit `yes` from the caller (e.g. a
 *      `--yes` flag, never a default) or, for callers that pass no explicit
 *      signal at all, a policy grant via `policies.autonomy` (level
 *      `auto_safe` + the action listed in `auto_approve`), AND
 *   2. the configured policy permits that action class
 *      (`config.policies.require_approval_for` lists actions that are *gated*;
 *      `config.policies.prohibit` lists actions that are *never* allowed).
 *
 * Policy-granted consent is deliberately the weakest source: it applies only
 * when the caller expressed no explicit signal (`yes` undefined), an explicit
 * `yes: false` (what `--draft` collapses to) or `draft: true` always vetoes it,
 * and the `prohibit` list beats it unconditionally.
 *
 * In non-interactive / test mode there is no prompt: absent consent from a flag
 * or the policy, the action is denied. This keeps tests deterministic and makes
 * the autonomous runtime safe by construction.
 *
 * When constructed with an {@link AuditSink}, every decision — allowed, denied,
 * or prohibited — is appended to the persistent audit ledger (fail-open: audit
 * writes never affect the decision or crash the caller).
 */
import type { AuditSink } from "../audit/ledger.js";

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

/**
 * How much consent the policy itself may grant. `draft_only` (the default)
 * grants nothing — `autoApprove` is ignored. `auto_safe` lets the policy
 * consent to the actions listed in `autoApprove`, never overriding `prohibit`.
 */
export type AutonomyLevel = "draft_only" | "auto_safe";

export interface ApprovalPolicy {
  /** Actions that require explicit approval to proceed (the gated set). */
  requireApprovalFor: string[];
  /** Actions that are categorically prohibited regardless of approval. */
  prohibit: string[];
  /** Autonomy tier. Absent means `draft_only` (policy grants no consent). */
  autonomyLevel?: AutonomyLevel;
  /**
   * Action classes the policy consents to when `autonomyLevel` is
   * `auto_safe`. Same vocabulary/aliases as the other two lists. Ignored at
   * `draft_only`; never beats `prohibit`.
   */
  autoApprove?: string[];
}

export interface RequireApprovalOptions {
  /**
   * Explicit caller consent. `true` allows; `false` is an explicit decline
   * (what `--draft` collapses to via `resolveConsent`) and also blocks
   * policy-granted consent; `undefined` means "no explicit signal", letting
   * the policy speak.
   */
  yes?: boolean;
  /**
   * Force draft-only: vetoes every consent source, including an explicit
   * `yes` and policy auto-approval. Mirrors the `--draft` flag.
   */
  draft?: boolean;
  /** The active policy (from config). */
  policy: ApprovalPolicy;
  /** Optional human-readable context for the audit trail. */
  reason?: string;
}

export type ApprovalDecision = "allowed" | "denied" | "prohibited";

/** Where the consent behind a decision came from (`none` when not allowed). */
export type ConsentSource = "flag" | "policy" | "none";

export interface ApprovalResult {
  action: ApprovalAction;
  decision: ApprovalDecision;
  allowed: boolean;
  /** Why the decision was made. */
  reason: string;
  /** Whether consent came from an explicit flag or the autonomy policy. */
  consentSource: ConsentSource;
}

function matchesAny(action: ApprovalAction, list: string[]): boolean {
  const aliases = ACTION_ALIASES[action];
  const set = new Set(list.map((s) => s.toLowerCase().trim()));
  return aliases.some((a) => set.has(a)) || set.has(action);
}

/**
 * Whether the policy explicitly gates an action (`require_approval_for`),
 * matching either vocabulary via the alias table. Read-only introspection for
 * explain/teach output — the enforcement path is `requireApproval` below.
 */
export function isActionGated(
  action: ApprovalAction,
  policy: ApprovalPolicy,
): boolean {
  return matchesAny(action, policy.requireApprovalFor);
}

/**
 * Whether the policy prohibits an action outright (`prohibit`), matching either
 * vocabulary via the alias table. Read-only introspection for explain/teach
 * output — the enforcement path is `requireApproval` below.
 */
export function isActionProhibited(
  action: ApprovalAction,
  policy: ApprovalPolicy,
): boolean {
  return matchesAny(action, policy.prohibit);
}

/**
 * Decide whether a side-effecting action may proceed.
 *
 * Decision table (top wins):
 *  - prohibited list match → `prohibited` (never allowed — beats every consent
 *    source, including autonomy auto-approval)
 *  - `draft: true` → `denied` (draft-only vetoes flags AND policy consent)
 *  - explicit `yes: true` → `allowed` (consent source `flag`)
 *  - explicit `yes: false` → `denied` (an explicit decline — what `--draft`
 *    collapses to — blocks policy-granted consent too)
 *  - no explicit signal + autonomy level `auto_safe` + action in
 *    `auto_approve` → `allowed` (consent source `policy`) — EXCEPT `push`,
 *    which has a hard floor: it can never receive policy consent, even with
 *    an emptied `prohibit` list (protected-branch pushes stay human-only)
 *  - otherwise → `denied`: we DEFAULT-DENY any side-effecting action without
 *    consent, even if the policy did not list it. (Fail closed.)
 */
export interface ApprovalServiceOptions {
  /** Optional audit sink; every decision is recorded when present. */
  audit?: AuditSink;
  /** Ticket id decisions are attributed to in the audit trail, when known. */
  ticketId?: string;
}

export class ApprovalService {
  private readonly audit: AuditSink | undefined;
  private readonly ticketId: string | undefined;

  constructor(options: ApprovalServiceOptions = {}) {
    this.audit = options.audit;
    this.ticketId = options.ticketId;
  }

  requireApproval(
    action: ApprovalAction,
    options: RequireApprovalOptions,
  ): ApprovalResult {
    const { yes, draft, policy } = options;
    const isGated = matchesAny(action, policy.requireApprovalFor);

    let result: ApprovalResult;
    if (matchesAny(action, policy.prohibit)) {
      result = {
        action,
        decision: "prohibited",
        allowed: false,
        reason: `Action '${action}' is prohibited by policy (policies.prohibit).`,
        consentSource: "none",
      };
    } else if (draft === true) {
      result = {
        action,
        decision: "denied",
        allowed: false,
        reason: `Action '${action}' is draft-only for this run (--draft); consent withheld regardless of policy.`,
        consentSource: "none",
      };
    } else if (yes === true) {
      result = {
        action,
        decision: "allowed",
        allowed: true,
        reason: isGated
          ? `Action '${action}' approved with explicit consent.`
          : `Action '${action}' permitted with explicit consent (not separately gated).`,
        consentSource: "flag",
      };
    } else if (
      yes === undefined &&
      policy.autonomyLevel === "auto_safe" &&
      matchesAny(action, policy.autoApprove ?? [])
    ) {
      if (action === "push") {
        result = {
          action,
          decision: "denied",
          allowed: false,
          reason:
            "Action 'push' can never be auto-approved by policy (hard floor): " +
            "pushes require explicit consent regardless of autonomy.auto_approve.",
          consentSource: "none",
        };
      } else {
        result = {
          action,
          decision: "allowed",
          allowed: true,
          reason: `Action '${action}' auto-approved by policy: autonomy.auto_approve (level 'auto_safe').`,
          consentSource: "policy",
        };
      }
    } else {
      result = {
        action,
        decision: "denied",
        allowed: false,
        reason: isGated
          ? `Action '${action}' requires approval; no explicit consent supplied (default-deny).`
          : `Action '${action}' is a side-effecting write; explicit consent required (default-deny).`,
        consentSource: "none",
      };
    }

    this.audit?.record("approval_decision", {
      action,
      decision: result.decision,
      allowed: result.allowed,
      // The consent the caller OFFERED (an explicit flag is recorded even when
      // the decision is prohibited/denied — "pushed with --yes but refused" is
      // exactly what an audit reviewer needs to see).
      consent:
        yes === true
          ? "explicit_flag"
          : result.consentSource === "policy"
            ? "policy"
            : "none",
      policy_gate:
        result.decision === "prohibited"
          ? "prohibited"
          : isGated
            ? "gated"
            : "ungated",
      reason: result.reason,
      ...(options.reason ? { context: options.reason } : {}),
      ...(this.ticketId ? { ticket: this.ticketId } : {}),
    });

    return result;
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
  autonomy?: { level: AutonomyLevel; auto_approve: string[] };
}): ApprovalPolicy {
  return {
    requireApprovalFor: policies.require_approval_for,
    prohibit: policies.prohibit,
    ...(policies.autonomy
      ? {
          autonomyLevel: policies.autonomy.level,
          autoApprove: policies.autonomy.auto_approve,
        }
      : {}),
  };
}
