import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildContext,
  advanceWorkflow,
  markEvidence,
  renderEvidenceTable,
  EVIDENCE_TAGS,
  type EvidenceItem,
} from "../../../src/tentacles/base.js";
import { parseConfig } from "../../../src/core/config/index.js";
import { readState } from "../../../src/core/state/index.js";
import { fixedClock } from "../../../src/utils/time.js";

const CLOCK = fixedClock("2026-06-22T00:00:00.000Z");
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-base-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function testConfig() {
  return parseConfig({ project: { name: "demo" } });
}

describe("markEvidence + renderEvidenceTable", () => {
  it("tags evidence with the agreed vocabulary", () => {
    const e = markEvidence("grain", "one row per order", "confirmed", "ticket-1");
    expect(e).toEqual({
      label: "grain",
      value: "one row per order",
      tag: "confirmed",
      source: "ticket-1",
    });
    expect(EVIDENCE_TAGS).toContain(e.tag);
  });

  it("omits source when not provided", () => {
    const e = markEvidence("metric", "revenue", "open_question");
    expect("source" in e).toBe(false);
  });

  it("renders a markdown table with tags as code spans", () => {
    const items: EvidenceItem[] = [
      markEvidence("grain", "per order", "confirmed", "t-1"),
      markEvidence("metric", "revenue", "open_question"),
    ];
    const md = renderEvidenceTable(items);
    expect(md).toContain("| Item | Value | Tag | Source |");
    expect(md).toContain("`confirmed`");
    expect(md).toContain("`open_question`");
    expect(md).toContain("per order");
  });

  it("escapes pipes and newlines in cells", () => {
    const md = renderEvidenceTable([
      markEvidence("x", "a | b\nc", "inferred"),
    ]);
    expect(md).toContain("a \\| b c");
  });

  it("handles an empty ledger", () => {
    expect(renderEvidenceTable([])).toBe("_No evidence recorded._");
  });
});

describe("buildContext", () => {
  it("assembles config, artifacts, policy, approvals and seeds state when missing", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
      ticketId: "DEMO-1",
    });

    expect(ctx.config.project.name).toBe("demo");
    expect(ctx.artifacts.root).toBe(path.resolve(root));
    expect(ctx.policy.sql.rowCap).toBe(10000);
    expect(ctx.policy.sanitizer.wrap("x", "test").wrapped).toContain("UNTRUSTED");
    expect(ctx.ticketId).toBe("DEMO-1");

    // State file should have been seeded on disk.
    const state = await readState(root);
    expect(state.project.name).toBe("demo");
    expect(state.ticket.id).toBe("DEMO-1");
  });

  it("throws when state is missing and initStateIfMissing is false", async () => {
    const root = await makeTmpDir();
    await expect(
      buildContext({ projectRoot: root, config: testConfig(), clock: CLOCK }),
    ).rejects.toThrow();
  });

  it("wires the sensitive detector from privacy config", async () => {
    const root = await makeTmpDir();
    const cfg = parseConfig({
      project: { name: "demo" },
      policies: { privacy: { mask_sensitive_values: false } },
    });
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg,
      clock: CLOCK,
      initStateIfMissing: true,
    });
    expect(ctx.policy.sensitive.enabled).toBe(false);
  });
});

describe("advanceWorkflow", () => {
  it("transitions phase, sets next command, and records artifacts", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });

    const next = await advanceWorkflow(ctx, {
      phase: "intake",
      lastCommand: "intake",
      artifacts: { intake: "intake.md" },
      requirements: { completeness: 0.5, acceptance_criteria_found: true },
    });

    expect(next.status.phase).toBe("intake");
    expect(next.status.last_command).toBe("intake");
    // recommendNextCommand maps a phase to the command that LEAVES it.
    expect(next.status.next_recommended_command).toBe("intake");
    expect(next.artifacts.intake).toBe("intake.md");
    expect(next.requirements.completeness).toBe(0.5);
    expect(next.requirements.acceptance_criteria_found).toBe(true);

    // Persisted to disk and ctx.state mutated in place.
    const onDisk = await readState(root);
    expect(onDisk.status.phase).toBe("intake");
    expect(ctx.state.status.phase).toBe("intake");
  });

  it("rejects an illegal transition loudly and leaves state untouched", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });

    await expect(
      advanceWorkflow(ctx, { phase: "building", lastCommand: "build" }),
    ).rejects.toThrow(/Illegal workflow transition 'uninitialized' → 'building'/);

    const onDisk = await readState(root);
    expect(onDisk.status.phase).toBe("uninitialized");
    expect(onDisk.status.last_command).toBeNull();
  });

  it("allows an idempotent re-run that stays in the current phase", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });
    await advanceWorkflow(ctx, { phase: "intake", lastCommand: "intake" });

    const next = await advanceWorkflow(ctx, {
      phase: "intake",
      lastCommand: "intake",
      artifacts: { intake: "intake.md" },
    });

    expect(next.status.phase).toBe("intake");
    expect(next.artifacts.intake).toBe("intake.md");
  });

  it("allows the deliberate uninitialized → clarification bootstrap", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });

    const next = await advanceWorkflow(ctx, {
      phase: "clarification",
      lastCommand: "intake",
    });

    expect(next.status.phase).toBe("clarification");
    expect(next.status.next_recommended_command).toBe("clarify");
  });

  it("allows blocking from any non-terminal phase and resuming out of it", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });
    await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockers: ["deferred checks"],
    });

    const resumed = await advanceWorkflow(ctx, {
      phase: "ready_for_pr",
      lastCommand: "validate",
      blockers: [],
    });

    expect(resumed.status.phase).toBe("ready_for_pr");
    expect(resumed.status.blockers).toEqual([]);
  });
});
