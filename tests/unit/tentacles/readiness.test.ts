import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext } from "../../../src/tentacles/base.js";
import { intakeTentacle } from "../../../src/tentacles/intake/index.js";
import { clarificationTentacle } from "../../../src/tentacles/clarification/index.js";
import {
  scoreReadiness,
  buildMissingInfoQuestions,
  READINESS_DIMENSIONS,
  type ReadinessSignals,
} from "../../../src/tentacles/intake/readiness.js";
import {
  detectGrainDeclaration,
  detectVagueTerms,
} from "../../../src/tentacles/intake/parse.js";
import { runTentacleCommand } from "../../../src/cli/commands/_run.js";
import { MockTicketProvider } from "../../../src/tools/index.js";
import { parseConfig } from "../../../src/core/config/index.js";
import { readState } from "../../../src/core/state/index.js";
import { fixedClock } from "../../../src/utils/time.js";

const CLOCK = fixedClock("2026-06-22T00:00:00.000Z");
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-readiness-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function cfg() {
  return parseConfig({ project: { name: "demo" } });
}

/** Config with the readiness gate armed at `min` (0..1). */
function gatedCfg(min: number, extraPolicies: Record<string, unknown> = {}) {
  return parseConfig({
    project: { name: "demo" },
    policies: { readiness: { min_score: min }, ...extraPolicies },
  });
}

const GOOD_TICKET = `# Build a daily active customers model

## Background
Finance needs a daily report of active customers sourced from Salesforce and Stripe.
Requested by: @jane.doe and the RevOps team.

## Requirements
- Produce a dbt model fct_daily_active_customers
- Grain: one row per customer per day
- Read from salesforce.accounts and stripe.charges

## Acceptance criteria
- [ ] Model builds cleanly in the sandbox
- [ ] Row count matches the legacy report within 1%

## Due date
- by 2026-07-15
`;

const SPARSE_TICKET = `# Make a churn dashboard

We want to see churn for our top customers.
`;

async function writeFixture(content: string): Promise<string> {
  const dir = await makeTmpDir();
  const file = path.join(dir, "ticket.md");
  await fs.writeFile(file, content, "utf8");
  return file;
}

/** Run intake into a fresh root, returning the root for downstream runs. */
async function seedIntake(content: string, ticketId: string): Promise<string> {
  const root = await makeTmpDir();
  const fixture = await writeFixture(content);
  const ctx = await buildContext({
    projectRoot: root,
    config: cfg(),
    clock: CLOCK,
    initStateIfMissing: true,
    ticketId,
    options: { fromFile: fixture },
  });
  await intakeTentacle.run(ctx);
  return root;
}

const FULL_SIGNALS: ReadinessSignals = {
  grain: "one row per customer per day",
  sourceSystems: ["salesforce", "stripe"],
  acceptanceCriteria: ["builds cleanly"],
  targets: ["fct_daily_active_customers"],
  stakeholders: ["@jane.doe"],
  undefinedTerms: [],
  dueDate: "2026-07-15",
};

const EMPTY_SIGNALS: ReadinessSignals = {
  grain: null,
  sourceSystems: [],
  acceptanceCriteria: [],
  targets: [],
  stakeholders: [],
  undefinedTerms: [],
  dueDate: null,
};

// ---------------------------------------------------------------------------
// Pure scoring unit tests (no I/O).
// ---------------------------------------------------------------------------

