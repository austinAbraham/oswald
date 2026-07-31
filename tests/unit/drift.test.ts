/**
 * Unit tests for the artifact drift checker.
 *
 * Covers: hash recording at the ArtifactManager write point, baseline +
 * phase-run persistence via advanceWorkflow (including the identical-rewrite
 * rule), back-compat for state files without hashes, the drift check itself
 * (fresh / stale / modified / unknown), the accept-drift re-baseline path,
 * edge-table ↔ tentacle-read alignment, and doctor's report-only surfacing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactManager,
  sha256Hex,
} from "../../src/core/artifacts/index.js";
import {
  createInitialState,
  parseState,
  readState,
  writeState,
} from "../../src/core/state/index.js";
import {
  checkDrift,
  acceptDriftBaselines,
  producerOf,
  CONSUMPTION_EDGES,
  PHASE_OUTPUTS,
} from "../../src/core/drift/index.js";
import { runDiagnostics } from "../../src/core/doctor/index.js";
import { parseConfig } from "../../src/core/config/index.js";
import {
  buildContext,
  advanceWorkflow,
  type TentacleContext,
} from "../../src/tentacles/base.js";
import { fixedClock } from "../../src/utils/time.js";
import {
  ARTIFACT_NAMES as INTAKE_OUTPUTS,
} from "../../src/tentacles/intake/index.js";
import {
  ARTIFACT_NAMES as CLARIFY_OUTPUTS,
  INPUT_ARTIFACTS as CLARIFY_INPUTS,
} from "../../src/tentacles/clarification/index.js";
import {
  ARTIFACT_NAMES as CONTEXT_OUTPUTS,
  INPUT_ARTIFACTS as CONTEXT_INPUTS,
} from "../../src/tentacles/context/index.js";
import {
  ARTIFACT_NAMES as EDA_OUTPUTS,
} from "../../src/tentacles/eda/index.js";
import {
  ARTIFACT_NAMES as DESIGN_OUTPUTS,
  INPUT_ARTIFACTS as DESIGN_INPUTS,
} from "../../src/tentacles/design/index.js";
import {
  ARTIFACT_NAMES as PLANNING_OUTPUTS,
  INPUT_ARTIFACTS as PLANNING_INPUTS,
} from "../../src/tentacles/planning/index.js";
import {
  ARTIFACT_NAMES as VALIDATION_OUTPUTS,
  INPUT_ARTIFACTS as VALIDATION_INPUTS,
} from "../../src/tentacles/validation/index.js";
import {
  ARTIFACT_NAMES as DELIVERY_OUTPUTS,
  INPUT_ARTIFACTS as DELIVERY_INPUTS,
} from "../../src/tentacles/delivery/index.js";
import {
  INPUT_ARTIFACTS as BUILD_INPUTS,
  OUTPUT_ARTIFACTS as BUILD_OUTPUTS,
} from "../../src/cli/commands/build.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-drift-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const T0 = "2026-06-22T00:00:00.000Z";
const T1 = "2026-06-22T01:00:00.000Z";
const T2 = "2026-06-22T02:00:00.000Z";
const T3 = "2026-06-22T03:00:00.000Z";

/** Build a context over a project root at a fixed instant (one "CLI run"). */
async function makeCtx(root: string, iso: string): Promise<TentacleContext> {
  return buildContext({
    projectRoot: root,
    config: parseConfig({ project: { name: "drift-test" } }),
    clock: fixedClock(iso),
    initStateIfMissing: true,
  });
}

/** Simulate one pipeline run: write artifacts, then advance the workflow. */
async function runPhase(
  root: string,
  iso: string,
  files: Record<string, string>,
  command: string,
): Promise<TentacleContext> {
  const ctx = await makeCtx(root, iso);
  for (const [name, content] of Object.entries(files)) {
    await ctx.artifacts.write(name, content);
  }
  await advanceWorkflow(ctx, {
    phase: "intake",
    lastCommand: command,
    blockers: [],
  });
  return ctx;
}

