import { describe, it, expect } from "vitest";
import {
  ApprovalService,
  ApprovalDeniedError,
  policyFromConfig,
  isApprovalAction,
  APPROVAL_ACTIONS,
  type ApprovalPolicy,
} from "../../src/core/approvals/index.js";

const policy: ApprovalPolicy = {
  requireApprovalFor: ["ticket_update", "open_pull_request", "execute_write_sql"],
  prohibit: ["direct_push_to_protected_branch"],
};

describe("ApprovalService: default-deny", () => {
  const svc = new ApprovalService();

  it("denies a gated write with no explicit yes", () => {
    const r = svc.requireApproval("ticket_update", { policy });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("denied");
  });

  it("denies even non-gated writes without yes (fail closed)", () => {
    const r = svc.requireApproval("commit", { policy });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("denied");
  });

  it("allows a gated write only with explicit yes AND policy permitting", () => {
    const r = svc.requireApproval("ticket_update", { yes: true, policy });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe("allowed");
  });

  it("treats yes=false the same as absent", () => {
    expect(svc.requireApproval("open_pull_request", { yes: false, policy }).allowed).toBe(false);
  });
});

describe("ApprovalService: prohibited actions", () => {
  const svc = new ApprovalService();
  it("never allows a prohibited action, even with yes", () => {
    const pushPolicy: ApprovalPolicy = {
      requireApprovalFor: ["push"],
      prohibit: ["direct_push_to_protected_branch"],
    };
    const r = svc.requireApproval("push", { yes: true, policy: pushPolicy });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("prohibited");
  });
});

describe("ApprovalService: action aliases", () => {
  const svc = new ApprovalService();
  it("maps config 'warehouse_write' to execute_write_sql", () => {
    const p: ApprovalPolicy = { requireApprovalFor: ["warehouse_write"], prohibit: [] };
    const r = svc.requireApproval("execute_write_sql", { yes: true, policy: p });
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/approved with explicit consent/);
  });
  it("maps config 'pr_open' to open_pull_request", () => {
    const p: ApprovalPolicy = { requireApprovalFor: ["pr_open"], prohibit: [] };
    expect(svc.requireApproval("open_pull_request", { policy: p }).reason).toMatch(/requires approval/);
  });
});

describe("ApprovalService: assertApproved", () => {
  const svc = new ApprovalService();
  it("throws ApprovalDeniedError when denied", () => {
    expect(() => svc.assertApproved("commit", { policy })).toThrow(ApprovalDeniedError);
  });
  it("returns the result when allowed", () => {
    const r = svc.assertApproved("ticket_update", { yes: true, policy });
    expect(r.allowed).toBe(true);
  });
});

describe("approval helpers", () => {
  it("isApprovalAction validates the closed set", () => {
    expect(isApprovalAction("commit")).toBe(true);
    expect(isApprovalAction("nope")).toBe(false);
    expect(APPROVAL_ACTIONS.length).toBe(8);
  });
  it("policyFromConfig maps config shape", () => {
    const p = policyFromConfig({
      require_approval_for: ["ticket_update"],
      prohibit: ["x"],
    });
    expect(p.requireApprovalFor).toEqual(["ticket_update"]);
    expect(p.prohibit).toEqual(["x"]);
  });
});