describe("readiness: scoreReadiness (pure)", () => {
  it("dimension weights sum to 1.0", () => {
    const total = READINESS_DIMENSIONS.reduce((s, d) => s + d.weight, 0);
    expect(Math.round(total * 100) / 100).toBe(1);
  });

  it("scores a fully-specified ticket at 1.0 with no failed dimensions", () => {
    const card = scoreReadiness(FULL_SIGNALS);
    expect(card.score).toBe(1);
    expect(card.failedDimensions).toEqual([]);
    expect(card.dimensions.every((d) => d.passed)).toBe(true);
  });

  it("scores a ticket with nothing declared and undefined terms at 0 with all seven dimensions failed", () => {
    const card = scoreReadiness({ ...EMPTY_SIGNALS, undefinedTerms: ["churn"] });
    expect(card.score).toBe(0);
    expect(card.failedDimensions).toEqual([
      "grain",
      "sources",
      "acceptance_criteria",
      "targets",
      "stakeholders",
      "metric_definitions",
      "due_date",
    ]);
  });

  it("passes metric_definitions on an empty ticket (no undefined terms used)", () => {
    const card = scoreReadiness(EMPTY_SIGNALS);
    expect(card.score).toBe(0.1);
    expect(card.failedDimensions).not.toContain("metric_definitions");
    expect(card.failedDimensions).toHaveLength(6);
  });

  it("sums only the weights of passing dimensions (deterministic rounding)", () => {
    const card = scoreReadiness({
      ...EMPTY_SIGNALS,
      grain: "one row per order",
      sourceSystems: ["stripe"],
      acceptanceCriteria: ["row counts match"],
    });
    // grain 0.2 + sources 0.2 + acceptance 0.25 + metric_definitions 0.1
    // (no undefined terms) = 0.75.
    expect(card.score).toBe(0.75);
    expect(card.failedDimensions).toEqual([
      "targets",
      "stakeholders",
      "due_date",
    ]);
  });

  it("fails metric_definitions when vague terms are undefined and names them", () => {
    const card = scoreReadiness({
      ...FULL_SIGNALS,
      undefinedTerms: ["churn", "top"],
    });
    const dim = card.dimensions.find((d) => d.id === "metric_definitions")!;
    expect(dim.passed).toBe(false);
    expect(dim.observed).toContain("churn");
    expect(dim.question).toContain("churn, top");
    expect(card.failedDimensions).toEqual(["metric_definitions"]);
  });

  it("carries the canonical missing-information question per dimension", () => {
    const card = scoreReadiness(EMPTY_SIGNALS);
    const grain = card.dimensions.find((d) => d.id === "grain")!;
    expect(grain.question).toBe("Grain not declared: one row per what?");
  });
});

describe("readiness: buildMissingInfoQuestions (pure)", () => {
  it("maps failed dimension ids to routed questions in canonical order", () => {
    const questions = buildMissingInfoQuestions(["due_date", "grain"]);
    expect(questions.map((q) => q.dimension)).toEqual(["grain", "due_date"]);
    expect(questions[0]!.question).toContain("one row per what?");
  });

  it("ignores unknown dimension ids (conservative)", () => {
    const questions = buildMissingInfoQuestions(["not_a_dimension", "grain"]);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.dimension).toBe("grain");
  });

  it("enriches the metric_definitions question with the undefined terms", () => {
    const questions = buildMissingInfoQuestions(["metric_definitions"], {
      undefinedTerms: ["revenue"],
    });
    expect(questions[0]!.question).toContain("revenue");
  });
});

describe("readiness: detectGrainDeclaration (pure)", () => {
  it("detects 'one row per <thing>' declarations", () => {
    expect(detectGrainDeclaration("Grain: one row per customer per day")).toBe(
      "one row per customer per day",
    );
    expect(detectGrainDeclaration("we need one record per order")).toBe(
      "one row per order",
    );
  });

  it("detects labeled 'grain: <phrase>' declarations", () => {
    expect(detectGrainDeclaration("The grain: daily customer snapshot")).toBe(
      "daily customer snapshot",
    );
  });

  it("returns null when no grain is declared", () => {
    expect(detectGrainDeclaration("We want to see churn.")).toBeNull();
  });
});

describe("readiness: detectVagueTerms (pure)", () => {
  it("returns the bare undefined terms in deterministic order", () => {
    expect(detectVagueTerms("churn for our top customers")).toEqual([
      "top",
      "churn",
    ]);
    expect(detectVagueTerms("one row per order")).toEqual([]);
  });
});

