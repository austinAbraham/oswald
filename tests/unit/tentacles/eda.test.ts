import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext } from "../../../src/tentacles/base.js";
import { edaTentacle } from "../../../src/tentacles/eda/index.js";
import { MockWarehouseProvider } from "../../../src/tools/index.js";
import type { MockWarehouseFixture } from "../../../src/tools/providers/mock/warehouse.js";
import { parseConfig } from "../../../src/core/config/index.js";
import { readState } from "../../../src/core/state/index.js";
import { fixedClock } from "../../../src/utils/time.js";

const CLOCK = fixedClock("2026-06-22T00:00:00.000Z");
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-eda-"));
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

/**
 * A fixture with:
 *  - `customers`: surrogate key `customer_id`, a date col, an `email` PII col.
 *  - `orders`: own key `order_id` + a `customer_id` (shared → join candidate),
 *    a `created_at` date col.
 */
const FIXTURE: MockWarehouseFixture = {
  schemas: {
    analytics: [
      {
        schema: "analytics",
        name: "customers",
        rowCountEstimate: 1000,
        columns: [
          { name: "customer_id", type: "integer", nullable: false },
          { name: "email", type: "varchar" },
          { name: "signup_date", type: "date" },
          { name: "country", type: "varchar" },
        ],
      },
      {
        schema: "analytics",
        name: "orders",
        rowCountEstimate: 5000,
        columns: [
          { name: "order_id", type: "integer", nullable: false },
          { name: "customer_id", type: "integer" },
          { name: "amount", type: "numeric" },
          { name: "created_at", type: "timestamp" },
        ],
      },
    ],
  },
  // Canned grain result for orders: unique key (total == distinct).
  cannedResults: [
    {
      match: 'distinct ("order_id"::text)) as distinct_keys',
      result: {
        columns: ["total_rows", "distinct_keys"],
        rows: [{ total_rows: 5000, distinct_keys: 5000 }],
      },
    },
  ],
};

async function ctxWith(opts: {
  provider?: MockWarehouseProvider | undefined;
  options?: Record<string, unknown>;
}) {
  const root = await makeTmpDir();
  const ctx = await buildContext({
    projectRoot: root,
    config: cfg(),
    clock: CLOCK,
    initStateIfMissing: true,
    ...(opts.provider ? { providers: { warehouse: opts.provider } } : {}),
    options: opts.options ?? {},
  });
  return { root, ctx };
}

