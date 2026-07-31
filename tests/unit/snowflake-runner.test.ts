/**
 * Unit tests for the Snowflake runner + warehouse provider.
 *
 * No real `snow` binary is ever spawned: the runner's low-level spawn is
 * replaced with a fake that captures argv and returns canned stdout, and the
 * warehouse provider is driven with an injected fake runner. These assert the
 * security-critical invariants: exact argv, read-only-before-spawn, PII
 * redaction, malformed-JSON handling, missing-connection rejection, metadata
 * identifier quoting, and defensive row truncation.
 */
import { describe, it, expect } from "vitest";
import {
  buildSnowArgv,
  splitInvocation,
  runSnowQuery,
  type SnowSpawn,
} from "../../src/tools/snowflake/runner.js";
import { SnowflakeWarehouseProvider } from "../../src/tools/snowflake/warehouse.js";
import type {
  SnowQueryOutcome,
  SnowRunOptions,
} from "../../src/tools/snowflake/types.js";
import {
  sha256Hex,
  type AuditData,
  type AuditEvent,
  type AuditSink,
} from "../../src/core/audit/index.js";

/** A fake SnowSpawn that records the argv it was called with and returns canned output. */
function fakeSpawn(
  result: { exitCode?: number | null; stdout?: string; stderr?: string; spawnError?: string },
): { spawn: SnowSpawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SnowSpawn = async (argv) => {
    calls.push(argv);
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.spawnError != null ? { spawnError: result.spawnError } : {}),
    };
  };
  return { spawn, calls };
}

describe("splitInvocation", () => {
  it("defaults to ['snow']", () => {
    expect(splitInvocation(undefined)).toEqual(["snow"]);
    expect(splitInvocation("   ")).toEqual(["snow"]);
  });
  it("whitespace-splits a wrapper invocation", () => {
    expect(splitInvocation("poetry run snow")).toEqual(["poetry", "run", "snow"]);
  });
});

describe("buildSnowArgv", () => {
  it("builds exactly [snow, sql, -q, <sql>, --connection, <name>, --format, json]", () => {
    const argv = buildSnowArgv(["snow"], "SELECT 1 LIMIT 10000", "analytics");
    expect(argv).toEqual([
      "snow",
      "sql",
      "-q",
      "SELECT 1 LIMIT 10000",
      "--connection",
      "analytics",
      "--format",
      "json",
    ]);
  });
  it("only ever emits the 'sql' subcommand (never another snow subcommand)", () => {
    const argv = buildSnowArgv(["snow"], "SHOW SCHEMAS", "c");
    // The subcommand slot immediately after the base is hard-coded to "sql".
    expect(argv[1]).toBe("sql");
    expect(argv).not.toContain("connection");
    expect(argv).not.toContain("stage");
  });
});

describe("runSnowQuery — argv + parsing", () => {
  const opts: SnowRunOptions = { connection: "analytics", command: "snow" };

  it("spawns with the exact expected argv", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "[]" });
    await runSnowQuery("SELECT 1", opts, spawn);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "snow",
      "sql",
      "-q",
      "SELECT 1",
      "--connection",
      "analytics",
      "--format",
      "json",
    ]);
  });

  it("parses a JSON array of row objects into rows + derived columns", async () => {
    const { spawn } = fakeSpawn({
      stdout: JSON.stringify([
        { id: 1, name: "a" },
        { id: 2, name: "b", extra: true },
      ]),
    });
    const out = await runSnowQuery("SELECT id, name FROM t", opts, spawn);
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(2);
    // Columns are the ordered union of keys across rows.
    expect(out.columns).toEqual(["id", "name", "extra"]);
  });

  it("zero rows returns columns:[] without crashing", async () => {
    const { spawn } = fakeSpawn({ stdout: "[]" });
    const out = await runSnowQuery("SELECT 1 WHERE 1=0", opts, spawn);
    expect(out.ok).toBe(true);
    expect(out.rows).toEqual([]);
    expect(out.columns).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it("malformed JSON → ok:false with a reason (never throws)", async () => {
    const { spawn } = fakeSpawn({ stdout: "not json {{" });
    const out = await runSnowQuery("SELECT 1", opts, spawn);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/malformed|unexpected/i);
  });

  it("a non-array JSON payload → ok:false", async () => {
    const { spawn } = fakeSpawn({ stdout: JSON.stringify({ not: "an array" }) });
    const out = await runSnowQuery("SELECT 1", opts, spawn);
    expect(out.ok).toBe(false);
  });

  it("missing connection is rejected WITHOUT spawning", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "[]" });
    const out = await runSnowQuery("SELECT 1", { connection: "  " }, spawn);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/connection/i);
    expect(calls).toHaveLength(0);
  });

  it("non-zero exit → ok:false", async () => {
    const { spawn } = fakeSpawn({ exitCode: 1, stderr: "boom" });
    const out = await runSnowQuery("SELECT 1", opts, spawn);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/exited 1/);
  });

  it("spawn error (ENOENT) → ok:false with spawnError", async () => {
    const { spawn } = fakeSpawn({ exitCode: null, spawnError: "Error: ENOENT" });
    const out = await runSnowQuery("SELECT 1", opts, spawn);
    expect(out.ok).toBe(false);
    expect(out.spawnError).toMatch(/ENOENT/);
  });

  it("defensively truncates parsed rows to the cap and sets truncated=true", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: i }));
    const { spawn } = fakeSpawn({ stdout: JSON.stringify(rows) });
    const out = await runSnowQuery("SELECT id FROM t", { ...opts, rowCap: 10 }, spawn);
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });

  it("snowsql dialect is a stub → ok:false, no spawn", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "[]" });
    const out = await runSnowQuery("SELECT 1", { ...opts, dialect: "snowsql" }, spawn);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/snowsql/i);
    expect(calls).toHaveLength(0);
  });
});