describe("readiness: config schema", () => {
  it("defaults policies.readiness.min_score to null (gating disabled)", () => {
    expect(cfg().policies.readiness.min_score).toBeNull();
  });

  it("accepts an explicit min_score in [0, 1]", () => {
    expect(gatedCfg(0.7).policies.readiness.min_score).toBe(0.7);
  });

  it("rejects out-of-range min_score values", () => {
    expect(() =>
      parseConfig({
        project: { name: "demo" },
        policies: { readiness: { min_score: 1.5 } },
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        project: { name: "demo" },
        policies: { readiness: { min_score: -0.1 } },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Intake: scorecard artifact + state recording + delta.
// ---------------------------------------------------------------------------

describe("readiness: intake scorecard", () => {
  it("writes readiness.md and records the score in state (informational)", async () => {
    const root = await makeTmpDir();
    const fixture = await writeFixture(GOOD_TICKET);
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      initStateIfMissing: true,
      ticketId: "DEMO-1",
      options: { fromFile: fixture },
    });
    const result = await intakeTentacle.run(ctx);

    // "active" and "churn" style terms: GOOD_TICKET uses "active" undefined,
    // so metric_definitions (weight 0.1) fails; everything else passes.
    expect(result.output?.readinessScore).toBe(0.9);
    expect(result.output?.readinessFailedDimensions).toEqual([
      "metric_definitions",
    ]);
    expect(result.output?.readinessDelta).toBeNull();

    const card = await ctx.artifacts.read("readiness.md");
    expect(card).toContain("# Readiness Scorecard:");
    expect(card).toContain("## Scorecard");
    expect(card).toContain("Grain declared");
    expect(card).toContain("one row per customer per day");
    expect(card).toContain("none — scorecard is informational only");

    const state = await readState(root);
    expect(state.requirements.readiness?.score).toBe(0.9);
    expect(state.requirements.readiness?.failed_dimensions).toEqual([
      "metric_definitions",
    ]);
    expect(state.requirements.readiness?.override).toBeNull();
    expect(state.artifacts.readiness).toBe("readiness.md");
    // Informational only: intake NEVER blocks on readiness.
    expect(state.status.phase).toBe("clarification");
  });

  it("scores a sparse ticket low with every dimension failed", async () => {
    const root = await makeTmpDir();
    const fixture = await writeFixture(SPARSE_TICKET);
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      initStateIfMissing: true,
      ticketId: "DEMO-2",
      options: { fromFile: fixture },
    });
    const result = await intakeTentacle.run(ctx);

    expect(result.output?.readinessScore).toBe(0);
    expect(result.output?.readinessFailedDimensions).toHaveLength(7);

    const card = await ctx.artifacts.read("readiness.md");
    expect(card).toContain("Grain not declared: one row per what?");
  });

  it("re-running intake re-scores and reports the readiness delta", async () => {
    const root = await makeTmpDir();
    const sparse = await writeFixture(SPARSE_TICKET);
    const first = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      initStateIfMissing: true,
      ticketId: "DEMO-3",
      options: { fromFile: sparse },
    });
    await intakeTentacle.run(first);

    // The ticket got improved; re-run intake in the same project.
    const good = await writeFixture(GOOD_TICKET);
    const second = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-3",
      options: { fromFile: good },
    });
    const result = await intakeTentacle.run(second);

    expect(result.output?.readinessDelta).toBe(0.9);
    expect(result.summary).toContain("Δ +90%");

    const card = await second.artifacts.read("readiness.md");
    expect(card).toContain("Previous score 0%");
    expect(card).toContain("(Δ +90%)");

    const state = await readState(root);
    expect(state.requirements.readiness?.score).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Clarification: the readiness gate.
// ---------------------------------------------------------------------------

describe("readiness gate: default behavior unchanged (no min_score)", () => {
  it("does not gate and drafts no missing-information request", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-10");
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-10",
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output?.readinessGate.configured).toBe(false);
    expect(result.output?.readinessGate.blocked).toBe(false);
    expect(result.output?.readinessGate.passed).toBe(true);
    expect(await ctx.artifacts.exists("missing_information_request.md")).toBe(
      false,
    );

    const state = await readState(root);
    expect(state.status.phase).toBe("context");
  });
});

describe("readiness gate: blocking below the configured threshold", () => {
  it("lands the workflow blocked and drafts the missing-information request", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-11");
    const ctx = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7),
      clock: CLOCK,
      ticketId: "DEMO-11",
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output?.readinessGate.configured).toBe(true);
    expect(result.output?.readinessGate.score).toBe(0);
    expect(result.output?.readinessGate.minScore).toBe(0.7);
    expect(result.output?.readinessGate.blocked).toBe(true);
    expect(result.output?.readinessGate.overridden).toBe(false);

    const state = await readState(root);
    expect(state.status.phase).toBe("blocked");
    expect(
      state.status.blockers.some((b) => /readiness gate failed/i.test(b)),
    ).toBe(true);
    expect(state.artifacts.missing_information_request).toBe(
      "missing_information_request.md",
    );

    // The request is keyed to the FAILED dimensions with pointed questions.
    const request = await ctx.artifacts.read("missing_information_request.md");
    expect(request).toContain("# Missing Information Request (DRAFT):");
    expect(request).toContain("Grain not declared: one row per what?");
    expect(request).toContain("## Requested Information");
    expect(request).toContain("**Posted:** no (draft)");
    expect(result.output?.missingInfoRequestPosted).toBe(false);
    expect(result.output?.commentPosted).toBe(false);
  });

  it("returns exit code 2 through the shared CLI runner", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-12");
    // Arm the gate via an on-disk oswald.yml (what resolveConfig reads).
    await fs.writeFile(
      path.join(root, "oswald.yml"),
      "project:\n  name: demo\npolicies:\n  readiness:\n    min_score: 0.7\n",
      "utf8",
    );
    const outcome = await runTentacleCommand({
      id: "clarification",
      command: "clarify",
      cwd: root,
      ticketId: "DEMO-12",
      options: { reason: "clarify CLI" },
    });
    expect(outcome.exitCode).toBe(2);
  });

  it("passes the gate when the recorded score meets the threshold", async () => {
    const root = await seedIntake(GOOD_TICKET, "DEMO-13");
    const ctx = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7),
      clock: CLOCK,
      ticketId: "DEMO-13",
    });
    const result = await clarificationTentacle.run(ctx);

    // GOOD_TICKET scores 0.9 ≥ 0.7 → no gating, no request drafted.
    expect(result.output?.readinessGate.passed).toBe(true);
    expect(result.output?.readinessGate.blocked).toBe(false);
    expect(await ctx.artifacts.exists("missing_information_request.md")).toBe(
      false,
    );
    const state = await readState(root);
    expect(state.status.phase).toBe("context");
  });

  it("warns and proceeds ungated when gating is configured but intake never scored", async () => {
    const root = await makeTmpDir();
    // Degraded clarification run: no intake artifacts, no recorded readiness.
    const ctx = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7),
      clock: CLOCK,
      initStateIfMissing: true,
      ticketId: "DEMO-14",
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output?.readinessGate.configured).toBe(true);
    expect(result.output?.readinessGate.score).toBeNull();
    expect(result.output?.readinessGate.blocked).toBe(false);
    expect(
      result.warnings?.some((w) => /no readiness score is recorded/i.test(w)),
    ).toBe(true);
    const state = await readState(root);
    expect(state.status.phase).toBe("context");
  });
});

