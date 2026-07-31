/**
 * Typed contracts for the Snowflake CLI (`snow`) execution path.
 *
 * These shapes are the boundary between Oswald and the `snow` binary. The design
 * mirrors the dbt runner's types: stable, transport-decoupled, and carrying only
 * what crosses the process edge. In particular NO secrets ever appear here — only
 * a connection *name* (`connection`) which `snow` resolves against its own
 * on-disk config (`~/.snowflake/connections.toml`). Credentials never enter
 * argv, env, logs, or artifacts.
 */
import type { AuditSink } from "../../core/audit/ledger.js";
import type { SqlSafetyOptions } from "../../core/policy/sql-safety.js";

/**
 * Which CLI dialect drives the query. `snow` (the modern Snowflake CLI) is the
 * only fully-implemented path. `snowsql` is reserved so the legacy client can be
 * added later WITHOUT reshaping the runner; today it is a clearly-marked stub.
 */
export type SnowDialect = "snow" | "snowsql";

/** Options for a single {@link runSnowQuery} invocation. */
export interface SnowRunOptions {
  /**
   * The CLI invocation. A single shell-style string, whitespace-split into argv
   * (NOT run through a shell). Defaults to "snow". Example: "snow" or a wrapper
   * like "poetry run snow".
   */
  command?: string;
  /** The `snow` connection NAME (not credentials). Required — resolved by `snow`. */
  connection: string;
  /** Timeout in ms for the subprocess. Default 120000 (2 min). */
  timeoutMs?: number;
  /** CLI dialect. Only "snow" is implemented; "snowsql" is a stub. */
  dialect?: SnowDialect;
  /** Extra environment variables for the subprocess (never used for secrets). */
  env?: Record<string, string>;
  /**
   * Hard cap on the number of parsed rows returned. Rows beyond the cap are
   * dropped defensively (client-side) and `truncated` is set. REQUIRED for a
   * bounded result; when omitted a conservative default is applied.
   */
  rowCap?: number;
}

/** The typed outcome of a single `snow` query invocation. Never thrown. */
export interface SnowQueryOutcome {
  /** True when the query ran and produced parseable JSON rows. */
  ok: boolean;
  /** Process exit code (0 = clean). `null` when nothing ran or on spawn error. */
  exitCode?: number | null;
  /** Parsed result rows (defensively truncated to the cap). */
  rows?: Array<Record<string, unknown>>;
  /** Column names derived from the row keys (union across rows; [] when empty). */
  columns?: string[];
  /** True when rows were truncated client-side to the caller-supplied cap. */
  truncated?: boolean;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Human-readable reason when not ok (validation/parse/spawn failure). */
  reason?: string;
  /** Set to a short token ("timeout" / the OS error) when the spawn itself failed. */
  spawnError?: string;
}

/** A pluggable runner function (defaults to {@link runSnowQuery}; injected in tests). */
export type SnowRunner = (
  sql: string,
  options: SnowRunOptions,
) => Promise<SnowQueryOutcome>;

/** Options for {@link SnowflakeWarehouseProvider}. */
export interface SnowflakeProviderOptions {
  /** The `snow` invocation (whitespace-split into argv). Defaults to "snow". */
  command?: string;
  /** The `snow` connection NAME. Required — no credentials cross this boundary. */
  connection: string;
  /** Subprocess timeout in ms. Default 120000. */
  timeoutMs?: number;
  /** CLI dialect. Only "snow" is implemented; "snowsql" is a stub. */
  dialect?: SnowDialect;
  /** SQL safety options (row cap / limit enforcement) for the read-only gate. */
  sql?: SqlSafetyOptions;
  /** Whether PII redaction is enabled (from privacy policy). Default true. */
  maskSensitive?: boolean;
  /**
   * Optional audit sink. When present, the provider's internal read-only gate
   * records every validation verdict AND every statement the provider spawns
   * (health probes, SHOW/DESCRIBE/information_schema metadata, EXPLAIN, and
   * executed EDA SQL) — statement hash + outcome only, never raw SQL.
   */
  audit?: AuditSink;
  /** Injectable runner (tests). Defaults to the real {@link runSnowQuery}. */
  runner?: SnowRunner;
}
