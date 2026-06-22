/**
 * Unit tests for the validate → dbt result mapping (the REAL build/test path).
 *
 * We exercise `mapDbtResultToChecks` directly against the runner's typed results
 * (built from the same fixtures the dbt parser tests use), and assert the verdict
 * logic: a passing dbt result yields a NON-blocked verdict; a failing one yields
 * a BLOCKED verdict. No subprocess is spawned — the dbt results are constructed
 * via the pure parser over recorded `run_results.json` fixtures.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunResults, skippedResult } from "../../src/tools/dbt/index.js";
import {
  mapDbtResultToChecks,
  computeVerdict,
} from "../../src/tentacles/validation/expectations.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "dbt", "fixtures");

async function loadJson(name: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, name), "utf8"));
}

describe("mapDbtResultToChecks — green build", () => {
  it("produces a PASSED build check + passed data-test checks", async () => {
    const runResults = await loadJson("run_results_green.json");
    const manifest = await loadJson("manifest.json");
    const result = parseRunResults({
      command: "build",
      runResults,
      manifest,
      exitCode: 0,
    });

    const checks = mapDbtResultToChecks(result);

    // One overall "builds cleanly" check, passed + not blocking.
    const buildCheck = checks.find((c) => c.kind === "build");
    expect(buildCheck).toBeDefined();
    expect(buildCheck!.status).toBe("passed");
    expect(buildCheck!.blocking).toBe(false);
    expect(buildCheck!.name).toMatch(/builds cleanly/i);

    // Every data test mapped to a passed check; none blocking.
    const dataChecks = checks.filter((c) => c.kind !== "build");
    expect(dataChecks.length).toBe(result.tests.length);
    expect(dataChecks.every((c) => c.status === "passed")).toBe(true);
    expect(dataChecks.some((c) => c.blocking)).toBe(false);

    // The logical kinds we care about flipped to real PASS verdicts.
    const kinds = new Set(dataChecks.map((c) => c.kind));
    expect(kinds.has("uniqueness")).toBe(true);
    expect(kinds.has("non_null")).toBe(true);
    expect(kinds.has("accepted_values")).toBe(true);
  });

  it("a green build yields a NON-blocked verdict (done = true)", async () => {
    const result = parseRunResults({
      command: "build",
      runResults: await loadJson("run_results_green.json"),
      manifest: await loadJson("manifest.json"),
      exitCode: 0,
    });
    const verdict = computeVerdict(mapDbtResultToChecks(result));
    expect(verdict.done).toBe(true);
    expect(verdict.failed).toBe(0);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.passed).toBeGreaterThan(0);
  });
});

describe("mapDbtResultToChecks — failing build", () => {
  it("produces a BLOCKING failed build check and/or failed data tests", async () => {
    const result = parseRunResults({
      command: "build",
      runResults: await loadJson("run_results_failing.json"),
      manifest: await loadJson("manifest.json"),
      exitCode: 1,
    });
    expect(result.ok).toBe(false);

    const checks = mapDbtResultToChecks(result);
    const blocking = checks.filter((c) => c.blocking && c.status === "failed");
    expect(blocking.length).toBeGreaterThan(0);
  });

  it("a failing build yields a BLOCKED verdict (done = false)", async () => {
    const result = parseRunResults({
      command: "build",
      runResults: await loadJson("run_results_failing.json"),
      manifest: await loadJson("manifest.json"),
      exitCode: 1,
    });
    const verdict = computeVerdict(mapDbtResultToChecks(result));
    expect(verdict.done).toBe(false);
    expect(verdict.blockers.length).toBeGreaterThan(0);
  });
});

describe("mapDbtResultToChecks — skipped (offline)", () => {
  it("yields a single deferred, blocking build check (never fabricated pass)", () => {
    const result = skippedResult("build", "skipped (offline): --skip-external set");
    const checks = mapDbtResultToChecks(result);
    expect(checks.length).toBe(1);
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.blocking).toBe(true);
    // A deferred build check blocks done — Oswald never declares done on an
    // unverified must-pass criterion.
    const verdict = computeVerdict(checks);
    expect(verdict.done).toBe(false);
  });
});

describe("mapDbtResultToChecks — dbt parse", () => {
  it("maps a clean parse to a passed build check", () => {
    const ok = mapDbtResultToChecks({
      ok: true,
      command: "parse",
      skipped: false,
      exitCode: 0,
      nodes: [],
      tests: [],
      failed: [],
    });
    expect(ok).toHaveLength(1);
    expect(ok[0]!.status).toBe("passed");
    expect(ok[0]!.blocking).toBe(false);
  });

  it("maps a failed parse to a blocking failed build check", () => {
    const bad = mapDbtResultToChecks({
      ok: false,
      command: "parse",
      skipped: false,
      exitCode: 1,
      reason: "compilation error",
      nodes: [],
      tests: [],
      failed: [],
    });
    expect(bad[0]!.status).toBe("failed");
    expect(bad[0]!.blocking).toBe(true);
  });
});
