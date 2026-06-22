import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext } from "../../../src/tentacles/base.js";
import { intakeTentacle } from "../../../src/tentacles/intake/index.js";
import { clarificationTentacle } from "../../../src/tentacles/clarification/index.js";
import {
  buildQuestions,
  detectScopeRisks,
  recommendSplit,
  classifyQuestionPriority,
  groupByStakeholder,
  proposeAssumptions,
  detectAmbiguousTerms,
  type ScopeRiskInput,
} from "../../../src/tentacles/clarification/analyze.js";
import { MockTicketProvider } from "../../../src/tools/index.js";
import { parseConfig } from "../../../src/core/config/index.js";
import { readState } from "../../../src/core/state/index.js";
import { fixedClock } from "../../../src/utils/time.js";

const CLOCK = fixedClock("2026-06-22T00:00:00.000Z");
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-clarify-"));
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
- [ ] Each active customer has at least one charge in the period

## Dependencies
- Depends on STG-42 staging model

## Due date
- by 2026-07-15
`;

const SPARSE_TICKET = `# Make a churn dashboard

We want to see churn for our top customers.
`;

const OVERSIZED_TICKET = `# Build the full analytics platform

## Background
We need a comprehensive analytics layer across the whole business.

## Requirements
- Build fct_orders
- Build fct_payments
- Build dim_customers
- Build dim_products
- Build mart_revenue
- Build mart_marketing
- Build mart_finance
- Build mart_ops

## Data sources
- salesforce
- stripe
- shopify
- netsuite