describe("drift: hash recording at the write point", () => {
  it("write records a sha256 + written_at baseline keyed by artifact name", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root, { clock: fixedClock(T0) });
    await am.write("intake.md", "hello");

    const recorded = am.recordedHashes();
    expect(recorded["intake.md"]).toEqual({
      sha256: sha256Hex("hello"),
      written_at: T0,
    });
  });

  it("append records the hash of the FULL resulting content", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root, { clock: fixedClock(T0) });
    await am.write("decision_log.md", "line1\n");
    await am.append("decision_log.md", "line2\n");

    expect(am.recordedHashes()["decision_log.md"]?.sha256).toBe(
      sha256Hex("line1\nline2\n"),
    );
  });

  it("archive drops the session baseline for the moved artifact", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root, { clock: fixedClock(T0) });
    await am.write("scope_risks.md", "risky");
    await am.archive("scope_risks.md");

    expect(am.recordedHashes()["scope_risks.md"]).toBeUndefined();
  });

  it("nested writes are keyed by their forward-slash relative name", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root, { clock: fixedClock(T0) });
    await am.write(path.join("queries", "q1.sql"), "select 1");

    expect(am.recordedHashes()["queries/q1.sql"]).toBeDefined();
  });
});

describe("drift: state schema back-compat", () => {
  it("parseState defaults artifact_hashes + phase_runs for pre-existing state files", () => {
    const state = parseState({
      version: 1,
      project: { name: "x", root: "/tmp/x" },
      status: { phase: "intake" },
      timestamps: { created_at: T0, updated_at: T0 },
      artifacts: {},
    });
    expect(state.artifact_hashes).toEqual({});
    expect(state.phase_runs).toEqual({});
  });

  it("round-trips recorded baselines through the state file", async () => {
    const root = await makeTmpDir();
    const state = createInitialState({
      projectName: "demo",
      projectRoot: root,
      clock: fixedClock(T0),
    });
    state.artifact_hashes = {
      "intake.md": { sha256: sha256Hex("x"), written_at: T0 },
    };
    await writeState(state);

    const loaded = await readState(root);
    expect(loaded.artifact_hashes["intake.md"]).toEqual({
      sha256: sha256Hex("x"),
      written_at: T0,
    });
  });
});

describe("drift: advanceWorkflow persists baselines", () => {
  it("records hash + written_at for artifacts written during the run", async () => {
    const root = await makeTmpDir();
    await runPhase(root, T0, { "intake.md": "brief v1" }, "intake");

    const state = await readState(root);
    expect(state.artifact_hashes["intake.md"]).toEqual({
      sha256: sha256Hex("brief v1"),
      written_at: T0,
    });
  });

  it("an identical rewrite keeps the ORIGINAL written_at (no false drift)", async () => {
    const root = await makeTmpDir();
    await runPhase(root, T0, { "intake.md": "same content" }, "intake");
    await runPhase(root, T1, { "intake.md": "same content" }, "intake");

    const state = await readState(root);
    expect(state.artifact_hashes["intake.md"]?.written_at).toBe(T0);
  });

  it("records when each phase last ran, INDEPENDENT of artifact content", async () => {
    const root = await makeTmpDir();
    await runPhase(root, T0, { "intake.md": "same content" }, "intake");
    // Byte-identical re-run: baseline written_at stays T0, but the phase-run
    // stamp still advances — this is what lets a re-run clear staleness.
    await runPhase(root, T1, { "intake.md": "same content" }, "intake");

    const state = await readState(root);
    expect(state.phase_runs["intake"]).toBe(T1);
    expect(state.artifact_hashes["intake.md"]?.written_at).toBe(T0);
  });

  it("a changed rewrite updates both hash and written_at", async () => {
    const root = await makeTmpDir();
    await runPhase(root, T0, { "intake.md": "v1" }, "intake");
    await runPhase(root, T1, { "intake.md": "v2" }, "intake");

    const state = await readState(root);
    expect(state.artifact_hashes["intake.md"]).toEqual({
      sha256: sha256Hex("v2"),
      written_at: T1,
    });
  });
});

