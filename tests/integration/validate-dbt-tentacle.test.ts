/**
 * Full validation-tentacle test of the REAL dbt path, with the dbt runner module
 * MOCKED so no subprocess is spawned. Asserts the end-to-end verdict + state:
 *   - a passing dbt build/test → validation NOT blocked (phase advances).
 *   - a failing dbt build → validation BLOCKED (phase = "blocked").
 *
 * Deterministic: temp dir, fixed clock, mocked dbt runner (fixture-shaped
 * results). No network, no live dbt.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DbtRunResult } from "../../src/tools/dbt/types.js";

// --- Mock the dbt tools module (detectDbtProject + runDbt). ----------------
const mockState: {
  projectDir: string | null;
  results: Record<string, DbtRunResult>;
} = { projectDir: "/mock/dbt-project", results: {} };

vi.mock("../../src/tools/dbt/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/dbt/index.js")>();
  return {
    ...actual,
    detectDbtProject: vi.fn(async () => mockState.projectDir),
    runDbt: vi.fn(async (command: string) => {
      const r = mockState.results[command];
      if (!r) throw new Error(`no mock dbt result for '${command}'`);
      return r;
    }),
  };
});

// Import AFTER the mock is registered.
const { buildContext } = await import("../../src/tentacles/base.js");
const { validationTentacle } = await import("../../src/tentacles/validation/index.js");
const { parseConfig } = await import("../../src/core/config/index.js");
const { createInitialState, writeState } = await import("../../src/core/state/index.js");
const { fixedClock } = await import("../../src/utils/time.js");

const CLOCK = fixedClock("2026-06-22T00:00:00.000Z");
const tmpDirs: string[] = [];

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-validate-dbt-"));
  tmpDirs.push(dir);
  const state = createInitialState({
    projectName: "vdbt",
    projectRoot: dir,
    clock: CLOCK,
    ticket: { id: "AE-1234", provider: null, url: null },
  });
  await fs.mkdir(path.join(dir, ".oswald"), { recursive: true });
  await writeState(state, ".oswald");
  // Acceptance criteria the dbt run is expected to satisfy.
  await fs.writeFile(
    path.join(dir, ".oswald", "acceptance_criteria.md"),
    [
      "## Acceptance Criteria",
      "",
      "1. Model builds cleanly in the sandbox",
      "2. customer_id is unique",
      "3. customer_id is not null",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

function greenBuild(): DbtRunResult {
  return {
    ok: true,
    command: "build",
    exitCode: 0,
    skipped: false,
    nodes: [
      { name: "stg_crm_customers", resourceType: "model", status: "success" },
      { name: "fct_customer_retention", resourceType: "model", status: "success" },
    ],
    tests: [
      { name: "unique_fct_customer_retention_customer_id", status: "pass", kind: "unique", column: "customer_id" },
      { name: "not_null_fct_customer_retention_customer_id", status: "pass", kind: "not_null", column: "customer_id" },
      { name: "accepted_values_fct_status", status: "pass", kind: "accepted_values" },
    ],
    failed: [],
    stdout: "Completed successfully",
    stderr: "",
  };
}

function greenTest(): DbtRunResult {
  return { ...greenBuild(), command: "test", nodes: [] };
}

function failingBuild(): DbtRunResult {
  return {
    ok: false,
    command: "build",
    exitCode: 1,
    skipped: false,
    reason: "1 node(s)/test(s) failed",
    nodes: [
      { name: "fct_customer_retention", resourceType: "model", status: "error", message: "binder error" },
    ],
    tests: [
      { name: "unique_fct_customer_retention_customer_id", status: "fail", kind: "unique", column: "customer_id", message: "3 failing row(s)" },
    ],
    failed: ["fct_customer_retention", "unique_fct_customer_retention_customer_id"],
    stdout: "",
    stderr: "Database Error",
  };
}

beforeEach(() => {
  mockState.projectDir = "/mock/dbt-project";
  mockState.results = {};
});

afterEach(async () => {
  vi.clearAllMocks();
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("validate tentacle — real dbt path (mocked runner)", () => {
  it("a passing dbt build/test yields a NON-blocked validation", async () => {
    const root = await makeProject();
    mockState.results = { build: greenBuild(), test: greenTest() };

    const ctx = await buildContext({
      projectRoot: root,
      config: parseConfig({ project: { name: "vdbt" } }),
      clock: CLOCK,
      ticketId: "AE-1234",
      options: { skipExternal: false, dbtProject: true },
    });
    const result = await validationTentacle.run(ctx);

    expect(result.output!.done).toBe(true);
    expect(result.output!.blockers).toEqual([]);
    expect(result.output!.passed).toBeGreaterThan(0);
    expect(result.output!.failed).toBe(0);

    // State advanced OUT of blocked toward ready_for_pr.
    const { readState } = await import("../../src/core/state/index.js");
    const state = await readState(root, ".oswald");
    expect(state.status.phase).not.toBe("blocked");
    expect(state.status.phase).toBe("ready_for_pr");

    // The REAL dbt results landed in the test_results artifact.
    const testResults = await fs.readFile(
      path.join(root, ".oswald", "test_results.md"),
      "utf8",
    );
    expect(testResults).toMatch(/dbt build/);
    expect(testResults).toMatch(/unique_fct_customer_retention_customer_id/);
  });

  it("a failing dbt build yields a BLOCKED validation (never auto-ships)", async () => {
    const root = await makeProject();
    mockState.results = { build: failingBuild() };

    const ctx = await buildContext({
      projectRoot: root,
      config: parseConfig({ project: { name: "vdbt" } }),
      clock: CLOCK,
      ticketId: "AE-1234",
      options: { skipExternal: false, dbtProject: true },
    });
    const result = await validationTentacle.run(ctx);

    expect(result.output!.done).toBe(false);
    expect(result.output!.blockers.length).toBeGreaterThan(0);

    const { readState } = await import("../../src/core/state/index.js");
    const state = await readState(root, ".oswald");
    expect(state.status.phase).toBe("blocked");
    expect(state.status.blockers.length).toBeGreaterThan(0);
  });

  it("--skip-external keeps the deterministic offline behavior (blocked on unverifiable build)", async () => {
    const root = await makeProject();
    // No dbt results provided — the offline path must not call runDbt at all.

    const ctx = await buildContext({
      projectRoot: root,
      config: parseConfig({ project: { name: "vdbt" } }),
      clock: CLOCK,
      ticketId: "AE-1234",
      options: { skipExternal: true, dbtProject: true },
    });
    const result = await validationTentacle.run(ctx);

    // The "builds cleanly" criterion is a blocking, unverified (deferred) check.
    expect(result.output!.done).toBe(false);
    const { readState } = await import("../../src/core/state/index.js");
    const state = await readState(root, ".oswald");
    expect(state.status.phase).toBe("blocked");
  });
});
