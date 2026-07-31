/**
 * Unit tests for `oswald next --explain` (`src/cli/commands/_explain.ts`).
 *
 * The helper is pure composition over existing readers: state + config +
 * artifact existence + the tentacle registry. Deterministic: temp dirs, no
 * network, no live LLM, no CLI output capture needed.
 *
 * ACCURACY: the `reads` lines must mirror the LITERAL filenames each step's
 * code looks for (tentacles never resolve inputs via `state.artifacts`), so a
 * dedicated block pins `explainedReads` to the consumers' exported input
 * constants — future producer/consumer drift fails here, not in the field.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  explainNextStep,
  explainedReads,
} from "../../src/cli/commands/_explain.js";
import { BUILD_INPUT_ARTIFACTS } from "../../src/cli/commands/build.js";
import { buildProgram } from "../../src/cli/index.js";
import { ArtifactManager } from "../../src/core/artifacts/index.js";
import { parseConfig } from "../../src/core/config/index.js";
import {
  createInitialState,
  type OswaldState,
} from "../../src/core/state/index.js";
import type { WorkflowState } from "../../src/core/workflow/index.js";
import {
  isActionGated,
  isActionProhibited,
  type ApprovalPolicy,
} from "../../src/core/approvals/index.js";
import { INTAKE_ARTIFACTS as CLARIFY_INPUTS } from "../../src/tentacles/clarification/index.js";
import { INPUT_ARTIFACTS as CONTEXT_INPUTS } from "../../src/tentacles/context/index.js";
import { INPUT_ARTIFACTS as DESIGN_INPUTS } from "../../src/tentacles/design/index.js";
import { INPUT_ARTIFACTS as PLANNING_INPUTS } from "../../src/tentacles/planning/index.js";
import { ACCEPTANCE_ARTIFACT } from "../../src/tentacles/validation/index.js";
import { INPUT_ARTIFACTS as DELIVERY_INPUTS } from "../../src/tentacles/delivery/index.js";
import { fixedClock } from "../../src/utils/time.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-explain-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Build a state at a given phase (optionally with a ticket + patches). */
function makeState(
  root: string,
  phase: WorkflowState,
  patch: Partial<{
    ticketId: string;
    lastCommand: string;
    blockers: string[];
    unresolvedQuestions: string[];
    tools: OswaldState["tools"];
  }> = {},
): OswaldState {
  const state = createInitialState({
    projectName: "explain-test",
    projectRoot: root,
    clock: fixedClock("2026-01-01T00:00:00.000Z"),
    ...(patch.ticketId
      ? { ticket: { id: patch.ticketId, provider: null, url: null } }
      : {}),
  });
  state.status.phase = phase;
  state.status.last_command = patch.lastCommand ?? null;
  state.status.blockers = patch.blockers ?? [];
  state.requirements.unresolved_questions = patch.unresolvedQuestions ?? [];
  state.tools = patch.tools ?? {};
  return state;
}

/** Assemble the explain inputs for a temp project. */
function makeInputs(root: string, state: OswaldState) {
  return {
    state,
    config: parseConfig({ project: { name: "explain-test" } }),
    artifacts: new ArtifactManager(root),
  };
}

describe("explainNextStep: happy path", () => {
  it("explains phase position, purpose, successor, reads, writes, and gates", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "eda", { ticketId: "T-1" });
    const lines = await explainNextStep(makeInputs(root, state));
    const text = lines.join("\n");

    expect(lines[0]).toBe("explain: why 'oswald eda' is next");
    expect(text).toContain("phase: 'eda' — step 5 of 12 on the linear pipeline");
    expect(text).toContain("then:  on success the workflow advances toward phase 'design'");
    // eda reads NOTHING from the artifact dir — the warehouse is its input.
    expect(text).toContain("nothing from the artifact dir");
    expect(text).not.toContain("intake.md");
    // Outputs come from what the eda step actually writes.
    expect(text).toContain("writes (under '.oswald/'): eda_report.md");
    // No blockers / questions on the happy path.
    expect(text).toContain("- blockers: none");
    expect(text).toContain("- unresolved open questions: none");
    // Read-only step → no consent needed; the --execute note stays read-only.
    expect(text).toContain("consent: none needed");
    expect(text).toContain("READ-ONLY");
  });

  it("is deterministic — identical inputs produce identical output", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "design", { ticketId: "T-2" });
    const a = await explainNextStep(makeInputs(root, state));
    const b = await explainNextStep(makeInputs(root, state));
    expect(a).toEqual(b);
  });

  it("explains 'init' for an uninitialized phase without touching tentacles", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "uninitialized");
    const lines = await explainNextStep(makeInputs(root, state));
    const text = lines.join("\n");
    expect(lines[0]).toBe("explain: why 'oswald init' is next");
    expect(text).toContain("step 1 of 12");
    expect(text).toContain("hand-written command, not a tentacle");
    expect(text).toContain("consent: none needed");
  });
});