describe("readiness gate: human override (recorded decision)", () => {
  it("proceeds under --override-readiness and records the decision", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-20");
    const ctx = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7),
      clock: CLOCK,
      ticketId: "DEMO-20",
      options: { overrideReadiness: "PM confirmed scope verbally" },
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output?.readinessGate.blocked).toBe(false);
    expect(result.output?.readinessGate.overridden).toBe(true);
    expect(result.warnings?.some((w) => /human override/i.test(w))).toBe(true);

    // The pipeline proceeds; the override is recorded in state + decision log.
    const state = await readState(root);
    expect(state.status.phase).toBe("context");
    expect(state.requirements.readiness?.override?.reason).toBe(
      "PM confirmed scope verbally",
    );
    expect(state.requirements.readiness?.override?.at).toBe(
      "2026-06-22T00:00:00.000Z",
    );

    const log = await ctx.artifacts.read("decision_log.md");
    expect(log).toContain("# Decision Log");
    expect(log).toContain("clarify (readiness override)");
    expect(log).toContain("PM confirmed scope verbally");

    // The missing-information request is still drafted for the gaps.
    expect(await ctx.artifacts.exists("missing_information_request.md")).toBe(
      true,
    );
  });

  it("honors a previously recorded override on re-runs (until intake re-scores)", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-21");
    const first = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7),
      clock: CLOCK,
      ticketId: "DEMO-21",
      options: { overrideReadiness: "approved by data lead" },
    });
    await clarificationTentacle.run(first);

    // Re-run WITHOUT the flag: the recorded override still lets it pass.
    const second = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7),
      clock: CLOCK,
      ticketId: "DEMO-21",
    });
    const result = await clarificationTentacle.run(second);
    expect(result.output?.readinessGate.blocked).toBe(false);
    expect(result.output?.readinessGate.overridden).toBe(true);
    expect(
      result.warnings?.some((w) => /override recorded at/i.test(w)),
    ).toBe(true);
  });

  it("re-running intake re-scores and clears a recorded override", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-22");
    const clarifyCtx = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7),
      clock: CLOCK,
      ticketId: "DEMO-22",
      options: { overrideReadiness: "urgent exec ask" },
    });
    await clarificationTentacle.run(clarifyCtx);
    expect(
      (await readState(root)).requirements.readiness?.override,
    ).not.toBeNull();

    const fixture = await writeFixture(SPARSE_TICKET);
    const intakeCtx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-22",
      options: { fromFile: fixture },
    });
    await intakeTentacle.run(intakeCtx);
    expect((await readState(root)).requirements.readiness?.override).toBeNull();
  });
});