describe("drift: checkDrift", () => {
  /** Seed intake (T0) then design outputs (T1) — a fresh, in-order pipeline. */
  async function seedFreshPipeline(root: string): Promise<void> {
    await runPhase(
      root,
      T0,
      {
        "intake.md": "brief",
        "requirements.md": "reqs",
        "acceptance_criteria.md": "criteria",
      },
      "intake",
    );
    await runPhase(
      root,
      T1,
      {
        "metric_spec.yml": "metrics: []",
        "semantic_model_plan.md": "plan",
        "dimension_contracts.yml": "dims: []",
      },
      "design",
    );
  }

  it("reports no drift for an in-order pipeline", async () => {
    const root = await makeTmpDir();
    await seedFreshPipeline(root);

    const ctx = await makeCtx(root, T2);
    const report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });

    expect(report.ok).toBe(true);
    expect(report.drifted).toEqual([]);
    expect(
      report.findings.some(
        (f) => f.phase === "design" && f.upstream === "intake.md" && f.status === "fresh",
      ),
    ).toBe(true);
  });

  it("flags a phase as STALE when its upstream was re-generated after it ran", async () => {
    const root = await makeTmpDir();
    await seedFreshPipeline(root);
    // Intake re-runs (e.g. clarification answers arrived) — design not re-run.
    await runPhase(root, T2, { "intake.md": "brief v2 with answers" }, "intake");

    const ctx = await makeCtx(root, T3);
    const report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });

    expect(report.ok).toBe(false);
    const stale = report.drifted.find(
      (f) => f.phase === "design" && f.upstream === "intake.md",
    );
    expect(stale?.status).toBe("stale");
    expect(stale?.detail).toContain("re-run 'oswald design'");
  });

  it("REGRESSION: re-running the stale phase clears drift even when its outputs are byte-identical", async () => {
    const root = await makeTmpDir();
    await seedFreshPipeline(root);
    // Upstream change that does not alter design's rendered output (e.g. a
    // typo fix the parser ignores): design is stale...
    await runPhase(root, T2, { "intake.md": "brief v2 with answers" }, "intake");
    let ctx = await makeCtx(root, T3);
    let report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });
    expect(report.ok).toBe(false);

    // ...and the user follows ship's advice: re-run design. The deterministic
    // tentacle re-writes the EXACT same bytes — the gate must still clear.
    await runPhase(
      root,
      T3,
      {
        "metric_spec.yml": "metrics: []",
        "semantic_model_plan.md": "plan",
        "dimension_contracts.yml": "dims: []",
      },
      "design",
    );

    ctx = await makeCtx(root, T3);
    report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });
    expect(report.drifted).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("attributes MODIFIED to the PRODUCING phase and offers the accept path", async () => {
    const root = await makeTmpDir();
    await seedFreshPipeline(root);
    // Out-of-band edit: not via the ArtifactManager, no state update.
    await fs.writeFile(path.join(root, ".oswald", "intake.md"), "hand edited", "utf8");

    const ctx = await makeCtx(root, T2);
    const report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });

    expect(report.ok).toBe(false);
    const modified = report.drifted.filter((f) => f.status === "modified");
    // Exactly ONE finding per hand-edited artifact, attributed to its
    // producer — not one per downstream consumer.
    expect(modified).toHaveLength(1);
    expect(modified[0]?.phase).toBe("intake");
    expect(modified[0]?.upstream).toBe("intake.md");
    expect(modified[0]?.detail).toContain("re-run 'oswald intake'");
    expect(modified[0]?.detail).toContain("--accept-drift");
  });

  it("keeps the MODIFIED finding on the producer even after downstreams re-ran (only intake/accept clears it)", async () => {
    const root = await makeTmpDir();
    await seedFreshPipeline(root);
    await fs.writeFile(path.join(root, ".oswald", "intake.md"), "hand edited", "utf8");
    // Design fully re-runs AFTER the edit (consumes the edited content).
    await runPhase(
      root,
      T2,
      {
        "metric_spec.yml": "metrics: [new]",
        "semantic_model_plan.md": "plan v2",
        "dimension_contracts.yml": "dims: []",
      },
      "design",
    );

    const ctx = await makeCtx(root, T3);
    const report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });

    // The disk/baseline mismatch is intake's to resolve — never design's.
    const modified = report.drifted.filter((f) => f.status === "modified");
    expect(modified).toHaveLength(1);
    expect(modified[0]?.phase).toBe("intake");
    expect(report.drifted.some((f) => f.phase === "design")).toBe(false);
  });

  it("reports 'unknown (no baseline)' — and stays ok — when state has no hashes", async () => {
    const root = await makeTmpDir();
    // Pre-existing run: artifacts on disk, state without any baselines.
    const state = createInitialState({
      projectName: "old",
      projectRoot: root,
      clock: fixedClock(T0),
    });
    await writeState(state);
    const dir = path.join(root, ".oswald");
    await fs.writeFile(path.join(dir, "intake.md"), "brief", "utf8");
    await fs.writeFile(path.join(dir, "metric_spec.yml"), "metrics: []", "utf8");

    const ctx = await makeCtx(root, T1);
    const report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });

    expect(report.ok).toBe(true);
    expect(report.drifted).toEqual([]);
    const unknown = report.unknown.find(
      (f) => f.phase === "design" && f.upstream === "intake.md",
    );
    expect(unknown?.detail).toContain("unknown (no baseline)");
  });

  it("treats an archived/removed upstream as unknown, not drift", async () => {
    const root = await makeTmpDir();
    await seedFreshPipeline(root);
    await fs.rm(path.join(root, ".oswald", "intake.md"));

    const ctx = await makeCtx(root, T2);
    const report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });

    expect(report.ok).toBe(true);
    const finding = report.unknown.find(
      (f) => f.phase === "design" && f.upstream === "intake.md",
    );
    expect(finding?.status).toBe("unknown");
  });

  it("skips phases that never produced outputs (nothing consumed yet)", async () => {
    const root = await makeTmpDir();
    await runPhase(root, T0, { "intake.md": "brief" }, "intake");

    const ctx = await makeCtx(root, T1);
    const report = await checkDrift({ state: ctx.state, artifacts: ctx.artifacts });

    // No downstream phase ran, so there is nothing to be stale.
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("the edge table stays consistent: every phase consumes and produces files", () => {
    for (const edge of CONSUMPTION_EDGES) {
      expect(edge.consumes.length).toBeGreaterThan(0);
      expect(edge.produces.length).toBeGreaterThan(0);
    }
  });
});

