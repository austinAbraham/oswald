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

describe("ApprovalService: policy-granted consent (policies.autonomy)", () => {
  const svc = new ApprovalService();
  const autoSafe: ApprovalPolicy = {
    requireApprovalFor: ["ticket_update", "open_pull_request"],
    prohibit: ["direct_push_to_protected_branch"],
    autonomyLevel: "auto_safe",
    autoApprove: ["commit", "ticket_update"],
  };

  it("auto-approves a listed action when no explicit signal is given", () => {
    const r = svc.requireApproval("commit", { policy: autoSafe });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe("allowed");
    expect(r.consentSource).toBe("policy");
    expect(r.reason).toMatch(/auto-approved by policy: autonomy\.auto_approve/);
  });

  it("auto-approval satisfies the require_approval_for gate", () => {
    const r = svc.requireApproval("ticket_update", { policy: autoSafe });
    expect(r.allowed).toBe(true);
    expect(r.consentSource).toBe("policy");
  });

  it("denies actions not in the auto_approve list", () => {
    const r = svc.requireApproval("open_pull_request", { policy: autoSafe });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("denied");
    expect(r.consentSource).toBe("none");
  });

  it("accepts config aliases in auto_approve", () => {
    const p: ApprovalPolicy = {
      requireApprovalFor: [],
      prohibit: [],
      autonomyLevel: "auto_safe",
      autoApprove: ["pr_open"],
    };
    const r = svc.requireApproval("open_pull_request", { policy: p });
    expect(r.allowed).toBe(true);
    expect(r.consentSource).toBe("policy");
  });

  it("ignores auto_approve entirely at level draft_only", () => {
    const p: ApprovalPolicy = {
      requireApprovalFor: [],
      prohibit: [],
      autonomyLevel: "draft_only",
      autoApprove: ["commit"],
    };
    const r = svc.requireApproval("commit", { policy: p });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("denied");
  });

  it("ignores auto_approve when no autonomy level is set", () => {
    const p: ApprovalPolicy = {
      requireApprovalFor: [],
      prohibit: [],
      autoApprove: ["commit"],
    };
    expect(svc.requireApproval("commit", { policy: p }).allowed).toBe(false);
  });

  it("never auto-approves a prohibited action (prohibit is absolute)", () => {
    const p: ApprovalPolicy = {
      requireApprovalFor: [],
      prohibit: ["direct_push_to_protected_branch"],
      autonomyLevel: "auto_safe",
      autoApprove: ["push"],
    };
    const r = svc.requireApproval("push", { policy: p });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("prohibited");
    expect(r.consentSource).toBe("none");
  });

  it("hard floor: never auto-approves push even when prohibit has been emptied", () => {
    const p: ApprovalPolicy = {
      requireApprovalFor: [],
      prohibit: [],
      autonomyLevel: "auto_safe",
      autoApprove: ["push"],
    };
    const r = svc.requireApproval("push", { policy: p });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("denied");
    expect(r.consentSource).toBe("none");
    expect(r.reason).toMatch(/hard floor/);
  });

  it("hard floor covers the direct_push_to_protected_branch alias in auto_approve", () => {
    const p: ApprovalPolicy = {
      requireApprovalFor: [],
      prohibit: [],
      autonomyLevel: "auto_safe",
      autoApprove: ["direct_push_to_protected_branch"],
    };
    const r = svc.requireApproval("push", { policy: p });
    expect(r.allowed).toBe(false);
    expect(r.consentSource).toBe("none");
  });

  it("hard floor does not block explicit flag consent for a non-prohibited push", () => {
    const p: ApprovalPolicy = {
      requireApprovalFor: [],
      prohibit: [],
      autonomyLevel: "auto_safe",
      autoApprove: [],
    };
    const r = svc.requireApproval("push", { yes: true, policy: p });
    expect(r.allowed).toBe(true);
    expect(r.consentSource).toBe("flag");
  });

  it("treats an explicit yes=false as a decline that blocks policy consent", () => {
    const r = svc.requireApproval("commit", { yes: false, policy: autoSafe });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("denied");
    expect(r.consentSource).toBe("none");
  });

  it("records consent from an explicit flag as source 'flag'", () => {
    const r = svc.requireApproval("commit", { yes: true, policy: autoSafe });
    expect(r.allowed).toBe(true);
    expect(r.consentSource).toBe("flag");
  });
});

describe("ApprovalService: draft always forces draft-only", () => {
  const svc = new ApprovalService();
  const autoSafe: ApprovalPolicy = {
    requireApprovalFor: [],
    prohibit: [],
    autonomyLevel: "auto_safe",
    autoApprove: ["commit"],
  };

  it("draft vetoes policy-granted consent", () => {
    const r = svc.requireApproval("commit", { draft: true, policy: autoSafe });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("denied");
    expect(r.reason).toMatch(/draft-only/);
  });

  it("draft vetoes an explicit yes", () => {
    const r = svc.requireApproval("commit", {
      yes: true,
      draft: true,
      policy: autoSafe,
    });
    expect(r.allowed).toBe(false);
    expect(r.consentSource).toBe("none");
  });

  it("a prohibited action still reports as prohibited under draft", () => {
    const p: ApprovalPolicy = {
      requireApprovalFor: [],
      prohibit: ["direct_push_to_protected_branch"],
    };
    const r = svc.requireApproval("push", { draft: true, policy: p });
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

describe("ApprovalService: decision log", () => {
  it("records every decision in call order", () => {
    const svc = new ApprovalService();
    svc.requireApproval("ticket_update", { policy });
    svc.requireApproval("open_pull_request", { yes: true, policy });
    svc.requireApproval("push", {
      yes: true,
      policy: { requireApprovalFor: [], prohibit: ["push"] },
    });

    const decisions = svc.decisions();
    expect(decisions.map((d) => d.action)).toEqual([
      "ticket_update",
      "open_pull_request",
      "push",
    ]);
    expect(decisions.map((d) => d.decision)).toEqual([
      "denied",
      "allowed",
      "prohibited",
    ]);
  });

  it("returns a snapshot, not a live view", () => {
    const svc = new ApprovalService();
    svc.requireApproval("commit", { policy });
    const snapshot = svc.decisions();
    svc.requireApproval("commit", { yes: true, policy });
    expect(snapshot).toHaveLength(1);
    expect(svc.decisions()).toHaveLength(2);
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
    expect(p.autonomyLevel).toBeUndefined();
    expect(p.autoApprove).toBeUndefined();
  });

  it("policyFromConfig maps the autonomy block when present", () => {
    const p = policyFromConfig({
      require_approval_for: [],
      prohibit: [],
      autonomy: { level: "auto_safe", auto_approve: ["commit"] },
    });
    expect(p.autonomyLevel).toBe("auto_safe");
    expect(p.autoApprove).toEqual(["commit"]);
  });
});