describe("eda tentacle: dry-run with a warehouse provider (no --execute)", () => {
  it("generates validated read-only SQL, writes all artifacts, and advances state", async () => {
    const provider = new MockWarehouseProvider({ fixture: FIXTURE });
    const { root, ctx } = await ctxWith({ provider });

    const result = await edaTentacle.run(ctx);

    // The four reports + the sql files are all written.
    expect(await ctx.artifacts.exists("eda_report.md")).toBe(true);
    expect(await ctx.artifacts.exists("grain_analysis.md")).toBe(true);
    expect(await ctx.artifacts.exists("join_analysis.md")).toBe(true);
    expect(await ctx.artifacts.exists("data_quality_findings.md")).toBe(true);

    // Output reflects a dry-run.
    expect(result.output?.executed).toBe(false);
    expect(result.output?.schemasInspected).toEqual(["analytics"]);
    expect(result.output?.tablesInspected.map((t) => t.name).sort()).toEqual([
      "customers",
      "orders",
    ]);
    expect(result.output?.queryCount).toBeGreaterThan(0);
    expect(result.output?.sqlFiles.length).toBe(result.output?.queryCount);

    // SQL files actually exist on disk under sql_queries/.
    const sqlDir = path.join(ctx.artifacts.dir, "sql_queries");
    const files = await fs.readdir(sqlDir);
    expect(files.length).toBe(result.output?.queryCount);
    expect(files.some((f) => f.startsWith("discover__analytics"))).toBe(true);
    expect(files.some((f) => f.startsWith("profile__analytics__customers"))).toBe(true);

    // Workflow advanced to design.
    const state = await readState(root);
    expect(state.status.phase).toBe("design");
    expect(state.status.next_recommended_command).toBe("design");
    expect(state.artifacts.eda).toBe("eda_report.md");
    expect(state.artifacts.grain_analysis).toBe("grain_analysis.md");
  });

  it("every generated .sql file passes the read-only safety gate", async () => {
    const provider = new MockWarehouseProvider({ fixture: FIXTURE });
    const { ctx } = await ctxWith({ provider });

    await edaTentacle.run(ctx);

    const sqlDir = path.join(ctx.artifacts.dir, "sql_queries");
    const files = await fs.readdir(sqlDir);
    for (const f of files) {
      const text = await fs.readFile(path.join(sqlDir, f), "utf8");
      // Strip the comment header lines; validate the SQL body.
      const body = text
        .split("\n")
        .filter((l) => !l.startsWith("--"))
        .join("\n")
        .trim();
      const verdict = ctx.policy.sql.validate(body);
      expect(verdict.allowed, `${f}: ${verdict.reason ?? ""}`).toBe(true);
    }
  });

  it("identifies PII columns by name and infers candidate keys + dates", async () => {
    const provider = new MockWarehouseProvider({ fixture: FIXTURE });
    const { ctx } = await ctxWith({ provider });

    const result = await edaTentacle.run(ctx);

    const customers = result.output?.tablesInspected.find((t) => t.name === "customers");
    expect(customers?.candidateKey).toEqual(["customer_id"]);
    expect(customers?.sensitiveColumns).toContain("email");
    expect(customers?.dateColumns).toContain("signup_date");

    expect(result.output?.sensitiveColumnCount).toBeGreaterThan(0);

    const quality = await ctx.artifacts.read("data_quality_findings.md");
    expect(quality).toContain("## PII / Sensitive Columns (by name)");
    expect(quality).toContain("email");
  });

  it("infers a join path on the shared customer_id column", async () => {
    const provider = new MockWarehouseProvider({ fixture: FIXTURE });
    const { ctx } = await ctxWith({ provider });

    const result = await edaTentacle.run(ctx);
    expect(result.output?.joinCandidates).toBeGreaterThan(0);

    const join = await ctx.artifacts.read("join_analysis.md");
    expect(join).toContain("customer_id");
    expect(join).toContain("customers");
    expect(join).toContain("orders");
  });
});

describe("eda tentacle: --execute against the mock warehouse", () => {
  it("runs the queries and confirms a unique grain from canned results", async () => {
    const provider = new MockWarehouseProvider({ fixture: FIXTURE });
    const { ctx } = await ctxWith({ provider, options: { execute: true } });

    const result = await edaTentacle.run(ctx);
    expect(result.output?.executed).toBe(true);

    const grain = await ctx.artifacts.read("grain_analysis.md");
    // orders grain should be confirmed unique (5000/5000) from the canned result.
    expect(grain).toContain("analytics.orders");
    expect(grain).toContain("`unique`");
  });
});

describe("eda tentacle: --execute requested but no provider (degraded)", () => {
  it("falls back to dry-run with a warning and emits open questions", async () => {
    const { ctx } = await ctxWith({ options: { execute: true } });

    const result = await edaTentacle.run(ctx);

    expect(result.output?.executed).toBe(false);
    expect(result.warnings?.some((w) => /no warehouse provider/i.test(w))).toBe(true);
    expect(result.output?.schemasInspected).toEqual([]);
    expect(result.openQuestions?.some((q) => /no warehouse schemas/i.test(q))).toBe(true);

    // Even degraded, the artifacts are written (plan-only).
    expect(await ctx.artifacts.exists("eda_report.md")).toBe(true);
  });
});

describe("eda tentacle: explicit --schemas restriction", () => {
  it("only inspects the requested schema", async () => {
    const provider = new MockWarehouseProvider({ fixture: FIXTURE });
    const { ctx } = await ctxWith({
      provider,
      options: { schemas: ["analytics"] },
    });

    const result = await edaTentacle.run(ctx);
    expect(result.output?.schemasInspected).toEqual(["analytics"]);
    expect(result.output?.tablesInspected.length).toBe(2);
  });
});
