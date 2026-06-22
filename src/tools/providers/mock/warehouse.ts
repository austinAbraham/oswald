/**
 * Mock warehouse provider — serves fixture schema + mock EDA results.
 *
 * All SQL goes through the SqlSafetyValidator first, so even in mock mode a
 * write/DDL statement is rejected exactly as it would be in production. Sensitive
 * columns are marked and their sample values redacted.
 */
import {
  SqlSafetyValidator,
  type SqlSafetyOptions,
} from "../../../core/policy/sql-safety.js";
import { SensitiveFieldDetector } from "../../../core/policy/sensitive.js";
import type {
  Capability,
  ColumnInfo,
  HealthReport,
  InvokeOptions,
  InvokeResult,
  QueryResult,
  TableInfo,
  WarehouseProvider,
} from "../types.js";

export interface MockWarehouseFixture {
  /** schema → tables. */
  schemas: Record<string, TableInfo[]>;
  /** Optional canned query results keyed by a normalized SQL substring. */
  cannedResults?: Array<{ match: string; result: QueryResult }>;
}

export interface MockWarehouseOptions {
  fixture?: MockWarehouseFixture;
  sql?: SqlSafetyOptions;
  detector?: SensitiveFieldDetector;
}

const DEFAULT_FIXTURE: MockWarehouseFixture = {
  schemas: {
    analytics: [
      {
        schema: "analytics",
        name: "customers",
        rowCountEstimate: 1000,
        columns: [
          { name: "customer_id", type: "integer", nullable: false },
          { name: "email", type: "varchar" },
          { name: "full_name", type: "varchar" },
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
};

export class MockWarehouseProvider implements WarehouseProvider {
  readonly name = "mock-warehouse";
  readonly kind = "warehouse" as const;

  private readonly fixture: MockWarehouseFixture;
  private readonly validator: SqlSafetyValidator;
  private readonly detector: SensitiveFieldDetector;

  constructor(options: MockWarehouseOptions = {}) {
    this.fixture = options.fixture ?? DEFAULT_FIXTURE;
    this.validator = new SqlSafetyValidator(options.sql);
    this.detector = options.detector ?? new SensitiveFieldDetector();
  }

  capabilities(): Capability[] {
    return [
      { name: "listSchemas", write: false },
      { name: "listTables", write: false },
      { name: "describeTable", write: false },
      { name: "executeReadOnlySql", write: false, description: "Read-only; validated + LIMIT-capped" },
      { name: "explainSql", write: false },
    ];
  }

  async health(): Promise<HealthReport> {
    const n = Object.keys(this.fixture.schemas).length;
    return { state: "ok", detail: `${n} schema(s) in fixture` };
  }

  async listSchemas(): Promise<string[]> {
    return Object.keys(this.fixture.schemas);
  }

  async listTables(schema: string): Promise<TableInfo[]> {
    return (this.fixture.schemas[schema] ?? []).map((t) => this.markSensitive(t));
  }

  async describeTable(schema: string, table: string): Promise<TableInfo> {
    const found = (this.fixture.schemas[schema] ?? []).find((t) => t.name === table);
    if (!found) {
      throw new Error(`mock-warehouse: ${schema}.${table} not found`);
    }
    return this.markSensitive(found);
  }

  private markSensitive(table: TableInfo): TableInfo {
    return {
      ...table,
      columns: table.columns.map(
        (c): ColumnInfo => ({
          ...c,
          sensitive: this.detector.isSensitiveColumn(c.name),
        }),
      ),
    };
  }

  async executeReadOnlySql(sql: string): Promise<InvokeResult<QueryResult>> {
    const verdict = this.validator.validate(sql);
    if (!verdict.allowed) {
      return { ok: false, error: verdict.reason };
    }

    const normalized = verdict.normalizedSql ?? sql;
    const canned = this.fixture.cannedResults?.find((c) =>
      normalized.toLowerCase().includes(c.match.toLowerCase()),
    );
    const base: QueryResult = canned
      ? canned.result
      : { columns: ["result"], rows: [{ result: "ok" }] };

    // Redact any sensitive columns in the rows.
    const rows = base.rows.map((r) => this.detector.redactRow(r));
    return { ok: true, data: { ...base, rows } };
  }

  async explainSql(sql: string): Promise<InvokeResult<{ plan: string }>> {
    const verdict = this.validator.validate(sql);
    if (!verdict.allowed) {
      return { ok: false, error: verdict.reason };
    }
    return { ok: true, data: { plan: `MOCK PLAN for: ${verdict.normalizedSql ?? sql}` } };
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
}