## Acceptance criteria
- [ ] Everything works
`;

async function writeFixture(content: string): Promise<string> {
  const dir = await makeTmpDir();
  const file = path.join(dir, "ticket.md");
  await fs.writeFile(file, content, "utf8");
  return file;
}

/** Run intake into a fresh root, returning the root for a clarification run. */
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

// ---------------------------------------------------------------------------
// Pure-heuristic unit tests (no I/O).
// ---------------------------------------------------------------------------

describe("clarification heuristics: question triage", () => {
  it("classifies acceptance-criteria / source / grain questions as blocking", () => {
    expect(classifyQuestionPriority("Define the acceptance criteria")).toBe(
      "blocking",
    );
    expect(classifyQuestionPriority("What is the grain?")).toBe("blocking");
    expect(
      classifyQuestionPriority("Which source systems should we read?"),
    ).toBe("blocking");
  });

  it("classifies cosmetic questions as non-blocking", () => {
    expect(classifyQuestionPriority("What color should the dashboard be?")).toBe(
      "non_blocking",
    );
    expect(classifyQuestionPriority("Preferred model name?")).toBe(
      "non_blocking",
    );
  });

  it("builds blocking questions for missing acceptance / sources / requirements", () => {
    const questions = buildQuestions({
      openQuestions: [],
      ambiguousTerms: [],
      stakeholders: [],
      hasAcceptanceCriteria: false,
      sourceSystems: [],
      requirements: [],
    });
    const blocking = questions.filter((q) => q.priority === "blocking");
    expect(blocking.length).toBeGreaterThanOrEqual(3);
    expect(questions.some((q) => /acceptance criteria/i.test(q.text))).toBe(true);
    expect(questions.some((q) => /source systems/i.test(q.text))).toBe(true);
  });

  it("dedupes and sorts blocking before non-blocking", () => {
    const questions = buildQuestions({
      openQuestions: ["What color?", "What color?", "Define the grain"],
      ambiguousTerms: [],
      stakeholders: [],
      hasAcceptanceCriteria: true,
      sourceSystems: ["stripe"],
      requirements: ["x"],
    });
    // dedup: only one "What color?"
    expect(questions.filter((q) => /color/i.test(q.text))).toHaveLength(1);
    // blocking sorts first
    expect(questions[0]!.priority).toBe("blocking");
  });

  it("groups questions by stakeholder deterministically", () => {
    const questions = buildQuestions({
      openQuestions: [],
      ambiguousTerms: ["churn"],
      stakeholders: ["@jane.doe"],
      hasAcceptanceCriteria: false,
      sourceSystems: [],
      requirements: [],
    });
    const groups = groupByStakeholder(questions);
    expect(groups.length).toBeGreaterThan(0);
    // keys are sorted
    const keys = groups.map((g) => g.stakeholder);
    expect([...keys].sort((a, b) => a.localeCompare(b))).toEqual(keys);
  });
});

describe("clarification heuristics: scope risks + split", () => {
  const base: ScopeRiskInput = {
    requirements: [],
    acceptanceCriteria: [],
    sourceSystems: [],
    targets: [],
    ambiguousTerms: [],
    dependencies: [],
    injectionDetected: false,
  };

  it("flags missing acceptance criteria as a high risk", () => {
    const risks = detectScopeRisks(base);
    expect(risks.some((r) => r.id === "no_acceptance_criteria")).toBe(true);
    expect(risks.find((r) => r.id === "no_acceptance_criteria")!.severity).toBe(
      "high",
    );
  });

  it("flags undefined metric terms as a high risk", () => {
    const risks = detectScopeRisks({ ...base, ambiguousTerms: ["churn"] });
    expect(risks.some((r) => r.id === "undefined_metrics")).toBe(true);
  });

  it("sorts risks high-severity first", () => {
    const risks = detectScopeRisks({
      ...base,
      ambiguousTerms: ["churn"],
      dependencies: ["STG-42"],
      injectionDetected: true,
    });
    expect(risks[0]!.severity).toBe("high");
    expect(risks[risks.length - 1]!.severity).toBe("low");
  });

  it("recommends a split for oversized requirement/target/source counts", () => {
    const split = recommendSplit({
      ...base,
      requirements: Array.from({ length: 8 }, (_, i) => `req ${i}`),
      targets: ["fct_a", "fct_b", "fct_c", "fct_d"],
      sourceSystems: ["a", "b", "c", "d"],
    });
    expect(split.recommended).toBe(true);
    expect(split.suggestedSplits.length).toBeGreaterThan(0);
  });

  it("does not recommend a split for a small ticket", () => {
    const split = recommendSplit({
      ...base,
      requirements: ["one", "two"],
      targets: ["fct_a"],
      sourceSystems: ["stripe"],
    });
    expect(split.recommended).toBe(false);
  });

  it("proposes an explicit assumption for each undefined term", () => {
    const assumptions = proposeAssumptions({ ...base, ambiguousTerms: ["churn"] });
    expect(
      assumptions.some((a) => /churn/i.test(a.topic) && /open question/i.test(a.assumption)),
    ).toBe(true);
  });

  it("detects vague terms in free text", () => {
    expect(detectAmbiguousTerms("show our top active customers")).toEqual(
      expect.arrayContaining(["top", "active"]),
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end tentacle tests (reads real intake artifacts).
// ---------------------------------------------------------------------------

describe("clarification tentacle: well-specified ticket", () => {
  it("writes the three artifacts and advances state to context", async () => {
    const root = await seedIntake(GOOD_TICKET, "DEMO-1");

    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-1",
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.artifactsWritten).toHaveLength(3);
    expect(await ctx.artifacts.exists("open_questions.md")).toBe(true);
    expect(await ctx.artifacts.exists("scope_risks.md")).toBe(true);
    expect(await ctx.artifacts.exists("clarification_comment.md")).toBe(true);

    const openQ = await ctx.artifacts.read("open_questions.md");
    expect(openQ).toContain("# Open Questions: Build a daily active customers model");
    expect(openQ).toContain("## Blocking Questions");
    expect(openQ).toContain("## Grouped by Stakeholder");
    expect(openQ).toContain("## Evidence Ledger");

    // Comment is a DRAFT, not posted.
    const comment = await ctx.artifacts.read("clarification_comment.md");
    expect(comment).toContain("(DRAFT)");
    expect(comment).toContain("**Posted:** no (draft)");
    expect(result.output?.commentPosted).toBe(false);

    // Workflow advanced.
    const state = await readState(root);
    expect(state.status.phase).toBe("context");
    expect(state.status.next_recommended_command).toBe("context");
    expect(state.artifacts.open_questions).toBe("open_questions.md");
    expect(state.artifacts.scope_risks).toBe("scope_risks.md");
    expect(state.artifacts.clarification_comment).toBe("clarification_comment.md");
  });

  it("recognizes that the good ticket has acceptance criteria (no AC risk)", async () => {
    const root = await seedIntake(GOOD_TICKET, "DEMO-1");
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-1",
    });
    const result = await clarificationTentacle.run(ctx);

    expect(
      result.output?.scopeRisks.some((r) => r.id === "no_acceptance_criteria"),
    ).toBe(false);
    expect(result.output?.degraded).toBe(false);
  });
});

describe("clarification tentacle: sparse ticket", () => {
  it("produces blocking questions and high-severity scope risks", async () => {
    const root = await seedIntake(SPARSE_TICKET, "DEMO-2");
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-2",
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output!.blockingCount).toBeGreaterThan(0);
    expect(result.openQuestions?.length).toBeGreaterThan(0);
    // "churn" + "top" are undefined → high risk.
    expect(
      result.output?.scopeRisks.some((r) => r.id === "undefined_metrics"),
    ).toBe(true);
    expect(
      result.output?.scopeRisks.some((r) => r.id === "no_acceptance_criteria"),
    ).toBe(true);

    // Unresolved questions recorded as blockers in state.
    const state = await readState(root);
    expect(state.status.blockers.length).toBeGreaterThan(0);
  });
});

describe("clarification tentacle: oversized ticket", () => {
  it("recommends a split and drafts follow-up tickets", async () => {
    const root = await seedIntake(OVERSIZED_TICKET, "DEMO-4");
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-4",
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output?.splitRecommended).toBe(true);
    expect(result.output!.suggestedSplits.length).toBeGreaterThan(0);

    const risks = await ctx.artifacts.read("scope_risks.md");
    expect(risks).toContain("## Split Recommendation");
    expect(risks).toContain("Follow-up Tickets (DRAFT)");
    expect(risks).toContain("Split recommended");
  });
});

describe("clarification tentacle: approval gate (posting)", () => {
  it("default-denies posting without explicit yes", async () => {
    const root = await seedIntake(GOOD_TICKET, "DEMO-1");
    const fixture = await writeFixture(GOOD_TICKET);
    const provider = new MockTicketProvider({ fixturePath: fixture });

    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-1",
      providers: { ticket: provider },
      // no yes
    });
    const result = await clarificationTentacle.run(ctx);
    expect(result.output?.commentPosted).toBe(false);
  });

  it("posts the comment when yes + permitting policy are supplied", async () => {
    const root = await seedIntake(GOOD_TICKET, "DEMO-1");
    const fixture = await writeFixture(GOOD_TICKET);
    const provider = new MockTicketProvider({ fixturePath: fixture });

    // Default config gates ticket_update; supplying yes should allow it.
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "DEMO-1",
      providers: { ticket: provider },
      options: { yes: true, reason: "approved by analyst" },
    });
    const result = await clarificationTentacle.run(ctx);
    expect(result.output?.commentPosted).toBe(true);

    const comment = await ctx.artifacts.read("clarification_comment.md");
    expect(comment).toContain("**Posted:** yes");
  });
});

describe("clarification tentacle: degraded (no intake artifacts)", () => {
  it("falls back to the live ticket via provider", async () => {
    const root = await makeTmpDir();
    const fixture = await writeFixture(GOOD_TICKET);
    const provider = new MockTicketProvider({ fixturePath: fixture });

    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      initStateIfMissing: true,
      ticketId: "DEMO-5",
      providers: { ticket: provider },
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output?.degraded).toBe(true);
    expect(result.warnings?.some((w) => /no intake artifacts/i.test(w))).toBe(true);
    expect(await ctx.artifacts.exists("open_questions.md")).toBe(true);
  });

  it("produces a draft-only skeleton with no artifacts and no provider", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      initStateIfMissing: true,
    });
    const result = await clarificationTentacle.run(ctx);

    expect(result.output?.degraded).toBe(true);
    expect(result.warnings?.some((w) => /draft-only/i.test(w))).toBe(true);
    expect(await ctx.artifacts.exists("scope_risks.md")).toBe(true);
  });
});
