import { describe, it, expect } from "vitest";
import { SqlSafetyValidator } from "../../src/core/policy/index.js";

const BLOCKED = [
  "DROP TABLE customers",
  "DELETE FROM customers WHERE 1=1",
  "TRUNCATE TABLE orders",
  "UPDATE customers SET email = 'x'",
  "INSERT INTO customers (id) VALUES (1)",
  "MERGE INTO target USING src ON target.id = src.id",
  "ALTER TABLE customers ADD COLUMN x int",
  "CREATE TABLE foo (id int)",
  "GRANT SELECT ON customers TO bob",
  "REVOKE SELECT ON customers FROM bob",
  "CALL my_proc()",
  "COPY INTO @stage FROM customers",
  "PUT file://x @stage",
  "GET @stage file://x",
];

const ALLOWED = [
  "SELECT * FROM customers",
  "WITH c AS (SELECT 1) SELECT * FROM c",
  "SHOW TABLES",
  "DESCRIBE customers",
  "DESC customers",
  "EXPLAIN SELECT 1",
];

describe("SqlSafetyValidator: blocked keywords", () => {
  const v = new SqlSafetyValidator();
  for (const sql of BLOCKED) {
    it(`blocks: ${sql.slice(0, 30)}`, () => {
      const r = v.validate(sql);
      expect(r.allowed).toBe(false);
      expect(r.reason).toBeTruthy();
    });
  }
});

describe("SqlSafetyValidator: allowed keywords", () => {
  const v = new SqlSafetyValidator();
  for (const sql of ALLOWED) {
    it(`allows: ${sql.slice(0, 30)}`, () => {
      const r = v.validate(sql);
      expect(r.allowed).toBe(true);
      expect(r.normalizedSql).toBeTruthy();
    });
  }
});

describe("SqlSafetyValidator: multi-statement", () => {
  it("blocks semicolon-separated statements by default", () => {
    const v = new SqlSafetyValidator();
    const r = v.validate("SELECT 1; SELECT 2");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/multiple statements/i);
  });

  it("blocks a benign SELECT smuggling a DROP after a semicolon", () => {
    const v = new SqlSafetyValidator();
    const r = v.validate("SELECT * FROM customers; DROP TABLE customers");
    expect(r.allowed).toBe(false);
  });

  it("allows multiple statements only when explicitly enabled, still checking each", () => {
    const v = new SqlSafetyValidator({ allowMultipleStatements: true });
    expect(v.validate("SELECT 1; SELECT 2").allowed).toBe(true);
    expect(v.validate("SELECT 1; DROP TABLE x").allowed).toBe(false);
  });

  it("ignores semicolons inside string literals", () => {
    const v = new SqlSafetyValidator();
    const r = v.validate("SELECT 'a;b' AS x");
    expect(r.allowed).toBe(true);
  });
});

describe("SqlSafetyValidator: comment evasion", () => {
  it("does not allow a DROP hidden after a comment", () => {
    const v = new SqlSafetyValidator();
    const r = v.validate("-- SELECT ok\nDROP TABLE customers");
    expect(r.allowed).toBe(false);
  });

  it("strips block comments and evaluates the real leading keyword", () => {
    const v = new SqlSafetyValidator();
    const r = v.validate("/* hi */ DELETE FROM customers");
    expect(r.allowed).toBe(false);
  });
});

describe("SqlSafetyValidator: LIMIT cap enforcement", () => {
  it("injects a LIMIT when none is present", () => {
    const v = new SqlSafetyValidator({ maxResultRows: 50 });
    const r = v.validate("SELECT * FROM customers");
    expect(r.allowed).toBe(true);
    expect(r.normalizedSql).toMatch(/LIMIT 50$/);
  });

  it("leaves an existing LIMIT untouched", () => {
    const v = new SqlSafetyValidator({ maxResultRows: 50 });
    const r = v.validate("SELECT * FROM customers LIMIT 5");
    expect(r.normalizedSql).toMatch(/LIMIT 5/);
    expect(r.normalizedSql).not.toMatch(/LIMIT 50/);
  });

  it("does not inject LIMIT into SHOW/DESCRIBE/EXPLAIN", () => {
    const v = new SqlSafetyValidator({ maxResultRows: 50 });
    expect(v.validate("SHOW TABLES").normalizedSql).not.toMatch(/LIMIT/);
    expect(v.validate("DESCRIBE customers").normalizedSql).not.toMatch(/LIMIT/);
  });

  it("can disable LIMIT injection", () => {
    const v = new SqlSafetyValidator({ enforceLimit: false });
    expect(v.validate("SELECT 1").normalizedSql).not.toMatch(/LIMIT/);
  });
});

describe("SqlSafetyValidator: degenerate input", () => {
  const v = new SqlSafetyValidator();
  it("blocks empty / whitespace", () => {
    expect(v.validate("").allowed).toBe(false);
    expect(v.validate("   ").allowed).toBe(false);
  });
  it("blocks comment-only input", () => {
    expect(v.validate("-- just a comment").allowed).toBe(false);
  });
});