describe("SnowflakeWarehouseProvider — read-only gate + redaction", () => {
  /** Build a provider with an injected runner capturing the SQL it is handed. */
  function providerWith(
    handler: (sql: string) => SnowQueryOutcome,
    overrides: Partial<Parameters<typeof makeProvider>[0]> = {},
  ) {
    const seen: string[] = [];
    const provider = makeProvider({
      runner: async (sql: string) => {
        seen.push(sql);
        return handler(sql);
      },
      ...overrides,
    });
    return { provider, seen };
  }

  function makeProvider(opts: Record<string, unknown>) {
    return new SnowflakeWarehouseProvider({
      connection: "analytics",
      sql: { maxResultRows: 100 },
      ...opts,
    } as ConstructorParameters<typeof SnowflakeWarehouseProvider>[0]);
  }

  const ok = (rows: Array<Record<string, unknown>>): SnowQueryOutcome => ({
    ok: true,
    rows,
    columns: rows.length ? Object.keys(rows[0]!) : [],
    stdout: "",
    stderr: "",
  });

  it("rejects a write statement BEFORE any spawn (runner never called)", async () => {
    const { provider, seen } = providerWith(() => ok([]));
    const res = await provider.executeReadOnlySql("DELETE FROM customers");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/write\/DDL|blocked/i);
    expect(seen).toHaveLength(0);
  });

  it("rejects a multi-statement input BEFORE any spawn", async () => {
    const { provider, seen } = providerWith(() => ok([]));
    const res = await provider.executeReadOnlySql("SELECT 1; SELECT 2");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/multiple statements/i);
    expect(seen).toHaveLength(0);
  });

  it("rejects DDL (CREATE) before spawn", async () => {
    const { provider, seen } = providerWith(() => ok([]));
    const res = await provider.executeReadOnlySql("CREATE TABLE x (id int)");
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("runs the LIMIT-injected normalized SQL for a bare SELECT", async () => {
    const { provider, seen } = providerWith(() => ok([{ n: 1 }]));
    const res = await provider.executeReadOnlySql("SELECT n FROM t");
    expect(res.ok).toBe(true);
    expect(seen[0]).toMatch(/LIMIT 100$/);
  });

  it("redacts sensitive columns in returned rows", async () => {
    const { provider } = providerWith(() =>
      ok([{ customer_id: 1, email: "a@b.com", full_name: "Jane Roe" }]),
    );
    const res = await provider.executeReadOnlySql("SELECT * FROM customers");
    expect(res.ok).toBe(true);
    const row = res.data!.rows[0]!;
    expect(row.customer_id).toBe(1);
    expect(row.email).toBe("[REDACTED]");
    expect(row.full_name).toBe("[REDACTED]");
  });

  it("does NOT redact when maskSensitive is false", async () => {
    const { provider } = providerWith(() => ok([{ email: "a@b.com" }]), {
      maskSensitive: false,
    });
    const res = await provider.executeReadOnlySql("SELECT email FROM customers");
    expect(res.data!.rows[0]!.email).toBe("a@b.com");
  });

  it("propagates truncated from the runner outcome", async () => {
    const { provider } = providerWith(() => ({
      ok: true,
      rows: [{ n: 1 }],
      columns: ["n"],
      truncated: true,
      stdout: "",
      stderr: "",
    }));
    const res = await provider.executeReadOnlySql("SELECT n FROM t");
    expect(res.data!.truncated).toBe(true);
  });

  it("listSchemas issues SHOW SCHEMAS and extracts names", async () => {
    const { provider, seen } = providerWith(() =>
      ok([{ name: "analytics" }, { name: "raw" }]),
    );
    const schemas = await provider.listSchemas();
    expect(seen[0]).toBe("SHOW SCHEMAS");
    expect(schemas).toEqual(["analytics", "raw"]);
  });

  it("listTables quotes/escapes the schema as a string literal (no raw interpolation)", async () => {
    const { provider, seen } = providerWith((sql) => {
      if (/information_schema/i.test(sql)) {
        return ok([
          {
            table_name: "orders",
            column_name: "email",
            data_type: "TEXT",
            is_nullable: "YES",
          },
        ]);
      }
      return ok([]);
    });
    const tables = await provider.listTables("an'alytics");
    // The schema literal must be single-quote-escaped: an'alytics → 'an''alytics'.
    expect(seen[0]).toContain("'an''alytics'");
    expect(seen[0]).not.toContain("table_schema = an'alytics");
    expect(tables).toHaveLength(1);
    const col = tables[0]!.columns[0]!;
    expect(col.name).toBe("email");
    expect(col.sensitive).toBe(true);
    expect(col.nullable).toBe(true);
  });

  it("describeTable escapes both schema and table literals", async () => {
    const { provider, seen } = providerWith(() =>
      ok([{ column_name: "id", data_type: "NUMBER", is_nullable: "NO" }]),
    );
    const info = await provider.describeTable('sch"ema', "tab'le");
    expect(seen[0]).toContain("'tab''le'");
    expect(info.columns[0]!.name).toBe("id");
    expect(info.columns[0]!.nullable).toBe(false);
  });

  it("neutralizes a backslash-quote breakout in schema/table literals", async () => {
    const { provider, seen } = providerWith(() =>
      ok([{ column_name: "id", data_type: "NUMBER", is_nullable: "NO" }]),
    );
    // Snowflake processes backslash escapes inside single-quoted literals, so a
    // trailing `\` before the doubled quote would consume it (`\'` = escaped
    // quote) and let the UNION run as bare SQL. Escaping the backslash FIRST
    // (`\` → `\\`) keeps the closing quote intact and the payload inside the
    // literal.
    const table = "x\\' UNION SELECT secret FROM other_table";
    await provider.describeTable("analytics", table);
    expect(seen[0]).toContain(
      "'x\\\\'' UNION SELECT secret FROM other_table'",
    );
  });

  it("describeTable falls back to DESCRIBE (quoted idents) when info_schema is empty", async () => {
    const { provider, seen } = providerWith((sql) => {
      if (/information_schema/i.test(sql)) return ok([]);
      // DESCRIBE TABLE output shape.
      return ok([{ name: "id", type: "NUMBER", "null?": "N" }]);
    });
    const info = await provider.describeTable("analytics", "orders");
    // Second call is the DESCRIBE fallback with double-quoted identifiers.
    expect(seen[1]).toContain('DESCRIBE TABLE "analytics"."orders"');
    expect(info.columns[0]!.name).toBe("id");
    expect(info.columns[0]!.nullable).toBe(false);
  });

  it("explainSql validates the inner SQL and wraps it in EXPLAIN USING TEXT", async () => {
    const { provider, seen } = providerWith(() => ok([{ plan: "Seq Scan" }]));
    const res = await provider.explainSql("SELECT * FROM t");
    expect(res.ok).toBe(true);
    expect(seen[0]).toMatch(/^EXPLAIN USING TEXT SELECT \* FROM t/);
    expect(res.data!.plan).toContain("Seq Scan");
  });

  it("explainSql refuses a non-read-only inner statement before spawn", async () => {
    const { provider, seen } = providerWith(() => ok([]));
    const res = await provider.explainSql("DROP TABLE t");
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("health returns ok on a successful SELECT 1 probe", async () => {
    const { provider } = providerWith(() => ok([{ "1": 1 }]));
    const h = await provider.health();
    expect(h.state).toBe("ok");
  });

  it("health returns unavailable (never throws) when the probe fails", async () => {
    const { provider } = providerWith(() => ({
      ok: false,
      stdout: "",
      stderr: "",
      reason: "connection refused",
    }));
    const h = await provider.health();
    expect(h.state).toBe("unavailable");
    expect(h.detail).toMatch(/connection refused/);
  });

  it("all advertised capabilities are read-only (write:false)", () => {
    const { provider } = providerWith(() => ok([]));
    expect(provider.capabilities().every((c) => c.write === false)).toBe(true);
  });

  describe("audit ledger wiring", () => {
    function memorySink(): {
      sink: AuditSink;
      events: Array<{ event: AuditEvent; data: AuditData }>;
    } {
      const events: Array<{ event: AuditEvent; data: AuditData }> = [];
      return {
        sink: { record: (event, data) => void events.push({ event, data }) },
        events,
      };
    }

    function auditedProvider(handler: (sql: string) => SnowQueryOutcome) {
      const { sink, events } = memorySink();
      const { provider, seen } = providerWith(handler, { audit: sink });
      return { provider, seen, events };
    }

    it("records metadata traffic (SHOW SCHEMAS) as validated + executed", async () => {
      const { provider, events } = auditedProvider(() =>
        ok([{ name: "analytics" }]),
      );
      await provider.listSchemas();

      const validated = events.filter((e) => e.event === "sql_validated");
      const executed = events.filter((e) => e.event === "sql_executed");
      expect(validated).toHaveLength(1);
      expect(validated[0]!.data).toMatchObject({ allowed: true, keyword: "SHOW" });
      expect(executed).toHaveLength(1);
      expect(executed[0]!.data).toMatchObject({
        provider: "snowflake",
        query: "SHOW",
        ok: true,
        rows: 1,
        sql_sha256: sha256Hex("SHOW SCHEMAS"),
      });
    });

    it("records the DESCRIBE fallback statements the provider issues itself", async () => {
      const { provider, events } = auditedProvider((sql) => {
        if (/information_schema/i.test(sql)) return ok([]);
        return ok([{ name: "id", type: "NUMBER", "null?": "N" }]);
      });
      await provider.describeTable("analytics", "orders");

      const executed = events.filter((e) => e.event === "sql_executed");
      expect(executed).toHaveLength(2);
      expect(executed.map((e) => e.data.query)).toEqual(["SELECT", "DESCRIBE"]);
      expect(executed.every((e) => e.data.ok === true)).toBe(true);
    });

    it("records the health probe execution", async () => {
      const { provider, events } = auditedProvider(() => ok([{ "1": 1 }]));
      await provider.health();

      const executed = events.filter((e) => e.event === "sql_executed");
      expect(executed).toHaveLength(1);
      expect(executed[0]!.data).toMatchObject({
        query: "SELECT",
        ok: true,
        // The hash covers the statement actually run: the LIMIT-capped form.
        sql_sha256: sha256Hex("SELECT 1 LIMIT 100"),
      });
    });

    it("records a failed execution with the failure reason", async () => {
      const { provider, events } = auditedProvider(() => ({
        ok: false,
        stdout: "",
        stderr: "",
        reason: "connection refused",
      }));
      await provider.executeReadOnlySql("SELECT n FROM t LIMIT 5");

      const executed = events.filter((e) => e.event === "sql_executed");
      expect(executed).toHaveLength(1);
      expect(executed[0]!.data).toMatchObject({
        ok: false,
        error: "connection refused",
      });
    });

    it("a blocked statement records a verdict but never an execution", async () => {
      const { provider, seen, events } = auditedProvider(() => ok([]));
      const res = await provider.executeReadOnlySql("DELETE FROM customers");

      expect(res.ok).toBe(false);
      expect(seen).toHaveLength(0);
      const validated = events.filter((e) => e.event === "sql_validated");
      expect(validated).toHaveLength(1);
      expect(validated[0]!.data).toMatchObject({ allowed: false, keyword: "DELETE" });
      expect(events.some((e) => e.event === "sql_executed")).toBe(false);
    });

    it("never records raw SQL, identifiers, or result values", async () => {
      const { provider, events } = auditedProvider((sql) => {
        if (/information_schema/i.test(sql)) {
          return ok([
            {
              table_name: "orders",
              column_name: "email",
              data_type: "TEXT",
              is_nullable: "YES",
            },
          ]);
        }
        return ok([{ email: "a@b.com" }]);
      });
      await provider.listTables("analytics");
      await provider.executeReadOnlySql("SELECT email FROM customers");

      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        const payload = JSON.stringify(e.data);
        expect(payload).not.toMatch(/FROM\s/i);
        expect(payload).not.toContain("information_schema");
        expect(payload).not.toContain("customers");
        expect(payload).not.toContain("a@b.com");
      }
    });
  });
});