describe("explainNextStep: inputs present vs missing", () => {
  it("marks missing inputs and names the command that produces them", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "clarification", { ticketId: "T-3" });
    const lines = await explainNextStep(makeInputs(root, state));
    const text = lines.join("\n");

    // Nothing on disk → every literal intake filename is reported missing.
    expect(text).toContain("intake.md (missing)");
    expect(text).toContain("requirements.md (missing)");
    expect(text).toContain("acceptance_criteria.md (missing)");
    expect(text).toContain("'oswald intake' produces them");
    expect(text).toContain("missing inputs degrade gracefully");
  });

  it("marks the literal inputs present when the producing step's files exist", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root);
    await am.write("intake.md", "brief");
    await am.write("requirements.md", "reqs");
    await am.write("acceptance_criteria.md", "ac");

    const state = makeState(root, "design", { ticketId: "T-4" });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");

    expect(text).toContain("requirements.md (present)");
    expect(text).toContain("acceptance_criteria.md (present)");
    expect(text).toContain("intake.md (present)");
    // The legacy names nothing in the pipeline writes are reported honestly.
    expect(text).toContain("clarifications.md (missing)");
    expect(text).toContain("context.md (missing)");
    expect(text).toContain("eda.md (missing)");
    expect(text).toContain("no pipeline step currently writes these names");
  });

  it("never claims 'plan' reads design's real outputs — only the literal design.md/eda.md names", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root);
    // Simulate a normal `oswald design` run: it writes metric_spec.yml & co.
    await am.write("metric_spec.yml", "version: 1");
    await am.write("semantic_model_plan.md", "plan");

    const state = makeState(root, "planning", { ticketId: "T-5" });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");

    // `oswald plan` looks only for the literal legacy names — the design
    // outputs on disk must NOT be presented as its inputs.
    expect(text).toContain("design.md (missing)");
    expect(text).toContain("eda.md (missing)");
    expect(text).not.toContain("metric_spec.yml (present)");
    expect(text).toContain("no pipeline step currently writes these names");
    // The producer/consumer filename gap is taught, not papered over.
    expect(text).toContain("which plan does NOT read");
  });

  it("shows delivery's validation fallback chain with first-existing semantics", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root);
    await am.write("validation_report.md", "report");

    const state = makeState(root, "ready_for_pr", { ticketId: "T-6" });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");

    // The preferred name exists → the chain is satisfied, no missing hint.
    expect(text).toContain(
      "validation_report.md (present), validation.md (missing) — the first existing file is used",
    );
    // The plan chain has no file at all → the graceful hint names 'oswald plan'.
    expect(text).toContain("implementation_plan.md (missing), plan.md (missing)");
    expect(text).toContain("'oswald plan' produces them");
  });

  it("update-ticket reads the validation/plan/requirements evidence, never pr_summary.md", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "ready_for_ticket_update");
    const lines = await explainNextStep(makeInputs(root, state));
    const readLines = lines.filter((l) => l.trimStart().startsWith("- "));
    const reads = readLines.join("\n");

    expect(reads).toContain("validation_report.md");
    expect(reads).toContain("implementation_plan.md");
    expect(reads).toContain("requirements.md");
    expect(explainedReads("update-ticket")).not.toContain("pr_summary.md");
  });
});

