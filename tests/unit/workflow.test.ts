import { describe, it, expect } from "vitest";
import {
  WORKFLOW_STATES,
  isWorkflowState,
  nextState,
  canTransition,
  recommendNextCommand,
} from "../../src/core/workflow/index.js";

describe("workflow: state guards", () => {
  it("recognizes valid states", () => {
    expect(isWorkflowState("intake")).toBe(true);
    expect(isWorkflowState("ready_for_pr")).toBe(true);
    expect(isWorkflowState("bogus")).toBe(false);
  });
});

describe("workflow: linear progression", () => {
  it("walks the full happy path uninitialized → shipped", () => {
    const visited: string[] = [];
    let cur: ReturnType<typeof nextState> = "uninitialized";
    while (cur) {
      visited.push(cur);
      cur = nextState(cur);
    }
    expect(visited[0]).toBe("uninitialized");
    expect(visited[visited.length - 1]).toBe("shipped");
    expect(visited).toContain("eda");
    expect(visited).toContain("validating");
  });

  it("terminal states have no successor", () => {
    expect(nextState("shipped")).toBeNull();
    expect(nextState("blocked")).toBeNull();
  });
});

describe("workflow: canTransition", () => {
  it("allows the default linear successor", () => {
    expect(canTransition("intake", "clarification")).toBe(true);
    expect(canTransition("validating", "ready_for_pr")).toBe(true);
  });

  it("rejects skipping ahead", () => {
    expect(canTransition("intake", "building")).toBe(false);
    expect(canTransition("uninitialized", "shipped")).toBe(false);
  });

  it("rejects self-transition", () => {
    expect(canTransition("eda", "eda")).toBe(false);
  });

  it("allows any non-terminal state to block", () => {
    expect(canTransition("eda", "blocked")).toBe(true);
    expect(canTransition("shipped", "blocked")).toBe(false);
  });

  it("allows resuming from blocked into a non-terminal state", () => {
    expect(canTransition("blocked", "eda")).toBe(true);
    expect(canTransition("blocked", "blocked")).toBe(false);
  });

  it("allows intake to bootstrap a fresh project through the intake phase", () => {
    expect(canTransition("uninitialized", "clarification")).toBe(true);
  });

  it("allows skipping the optional clarification and eda phases", () => {
    expect(canTransition("clarification", "eda")).toBe(true);
    expect(canTransition("eda", "planning")).toBe(true);
  });

  it("allows delivery/ship to finalize straight from ready_for_pr", () => {
    expect(canTransition("ready_for_pr", "shipped")).toBe(true);
  });

  it("allows ship to finalize a blocked workflow (documented exceptions)", () => {
    expect(canTransition("blocked", "shipped")).toBe(true);
  });

  it("rejects other non-linear jumps despite the deliberate exceptions", () => {
    expect(canTransition("uninitialized", "context")).toBe(false);
    expect(canTransition("clarification", "design")).toBe(false);
    expect(canTransition("context", "design")).toBe(false);
    expect(canTransition("validating", "shipped")).toBe(false);
  });
});

describe("workflow: recommendNextCommand", () => {
  it("maps states to commands", () => {
    expect(recommendNextCommand("uninitialized")).toBe("init");
    expect(recommendNextCommand("intake")).toBe("intake");
    expect(recommendNextCommand("ready_for_pr")).toBe("pr");
    expect(recommendNextCommand("ready_for_ticket_update")).toBe("update-ticket");
  });

  it("returns null for terminal states", () => {
    expect(recommendNextCommand("shipped")).toBeNull();
    expect(recommendNextCommand("blocked")).toBeNull();
  });

  it("every state has a defined command mapping", () => {
    for (const s of WORKFLOW_STATES) {
      expect(recommendNextCommand(s)).not.toBeUndefined();
    }
  });
});