describe("drift: consumption edges mirror what tentacles actually read/write", () => {
  const sorted = (xs: readonly string[]): string[] => [...xs].sort();
  const edgeFor = (phase: string) =>
    CONSUMPTION_EDGES.find((e) => e.phase === phase)!;

  it("consumes matches each phase's exported INPUT_ARTIFACTS", () => {
    expect(sorted(edgeFor("clarify").consumes)).toEqual(sorted(CLARIFY_INPUTS));
    expect(sorted(edgeFor("context").consumes)).toEqual(sorted(CONTEXT_INPUTS));
    expect(sorted(edgeFor("design").consumes)).toEqual(sorted(DESIGN_INPUTS));
    expect(sorted(edgeFor("plan").consumes)).toEqual(
      sorted(Object.values(PLANNING_INPUTS)),
    );
    expect(sorted(edgeFor("build").consumes)).toEqual(sorted(BUILD_INPUTS));
    expect(sorted(edgeFor("validate").consumes)).toEqual(sorted(VALIDATION_INPUTS));
    expect(sorted(edgeFor("pr").consumes)).toEqual(
      sorted(Object.values(DELIVERY_INPUTS)),
    );
  });

  it("produces (and PHASE_OUTPUTS) match each phase's ARTIFACT_NAMES", () => {
    expect(sorted(PHASE_OUTPUTS["intake"]!)).toEqual(
      sorted(Object.values(INTAKE_OUTPUTS)),
    );
    expect(sorted(edgeFor("clarify").produces)).toEqual(
      sorted(Object.values(CLARIFY_OUTPUTS)),
    );
    expect(sorted(edgeFor("context").produces)).toEqual(
      sorted(Object.values(CONTEXT_OUTPUTS)),
    );
    // eda's ARTIFACT_NAMES also carry the sql_queries DIRECTORY — not a file.
    expect(sorted(PHASE_OUTPUTS["eda"]!)).toEqual(
      sorted(Object.values(EDA_OUTPUTS).filter((n) => n !== EDA_OUTPUTS.sqlDir)),
    );
    expect(sorted(edgeFor("design").produces)).toEqual(
      sorted(Object.values(DESIGN_OUTPUTS)),
    );
    expect(sorted(edgeFor("plan").produces)).toEqual(
      sorted(Object.values(PLANNING_OUTPUTS)),
    );
    expect(sorted(edgeFor("build").produces)).toEqual(sorted(BUILD_OUTPUTS));
    expect(sorted(edgeFor("validate").produces)).toEqual(
      sorted(Object.values(VALIDATION_OUTPUTS)),
    );
    expect(sorted(edgeFor("pr").produces)).toEqual(
      sorted(Object.values(DELIVERY_OUTPUTS)),
    );
  });

  it("every consumed artifact has a known producer (modified attribution never falls back)", () => {
    for (const edge of CONSUMPTION_EDGES) {
      for (const upstream of edge.consumes) {
        expect(producerOf(upstream), `producer of ${upstream}`).not.toBeNull();
      }
    }
  });
});