describe("readiness gate: posting the missing-information request (default-deny)", () => {
  it("posts the request only with explicit yes + permitting policy", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-30");
    const fixture = await writeFixture(SPARSE_TICKET);
    const provider = new MockTicketProvider({ fixturePath: fixture });

    const ctx = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7),
      clock: CLOCK,
      ticketId: "DEMO-30",
      providers: { ticket: provider },
      options: { yes: true, reason: "approved by analyst" },
    });
    const result = await clarificationTentacle.run(ctx);

    // Posting rides the existing ticket_update approval gate.
    expect(result.output?.missingInfoRequestPosted).toBe(true);
    const request = await ctx.artifacts.read("missing_information_request.md");
    expect(request).toContain("**Posted:** yes");
    // Posting does not unblock the gate: the workflow still lands blocked.
    expect((await readState(root)).status.phase).toBe("blocked");
  });

  it("never posts when ticket_update is prohibited, even with yes", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-31");
    const fixture = await writeFixture(SPARSE_TICKET);
    const provider = new MockTicketProvider({ fixturePath: fixture });

    const ctx = await buildContext({
      projectRoot: root,
      config: gatedCfg(0.7, { prohibit: ["ticket_update"] }),
      clock: CLOCK,
      ticketId: "DEMO-31",
      providers: { ticket: provider },
      options: { yes: true, reason: "attempted post" },
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output?.commentPosted).toBe(false);
    expect(result.output?.missingInfoRequestPosted).toBe(false);
    const request = await ctx.artifacts.read("missing_information_request.md");
    expect(request).toContain("**Posted:** no (draft)");
  });
});
