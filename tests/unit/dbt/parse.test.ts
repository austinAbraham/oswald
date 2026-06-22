import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRunResults,
  skippedResult,
  classifyDbtTest,
  extractTestColumn,
  isSandboxTarget,
} from "../../../src/tools/dbt/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

async function loadJson(name: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, name), "utf8"));
}

describe("parseRunResults — green fixture (real dbt-duckdb output)", () => {
  it("parses nodes + tests and reports ok with no failures", async () => {
    const runResults = await loadJson("run_results_green.json");
    const manifest = await loadJson("manifest.json");
    const result = parseRunResults({
      command: "build",
      runResults,
      manifest,
      exitCode: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.failed).toEqual([]);
    // 3 seeds + 4 models (3 staging views + 1 mart) = 7 non-test nodes.
    expect(result.nodes.length).toBe(7);
    // 16 data tests.
    expect(result.tests.length).toBe(16);
  });

  it("strips the trailing hash from test names and uses the clean manifest name", async () => {
    const runResults = await loadJson("run_results_green.json");
    const manifest = await loadJson("manifest.json");
    const result = parseRunResults({ command: "test", runResults, manifest, exitCode: 0 });

    for (const t of result.tests) {
      expect(t.name).not.toMatch(/\.[0-9a-f]{6,12}$/);
    }
    expect(result.tests.map((t) => t.name)).toContain(
      "not_null_stg_crm_customers_customer_id",
    );
  });

  it("maps each dbt test to a logical check kind", async () => {
    const runResults = await loadJson("run_results_green.json");
    const manifest = await loadJson("manifest.json");
    const { tests } = parseRunResults({ command: "test", runResults, manifest, exitCode: 0 });

    const byName = (n: string) => tests.find((t) => t.name === n);
    expect(byName("unique_stg_crm_customers_customer_id")?.kind).toBe("unique");
    expect(byName("not_null_stg_crm_customers_customer_id")?.kind).toBe("not_null");
    expect(
      byName(
        "accepted_values_fct_customer_retention_retention_status__new__retained__reactivated__churned",
      )?.kind,
    ).toBe("accepted_values");
    expect(
      byName(
        "relationships_fct_customer_retention_customer_id__customer_id__ref_stg_crm_customers_",
      )?.kind,
    ).toBe("relationships");
    // singular grain test → row_count is NOT it; it is "other" by name, but the
    // assert_retention_grain_unique singular test classifies via its name.
    expect(byName("assert_retention_grain_unique")?.kind).toBe("unique");
  });

  it("recovers the target column from manifest metadata", async () => {
    const runResults = await loadJson("run_results_green.json");
    const manifest = await loadJson("manifest.json");
    const { tests } = parseRunResults({ command: "test", runResults, manifest, exitCode: 0 });
    const rel = tests.find((t) =>
      t.name.startsWith("relationships_fct_customer_retention"),
    );
    expect(rel?.column).toBe("customer_id");
  });

  it("parses without a manifest (degrades to name-based classification)", async () => {
    const runResults = await loadJson("run_results_green.json");
    const result = parseRunResults({ command: "test", runResults, exitCode: 0 });
    expect(result.ok).toBe(true);
    expect(result.tests.length).toBe(16);
    // Name-based classification still works for the well-named generic tests.
    const unique = result.tests.find((t) =>
      t.name.startsWith("unique_stg_crm_customers"),
    );
    expect(unique?.kind).toBe("unique");
  });
});

describe("parseRunResults — failing fixture", () => {
  it("flags the run not-ok and lists failed nodes + tests", async () => {
    const runResults = await loadJson("run_results_failing.json");
    const result = parseRunResults({ command: "build", runResults, exitCode: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    // The errored model + the failed unique test are reported.
    expect(result.failed).toContain("fct_customer_retention");
    expect(result.failed).toContain("unique_fct_customer_retention_customer_id");
    // The passing + skipped tests are NOT in `failed`.
    expect(result.failed).not.toContain("not_null_fct_customer_retention_month");
  });

  it("derives a failure message from the failures count when no message present", async () => {
    const runResults = await loadJson("run_results_failing.json");
    const { tests } = parseRunResults({ command: "test", runResults, exitCode: 1 });
    const failed = tests.find((t) => t.status === "fail");
    expect(failed?.message).toMatch(/3 failing row/);
  });

  it("normalizes statuses (error/fail/pass/skipped)", async () => {
    const runResults = await loadJson("run_results_failing.json");
    const result = parseRunResults({ command: "build", runResults, exitCode: 1 });
    const mart = result.nodes.find((n) => n.name === "fct_customer_retention");
    expect(mart?.status).toBe("error");
    const skipped = result.tests.find((t) => t.status === "skipped");
    expect(skipped).toBeDefined();
  });
});

describe("skippedResult", () => {
  it("returns an ok, skipped, no-spawn result", () => {
    const r = skippedResult("build", "skipped (offline)");
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.nodes).toEqual([]);
    expect(r.reason).toBe("skipped (offline)");
  });
});

describe("classifyDbtTest", () => {
  it("prefers the generic-test metadata name when present", () => {
    expect(classifyDbtTest("anything_at_all", "accepted_values")).toBe("accepted_values");
    expect(classifyDbtTest("anything", "relationships")).toBe("relationships");
    expect(classifyDbtTest("anything", "not_null")).toBe("not_null");
  });

  it("falls back to name heuristics without metadata", () => {
    expect(classifyDbtTest("unique_stg_x_id")).toBe("unique");
    expect(classifyDbtTest("not_null_stg_x_id")).toBe("not_null");
    expect(classifyDbtTest("source_freshness_check")).toBe("freshness");
    expect(classifyDbtTest("dbt_utils_unique_combination_of_columns_x")).toBe("unique");
    expect(classifyDbtTest("assert_equal_rowcount_x")).toBe("row_count");
  });

  it("classifies an unrecognized singular test as 'other'", () => {
    expect(classifyDbtTest("assert_some_business_rule")).toBe("other");
  });
});

describe("extractTestColumn", () => {
  it("prefers manifest column_name", () => {
    expect(extractTestColumn("anything", "customer_id")).toBe("customer_id");
  });
  it("heuristically pulls a trailing identifier from a generic-test name", () => {
    expect(extractTestColumn("not_null_stg_crm_customers_customer_id")).toBe("id");
  });
  it("returns undefined for non-generic names", () => {
    expect(extractTestColumn("assert_some_rule")).toBeUndefined();
  });
});

describe("isSandboxTarget", () => {
  it("recognizes common sandbox/dev tokens", () => {
    expect(isSandboxTarget("sandbox")).toBe(true);
    expect(isSandboxTarget("dev")).toBe(true);
    expect(isSandboxTarget("ci_test")).toBe(true);
    expect(isSandboxTarget("duckdb")).toBe(true);
  });
  it("rejects production-ish or empty targets", () => {
    expect(isSandboxTarget("prod")).toBe(false);
    expect(isSandboxTarget("production")).toBe(false);
    expect(isSandboxTarget(undefined)).toBe(false);
    expect(isSandboxTarget("")).toBe(false);
  });
});