describe("drift: accept-drift re-baselining (bless hand-edits)", () => {
  /** Seed intake (T0) then design outputs (T1) — a fresh, in-order pipeline. */
  async function seedPipeline(root: string): Promise<void> {
    await runPhase(
      root,
      T0,
      {
        "intake.md": "brief",
        "requirements.md": "reqs",
        "acceptance_criteria.md": "criteria",
      },
      "intake",
    );
    await runPhase(
      root,
      T1,
      {
        "metric_spec.yml": "metrics: []",
        "semantic_model_plan.md": "plan",
        "dimension_contracts.yml": "dims: []",
      },
      "design",
    );
  }

  /** Hand-edit an artifact on disk and pin its mtime to a known instant. */
  async function handEdit(root: string, name: string, iso: string): Promise<void> {
    const p = path.join(root, ".oswald", name);
    await fs.writeFile(p, "hand edited", "utf8");
    await fs.utimes(p, new Date(iso), new Date(iso));
  }

  it("blesses a deliberate hand-edit: drift clears, the edit is KEPT", async () => {
    const root = await makeTmpDir();
    await seedPipeline(root);
    // Edited BEFORE design last ran (mtime T0 < design run T1): once blessed,
    // every consumer is genuinely up to date.
    await handEdit(root, "intake.md", T0);

    const ctx = await makeCtx(root, T2);
    expect((await checkDrift({ state: ctx.state, artifacts: ctx.artifacts })).ok).toBe(false);

    const { state: next, rebaselined } = await acceptDriftBaselines({
      state: ctx.state,
      artifacts: ctx.artifacts,
    });
    expect(rebaselined).toEqual(["intake.md"]);
    expect(next.artifact_hashes["intake.md"]).toEqual({
      sha256: sha256Hex("hand edited"),
      written_at: T0,
    });

    // Round-trip through the state file, then re-check: no drift, edit kept.
    await writeState(next);
    const reloaded = await readState(root);
    const report = await checkDrift({ state: reloaded, artifacts: ctx.artifacts });
    expect(report.ok).toBe(true);
    expect(await ctx.artifacts.read("intake.md")).toBe("hand edited");
  });

  it("an edit made AFTER a downstream ran honestly flags it stale until re-run", async () => {
    const root = await makeTmpDir();
    await seedPipeline(root);
    // Edited AFTER design last ran (mtime T2 > design run T1).
    await handEdit(root, "intake.md", T2);

    const ctx = await makeCtx(root, T2);
    const { state: next } = await acceptDriftBaselines({
      state: ctx.state,
      artifacts: ctx.artifacts,
    });
    await writeState(next);

    // Blessed, so no longer `modified` — but design consumed the PRE-edit
    // content, so it is stale...
    let report = await checkDrift({ state: next, artifacts: ctx.artifacts });
    expect(report.drifted.every((f) => f.status === "stale")).toBe(true);
    expect(report.drifted.some((f) => f.phase === "design")).toBe(true);

    // ...and re-running design (byte-identical outputs) clears the gate.
    await runPhase(
      root,
      T3,
      {
        "metric_spec.yml": "metrics: []",
        "semantic_model_plan.md": "plan",
        "dimension_contracts.yml": "dims: []",
      },
      "design",
    );
    const ctx2 = await makeCtx(root, T3);
    report = await checkDrift({ state: ctx2.state, artifacts: ctx2.artifacts });
    expect(report.ok).toBe(true);
  });

  it("is a no-op when nothing diverged, and never invents baselines", async () => {
    const root = await makeTmpDir();
    await seedPipeline(root);

    const ctx = await makeCtx(root, T2);
    const clean = await acceptDriftBaselines({
      state: ctx.state,
      artifacts: ctx.artifacts,
    });
    expect(clean.rebaselined).toEqual([]);
    expect(clean.state.artifact_hashes).toEqual(ctx.state.artifact_hashes);

    // Pre-tracking artifacts (no baseline) stay unknown — never adopted.
    const dir = path.join(root, ".oswald");
    await fs.writeFile(path.join(dir, "context_pack.md"), "untracked", "utf8");
    const adopted = await acceptDriftBaselines({
      state: ctx.state,
      artifacts: ctx.artifacts,
    });
    expect(adopted.rebaselined).toEqual([]);
    expect(adopted.state.artifact_hashes["context_pack.md"]).toBeUndefined();
  });
});

