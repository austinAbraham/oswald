/**
 * Snowflake warehouse provider — runs Oswald's read-only EDA SQL against
 * Snowflake by shelling out to the `snow` CLI (NON-MCP path).
 *
 * Structural clone of {@link MockWarehouseProvider}: same interface, same
 * validate-before-run discipline, same PII redaction. The only difference is the
 * backend — instead of a fixture, every statement is executed via {@link
 * runSnowQuery} (the single `snow`-spawning seam).
 *
 * SAFETY INVARIANTS:
 *   - READ-ONLY BEFORE SPAWN: every executed statement passes the
 *     SqlSafetyValidator FIRST; a write/DDL/multi-statement is refused WITHOUT
 *     spawning `snow`.
 *   - IDENTIFIER SAFETY: any schema/table name interpolated into SHOW/DESCRIBE/
 *     information_schema SQL is double-quoted (embedded `"` doubled); string
 *     literals are single-quoted (embedded `\` and `'` escaped). No raw
 *     interpolation.
 *   - PII REDACTION: result rows are passed through the SensitiveFieldDetector
 *     before they leave the provider.
 *   - NO SECRETS: only a connection NAME is held; credentials live in `snow`'s
 *     own config and never touch argv/env/logs.
 *   - AUDITED: with an {@link AuditSink}, the internal read-only gate records
 *     every verdict (`sql_validated`) and the single runner seam records every
 *     spawned statement (`sql_executed`) — statement hash + outcome only,
 *     never raw SQL — so metadata queries (SHOW/DESCRIBE/information_schema)
 *     land in the ledger alongside the EDA queries.
 */
import { sha256Hex, type AuditSink } from "../../core/audit/ledger.js";
import {
  SqlSafetyValidator,
  type SqlSafetyOptions,
} from "../../core/policy/sql-safety.js";
import { SensitiveFieldDetector } from "../../core/policy/sensitive.js";
import type {
  Capability,
  ColumnInfo,
  HealthReport,
  InvokeOptions,
  InvokeResult,
  QueryResult,
  TableInfo,
  WarehouseProvider,
} from "../providers/types.js";
import { runSnowQuery } from "./runner.js";
import type {
  SnowDialect,
  SnowQueryOutcome,
  SnowRunner,
  SnowRunOptions,
  SnowflakeProviderOptions,
} from "./types.js";

/** Double-quote a SQL identifier, doubling any embedded double-quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Single-quote a SQL string literal for Snowflake. Escapes backslashes FIRST
 * (Snowflake processes backslash escapes inside single-quoted literals, so a
 * lone `\` before a doubled quote would otherwise consume it and let the string
 * break out), then doubles embedded single-quotes.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** Row-shaped record with case-insensitive column lookup. */
function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in row) return row[name];
    const lower = name.toLowerCase();
    const upper = name.toUpperCase();
    if (lower in row) return row[lower];
    if (upper in row) return row[upper];
  }
  return undefined;
}

export class SnowflakeWarehouseProvider implements WarehouseProvider {
  readonly name = "snowflake";
  readonly kind = "warehouse" as const;

  private readonly command: string | undefined;
  private readonly connection: string;
  private readonly timeoutMs: number | undefined;
  private readonly dialect: SnowDialect;
  private readonly validator: SqlSafetyValidator;
  private readonly detector: SensitiveFieldDetector;
  private readonly runner: SnowRunner;
  private readonly audit: AuditSink | undefined;

  constructor(options: SnowflakeProviderOptions) {
    this.command = options.command;
    this.connection = options.connection;
    this.timeoutMs = options.timeoutMs;
    this.dialect = options.dialect ?? "snow";
    const sqlOptions: SqlSafetyOptions = options.sql ?? {};
    this.audit = options.audit ?? sqlOptions.audit;
    this.validator = new SqlSafetyValidator(
      this.audit ? { ...sqlOptions, audit: this.audit } : sqlOptions,
    );
    this.detector = new SensitiveFieldDetector({
      enabled: options.maskSensitive ?? true,
    });
    this.runner = options.runner ?? runSnowQuery;
  }

  capabilities(): Capability[] {
    return [
      { name: "listSchemas", write: false },
      { name: "listTables", write: false },
      { name: "describeTable", write: false },
      {
        name: "executeReadOnlySql",
        write: false,
        description: "Read-only; validated + LIMIT-capped; run via `snow sql`",
      },
      { name: "explainSql", write: false },
    ];
  }