describe("explain reads: pinned to the consumers' literal input constants", () => {
  it("mirrors each step's exported input filenames exactly (drift guard)", () => {
    // Steps with no artifact-dir inputs at all.
    expect(explainedReads("init")).toEqual([]);
    expect(explainedReads("intake")).toEqual([]);
    expect(explainedReads("eda")).toEqual([]);

    // Tentacle-backed steps: the consumer's own constants, in read order.
    expect(explainedReads("clarify")).toEqual(Object.values(CLARIFY_INPUTS));
    expect(explainedReads("context")).toEqual([...CONTEXT_INPUTS]);
    expect(explainedReads("design")).toEqual([...DESIGN_INPUTS]);
    expect(explainedReads("plan")).toEqual(Object.values(PLANNING_INPUTS));
    expect(explainedReads("validate")).toEqual([ACCEPTANCE_ARTIFACT]);

    // Delivery backs both verbs; both report the same fallback chains.
    const deliveryReads = [
      ...DELIVERY_INPUTS.validation,
      ...DELIVERY_INPUTS.plan,
      ...DELIVERY_INPUTS.requirements,
    ];
    expect(explainedReads("pr")).toEqual(deliveryReads);
    expect(explainedReads("update-ticket")).toEqual(deliveryReads);

    // The build command's literal plan inputs.
    expect(explainedReads("build")).toEqual(Object.values(BUILD_INPUT_ARTIFACTS));

    // Unknown commands report nothing rather than inventing inputs.
    expect(explainedReads("no-such-command")).toEqual([]);
  });
});

describe("explainNextStep: gates", () => {
  it("lists blockers and unresolved open questions when present", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "eda", {
      blockers: ["grain unconfirmed"],
      unresolvedQuestions: ["Which timezone is 'daily'?", "Include trials?"],
    });
    const lines = await explainNextStep(makeInputs(root, state));
    const text = lines.join("\n");
    expect(text).toContain("blockers (1):");
    expect(text).toContain("- grain unconfirmed");
    expect(text).toContain("unresolved open questions (2)");
    expect(text).toContain("- Which timezone is 'daily'?");
    expect(text).toContain("- Include trials?");
  });
});

describe("explainNextStep: tools", () => {
  it("lists the tentacle's optional capabilities with unrecorded wiring", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "eda");
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");
    expect(text).toContain("required: none — the step runs even with zero providers wired");
    expect(text).toContain("optional (4");
    expect(text).toContain(
      "warehouse.executeReadOnlySql (warehouse: not recorded in state.tools — 'oswald doctor' probes providers)",
    );
  });

  it("reports the recorded provider status from state.tools", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "eda", {
      tools: { warehouse: { status: "available" } },
    });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");
    expect(text).toContain("warehouse.listSchemas (warehouse: available per state.tools)");
  });

  it("prefers an exact capability entry over the provider entry", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "eda", {
      tools: {
        "warehouse.listSchemas": { status: "unavailable" },
        warehouse: { status: "available" },
      },
    });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");
    expect(text).toContain("warehouse.listSchemas (warehouse: unavailable per state.tools)");
    expect(text).toContain("warehouse.listTables (warehouse: available per state.tools)");
  });
});

describe("explainNextStep: consent flags", () => {
  it("names the approval action + flags for 'pr' and marks the gated one", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "ready_for_pr", { ticketId: "T-7" });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");

    expect(text).toContain("consent (side effects are default-deny");
    // 'pr_open' in the default config gates open_pull_request via the alias map.
    expect(text).toContain(
      "open the pull request → action 'open_pull_request': pass --open plus -y/--yes; policy: gated by policies.require_approval_for",
    );
    // create_branch is not listed in the default config → still default-deny.
    expect(text).toContain(
      "create the feature branch → action 'create_branch': pass --open plus -y/--yes; policy: not explicitly gated (still default-deny without consent)",
    );
    expect(text).toContain("'--draft' always forces draft-only");
  });

  it("marks a prohibited action as never able to run", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "ready_for_pr");
    const config = parseConfig({
      project: { name: "explain-test" },
      policies: { prohibit: ["open_pull_request"] },
    });
    const text = (
      await explainNextStep({ state, config, artifacts: new ArtifactManager(root) })
    ).join("\n");
    expect(text).toContain(
      "action 'open_pull_request': pass --open plus -y/--yes; policy: PROHIBITED by policies.prohibit — this side effect can never run",
    );
  });

  it("explains build's --apply gate ('commit' class) and its dry-run default", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root);
    await am.write("implementation_plan.md", "plan");

    const state = makeState(root, "building", { ticketId: "T-8" });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");

    expect(text).toContain("explain: why 'oswald build' is next");
    expect(text).toContain("implementation_plan.md (present)");
    // The optional planning detail is missing but degrades gracefully.
    expect(text).toContain("model_plan.md (missing)");
    // build is a hand-written command, not a tentacle.
    expect(text).toContain("hand-written command, not a tentacle");
    expect(text).toContain(
      "write dbt model/schema scaffolding under the configured model dir → action 'commit': pass --apply plus -y/--yes",
    );
    expect(text).toContain("the default is a dry-run preview");
  });

  it("marks build's implementation plan REQUIRED when it is absent", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "building", { ticketId: "T-9" });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");
    expect(text).toContain(
      "implementation_plan.md (missing) — REQUIRED — the step stops without it; 'oswald plan' produces it",
    );
  });

  it("explains the ticket_update gate for update-ticket", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "ready_for_ticket_update");
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");
    expect(text).toContain(
      "post the update to the ticket → action 'ticket_update': pass --post plus -y/--yes; policy: gated by policies.require_approval_for",
    );
  });
});