describe("drift: doctor reporting (report-only)", () => {
  it("warns on drift but never fails the doctor report", async () => {
    const root = await makeTmpDir();
    await runPhase(
      root,
      T0,
      {
        "intake.md": "brief",
        "requirements.md": "reqs",
        "acceptance_criteria.md": "criteria",
      },
      "intake",
    );
    await runPhase(
      root,
      T1,
      {
        "metric_spec.yml": "metrics: []",
        "semantic_model_plan.md": "plan",
        "dimension_contracts.yml": "dims: []",
      },
      "design",
    );
    await runPhase(root, T2, { "intake.md": "brief v2" }, "intake");

    const report = await runDiagnostics({ cwd: root });
    const drift = report.checks.find((c) => c.name === "drift");
    expect(drift?.status).toBe("warn");
    expect(drift?.detail).toContain("design");
    expect(report.drift?.drifted.length).toBeGreaterThan(0);
    // Report-only: drift is a warn, never a fail.
    expect(report.ok).toBe(true);
  });

  it("reports the drift check as skipped when state is not initialized", async () => {
    const root = await makeTmpDir();
    const report = await runDiagnostics({ cwd: root });
    const drift = report.checks.find((c) => c.name === "drift");
    expect(drift?.status).toBe("ok");
    expect(drift?.detail).toContain("skipped");
    expect(report.drift).toBeNull();
  });

  it("reports no drift for a clean in-order pipeline", async () => {
    const root = await makeTmpDir();
    await runPhase(
      root,
      T0,
      { "intake.md": "brief", "requirements.md": "reqs" },
      "intake",
    );
    await runPhase(
      root,
      T1,
      {
        "context_pack.md": "pack",
        "existing_assets.md": "assets",
        "lineage_notes.md": "lineage",
        "source_inventory.md": "sources",
      },
      "context",
    );

    const report = await runDiagnostics({ cwd: root });
    const drift = report.checks.find((c) => c.name === "drift");
    expect(drift?.status).toBe("ok");
    expect(drift?.detail).toContain("no drift");
  });
});