  /** Common run options for the underlying runner. */
  private runOptions(): SnowRunOptions {
    return {
      command: this.command,
      connection: this.connection,
      dialect: this.dialect,
      rowCap: this.validator.rowCap,
      ...(this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
    };
  }

  /**
   * The single spawn seam: EVERY statement the provider actually runs goes
   * through here, so each execution lands in the audit ledger (statement hash,
   * leading keyword, and outcome only — never the SQL text or result values).
   */
  private async runRecorded(sql: string): Promise<SnowQueryOutcome> {
    try {
      const outcome = await this.runner(sql, this.runOptions());
      this.recordExecution(sql, {
        ok: outcome.ok,
        ...(outcome.rows ? { rows: outcome.rows.length } : {}),
        ...(outcome.truncated ? { truncated: true } : {}),
        ...(outcome.ok ? {} : { error: outcome.reason ?? "snow query failed" }),
      });
      return outcome;
    } catch (err) {
      this.recordExecution(sql, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Append one `sql_executed` record for a spawned statement. */
  private recordExecution(
    sql: string,
    outcome: Record<string, unknown>,
  ): void {
    this.audit?.record("sql_executed", {
      provider: this.name,
      query: sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "?",
      sql_sha256: sha256Hex(sql),
      ...outcome,
    });
  }

  /**
   * Validate a statement read-only, then run it via the runner. Returns the raw
   * runner outcome (rows not yet redacted). Refuses non-read-only WITHOUT
   * spawning. Internal — the public methods layer redaction / shaping on top.
   */
  private async runValidated(sql: string): Promise<SnowQueryOutcome> {
    const verdict = this.validator.validate(sql);
    if (!verdict.allowed) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        reason: verdict.reason ?? "blocked by SQL safety gate",
      };
    }
    return this.runRecorded(verdict.normalizedSql ?? sql);
  }

  async health(): Promise<HealthReport> {
    // Best-effort connectivity probe. Uses a read-only `SELECT 1` through the
    // same single spawn seam (the runner only ever emits `snow sql`), and
    // CATCHES everything so health never throws.
    try {
      const outcome = await this.runValidated("SELECT 1");
      if (outcome.ok) {
        return {
          state: "ok",
          detail: `snow connection '${this.connection}' reachable`,
        };
      }
      return {
        state: "unavailable",
        detail: `snow connection '${this.connection}' probe failed: ${
          outcome.reason ?? "unknown error"
        }`,
      };
    } catch (err) {
      return {
        state: "degraded",
        detail: `snow health probe errored: ${asMessage(err)}`,
      };
    }
  }

  async listSchemas(): Promise<string[]> {
    const outcome = await this.runValidated("SHOW SCHEMAS");
    if (!outcome.ok || !outcome.rows) return [];
    const names: string[] = [];
    for (const row of outcome.rows) {
      const name = pick(row, "name", "schema_name");
      if (typeof name === "string" && name) names.push(name);
    }
    return names;
  }

  async listTables(schema: string): Promise<TableInfo[]> {
    const tables = await this.tablesViaInformationSchema(schema);
    if (tables !== null) return tables;
    // Fallback: enumerate table names via SHOW TABLES, then DESCRIBE each.
    return this.tablesViaDescribe(schema);
  }

  async describeTable(schema: string, table: string): Promise<TableInfo> {
    const cols = await this.columnsViaInformationSchema(schema, table);
    if (cols !== null && cols.length > 0) {
      return { schema, name: table, columns: cols };
    }
    const fallback = await this.columnsViaDescribe(schema, table);
    return { schema, name: table, columns: fallback };
  }

  async executeReadOnlySql(sql: string): Promise<InvokeResult<QueryResult>> {
    // Read-only gate FIRST — refuse without spawning if not allowed.
    const verdict = this.validator.validate(sql);
    if (!verdict.allowed) {
      return { ok: false, error: verdict.reason };
    }
    const outcome = await this.runRecorded(verdict.normalizedSql ?? sql);
    if (!outcome.ok) {
      return { ok: false, error: outcome.reason ?? "snow query failed" };
    }
    const rawRows = outcome.rows ?? [];
    const rows = rawRows.map((r) => this.detector.redactRow(r));
    const result: QueryResult = {
      columns: outcome.columns ?? [],
      rows,
      ...(outcome.truncated ? { truncated: true } : {}),
    };
    return { ok: true, data: result };
  }

  async explainSql(sql: string): Promise<InvokeResult<{ plan: string }>> {
    // Validate the INNER sql read-only before wrapping it in EXPLAIN.
    const inner = this.validator.validate(sql);
    if (!inner.allowed) {
      return { ok: false, error: inner.reason };
    }
    const outcome = await this.runValidated(
      `EXPLAIN USING TEXT ${inner.normalizedSql ?? sql}`,
    );
    if (!outcome.ok) {
      return { ok: false, error: outcome.reason ?? "snow explain failed" };
    }
    // EXPLAIN rows carry plan text; join whatever string cells came back.
    const plan = (outcome.rows ?? [])
      .map((row) => Object.values(row).map((v) => String(v ?? "")).join(" "))
      .join("\n");
    return { ok: true, data: { plan } };
  }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    _options?: InvokeOptions,
  ): Promise<InvokeResult> {
    switch (toolName) {
      case "listSchemas":
        return { ok: true, data: await this.listSchemas() };
      case "listTables":
        return { ok: true, data: await this.listTables(String(args.schema)) };
      case "describeTable":
        return {
          ok: true,
          data: await this.describeTable(String(args.schema), String(args.table)),
        };
      case "executeReadOnlySql":
        return this.executeReadOnlySql(String(args.sql));
      case "explainSql":
        return this.explainSql(String(args.sql));
      default:
        return { ok: false, error: `unknown warehouse tool: ${toolName}` };
    }
  }

  // --- metadata helpers ----------------------------------------------------

  /**
   * Build a ColumnInfo from an information_schema.columns row, flagging PII by
   * name. Column keys from `snow` may be upper- or lower-case; look both up.
   */
  private toColumnInfo(row: Record<string, unknown>): ColumnInfo | null {
    const name = pick(row, "column_name");
    if (typeof name !== "string" || !name) return null;
    const type = pick(row, "data_type");
    const isNullable = pick(row, "is_nullable");
    return {
      name,
      type: typeof type === "string" ? type : String(type ?? "unknown"),
      nullable:
        typeof isNullable === "string"
          ? isNullable.toUpperCase() === "YES"
          : undefined,
      sensitive: this.detector.isSensitiveColumn(name),
    };
  }

  /**
   * List tables + columns for a schema via a single read-only
   * information_schema.columns SELECT. Returns null on failure so the caller can
   * fall back to DESCRIBE. The schema is passed as an escaped string literal.
   */
  private async tablesViaInformationSchema(
    schema: string,
  ): Promise<TableInfo[] | null> {
    const sql =
      `SELECT table_name, column_name, data_type, is_nullable, ordinal_position ` +
      `FROM information_schema.columns ` +
      `WHERE table_schema = ${quoteLiteral(schema)} ` +
      `ORDER BY table_name, ordinal_position`;
    const outcome = await this.runValidated(sql);
    if (!outcome.ok || !outcome.rows) return null;
    const byTable = new Map<string, ColumnInfo[]>();
    for (const row of outcome.rows) {
      const tableName = pick(row, "table_name");
      if (typeof tableName !== "string" || !tableName) continue;
      const col = this.toColumnInfo(row);
      if (!col) continue;
      const list = byTable.get(tableName) ?? [];
      list.push(col);
      byTable.set(tableName, list);
    }
    const out: TableInfo[] = [];
    for (const [name, columns] of byTable) {
      out.push({ schema, name, columns });
    }
    return out;
  }

  /** Columns for a single table via information_schema (null on failure). */
  private async columnsViaInformationSchema(
    schema: string,
    table: string,
  ): Promise<ColumnInfo[] | null> {
    const sql =
      `SELECT column_name, data_type, is_nullable, ordinal_position ` +
      `FROM information_schema.columns ` +
      `WHERE table_schema = ${quoteLiteral(schema)} ` +
      `AND table_name = ${quoteLiteral(table)} ` +
      `ORDER BY ordinal_position`;
    const outcome = await this.runValidated(sql);
    if (!outcome.ok || !outcome.rows) return null;
    const cols: ColumnInfo[] = [];
    for (const row of outcome.rows) {
      const col = this.toColumnInfo(row);
      if (col) cols.push(col);
    }
    return cols;
  }

  /**
   * Fallback: enumerate table names via `SHOW TABLES IN SCHEMA "<schema>"`, then
   * DESCRIBE each. Best-effort — returns whatever it can resolve.
   */
  private async tablesViaDescribe(schema: string): Promise<TableInfo[]> {
    const outcome = await this.runValidated(
      `SHOW TABLES IN SCHEMA ${quoteIdent(schema)}`,
    );
    if (!outcome.ok || !outcome.rows) return [];
    const out: TableInfo[] = [];
    for (const row of outcome.rows) {
      const tableName = pick(row, "name", "table_name");
      if (typeof tableName !== "string" || !tableName) continue;
      const columns = await this.columnsViaDescribe(schema, tableName);
      out.push({ schema, name: tableName, columns });
    }
    return out;
  }

  /** Fallback column resolver via `DESCRIBE TABLE "<schema>"."<table>"`. */
  private async columnsViaDescribe(
    schema: string,
    table: string,
  ): Promise<ColumnInfo[]> {
    const outcome = await this.runValidated(
      `DESCRIBE TABLE ${quoteIdent(schema)}.${quoteIdent(table)}`,
    );
    if (!outcome.ok || !outcome.rows) return [];
    const cols: ColumnInfo[] = [];
    for (const row of outcome.rows) {
      // DESCRIBE TABLE returns columns named "name", "type", "null?".
      const name = pick(row, "name", "column_name");
      if (typeof name !== "string" || !name) continue;
      const type = pick(row, "type", "data_type");
      const nullable = pick(row, "null?", "is_nullable");
      cols.push({
        name,
        type: typeof type === "string" ? type : String(type ?? "unknown"),
        nullable:
          typeof nullable === "string"
            ? nullable.toUpperCase() === "Y" || nullable.toUpperCase() === "YES"
            : undefined,
        sensitive: this.detector.isSensitiveColumn(name),
      });
    }
    return cols;
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