describe("explainNextStep: blocked dead-end", () => {
  it("lists blockers and says exactly what to re-run (with the ticket id)", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "blocked", {
      ticketId: "T-10",
      lastCommand: "validate",
      blockers: ["2 acceptance check(s) failed"],
      unresolvedQuestions: ["Is the legacy report authoritative?"],
    });
    const lines = await explainNextStep(makeInputs(root, state));
    const text = lines.join("\n");

    expect(lines[0]).toContain("BLOCKED");
    expect(text).toContain("(parked by 'oswald validate')");
    expect(text).toContain("blockers (1):");
    expect(text).toContain("- 2 acceptance check(s) failed");
    expect(text).toContain("unresolved open questions (1):");
    expect(text).toContain(
      "to resume: resolve the blocker(s) above, then re-run: oswald validate T-10",
    );
  });

  it("falls back to 'validate' when last_command is not a CLI verb", async () => {
    const root = await makeTmpDir();
    // Delivery records its tentacle id ('delivery'), which is not a CLI verb.
    const state = makeState(root, "blocked", {
      ticketId: "T-11",
      lastCommand: "delivery",
      blockers: ["validation status: fail"],
    });
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");
    expect(text).toContain("re-run: oswald validate T-11");
  });

  it("handles a blocked state with no blockers, last command, or ticket", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "blocked");
    const text = (await explainNextStep(makeInputs(root, state))).join("\n");
    expect(text).toContain("blockers: none recorded in state");
    expect(text).toContain("re-run: oswald validate");
    expect(text).not.toContain("parked by");
  });
});

describe("explainNextStep: terminal shipped", () => {
  it("says the pipeline is complete and how to start the next ticket", async () => {
    const root = await makeTmpDir();
    const state = makeState(root, "shipped");
    const lines = await explainNextStep(makeInputs(root, state));
    expect(lines[0]).toContain("'shipped' is terminal");
    expect(lines.join("\n")).toContain("oswald intake <ticket>");
  });
});

describe("approvals: gated/prohibited introspection helpers", () => {
  const policy: ApprovalPolicy = {
    requireApprovalFor: ["pr_open", "ticket_update"],
    prohibit: ["direct_push_to_protected_branch"],
  };

  it("matches config aliases for gating", () => {
    expect(isActionGated("open_pull_request", policy)).toBe(true);
    expect(isActionGated("ticket_update", policy)).toBe(true);
    expect(isActionGated("create_branch", policy)).toBe(false);
  });

  it("matches config aliases for prohibition", () => {
    expect(isActionProhibited("push", policy)).toBe(true);
    expect(isActionProhibited("open_pull_request", policy)).toBe(false);
  });
});

describe("CLI wiring: next --explain", () => {
  it("registers the --explain option on the next command", () => {
    const program = buildProgram();
    const next = program.commands.find((c) => c.name() === "next");
    expect(next).toBeDefined();
    const flags = next!.options.map((o) => o.long);
    expect(flags).toContain("--explain");
    // The existing surface is untouched.
    expect(flags).toContain("--run");
  });
});
