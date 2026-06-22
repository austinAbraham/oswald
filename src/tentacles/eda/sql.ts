/**
 * Deterministic EDA SQL generation + result interpretation.
 *
 * Pure functions only — no LLM, no network, no I/O. These build the *read-only*
 * SQL the EDA tentacle uses to inspect candidate warehouse sources (schema /
 * column discovery, row-count / null-rate / uniqueness profiling, grain
 * inference, date-range & freshness, duplicate detection, join-path probes,
 * count comparison). Every statement this module emits is a SELECT/WITH/SHOW/
 * DESCRIBE form so it passes the SqlSafetyValidator; the tentacle re-validates
 * each one before it is ever written or executed (defense in depth).
 *
 * The functions also interpret the structured results (TableInfo / QueryResult)
 * deterministically into grain, quality, and join findings. Nothing here trusts
 * the *values* returned — sensitive columns are profiled by aggregate, never by
 * sampling raw values, and column NAMES from the warehouse are treated as
 * untrusted identifiers (quoted, never interpolated as SQL fragments).
 */
import type {
  ColumnInfo,
  TableInfo,
} from "../../tools/index.js";

// ---------------------------------------------------------------------------
// Identifier hygiene — warehouse-supplied names are untrusted.
// ---------------------------------------------------------------------------

/**
 * Quote a SQL identifier with double quotes, escaping embedded quotes. We never
 * splice a raw warehouse-supplied name into a statement unquoted, so a hostile
 * column/table name cannot break out of its identifier position.
 */
export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Fully-qualified `"schema"."table"` reference. */
export function qualify(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

// ---------------------------------------------------------------------------
// A named, categorized SQL query the tentacle will persist / (optionally) run.
// ---------------------------------------------------------------------------

export type EdaQueryKind =
  | "discovery"
  | "describe"
  | "row_count"
  | "column_profile"
  | "grain"
  | "freshness"
  | "duplicates"
  | "join"
  | "count_compare";

export interface EdaQuery {
  /** Slug used as the `.sql` filename (no extension). */
  name: string;
  kind: EdaQueryKind;
  /** Human description of what the query establishes. */
  description: string;
  /** The read-only SQL text (pre-validation). */
  sql: string;
}

// ---------------------------------------------------------------------------
// Column classification heuristics (deterministic, name-based).
// ---------------------------------------------------------------------------

const ID_SUFFIXES = ["_id", "_key", "_pk", "_uuid", "_guid"];
const ID_EXACT = new Set(["id", "key", "pk", "uuid", "guid"]);

/** Whether a column name looks like an identifier / key candidate. */
export function looksLikeId(name: string): boolean {
  const n = name.toLowerCase();
  if (ID_EXACT.has(n)) return true;
  return ID_SUFFIXES.some((s) => n.endsWith(s));
}

const DATE_TYPE_RE = /\b(date|timestamp|timestamptz|datetime|time)\b/i;
const DATE_NAME_RE = /(_at|_date|_ts|_time|_on|date|timestamp)$|^(date|created|updated|modified)/i;

/** Whether a column is a date/time column (by type, falling back to name). */
export function looksLikeDate(col: ColumnInfo): boolean {
  if (col.type && DATE_TYPE_RE.test(col.type)) return true;
  return DATE_NAME_RE.test(col.name);
}

const NUMERIC_TYPE_RE = /\b(int|integer|bigint|smallint|numeric|decimal|float|double|real|number)\b/i;

export function looksLikeNumeric(col: ColumnInfo): boolean {
  return Boolean(col.type && NUMERIC_TYPE_RE.test(col.type));
}

// ---------------------------------------------------------------------------
// Query builders. Each returns read-only SQL only.
// ---------------------------------------------------------------------------

/** Discover the tables/columns in a schema (information_schema, read-only). */
export function buildSchemaDiscoveryQuery(schema: string): EdaQuery {
  // information_schema.columns is portable across the warehouses we target.
  const lit = sqlStringLiteral(schema);
  return {
    name: `discover__${slug(schema)}`,
    kind: "discovery",
    description: `List tables and columns in schema ${schema}`,
    sql: [
      "SELECT table_name, column_name, data_type, is_nullable",
      "FROM information_schema.columns",
      `WHERE table_schema = ${lit}`,
      "ORDER BY table_name, ordinal_position",
    ].join("\n"),
  };
}

/** Estimate / count rows for a table. */
export function buildRowCountQuery(table: TableInfo): EdaQuery {
  const ref = qualify(table.schema, table.name);
  return {
    name: `row_count__${slug(table.schema)}__${slug(table.name)}`,
    kind: "row_count",
    description: `Total row count for ${table.schema}.${table.name}`,
    sql: `SELECT COUNT(*) AS row_count FROM ${ref}`,
  };
}

/**
 * Per-column profile: null rate + distinct count. Sensitive columns are STILL
 * profiled (aggregates only) — we never select raw values, so no PII leaves the
 * warehouse. One aggregate query per table covering every column.
 */
export function buildColumnProfileQuery(table: TableInfo): EdaQuery {
  const ref = qualify(table.schema, table.name);
  const selects = ["COUNT(*) AS total_rows"];
  for (const col of table.columns) {
    const c = quoteIdent(col.name);
    const tag = slug(col.name);
    selects.push(`COUNT(${c}) AS nonnull__${tag}`);
    selects.push(`COUNT(DISTINCT ${c}) AS distinct__${tag}`);
  }
  return {
    name: `profile__${slug(table.schema)}__${slug(table.name)}`,
    kind: "column_profile",
    description: `Null rate + distinct count per column for ${table.schema}.${table.name} (aggregates only — no raw values)`,
    sql: [`SELECT`, `  ${selects.join(",\n  ")}`, `FROM ${ref}`].join("\n"),
  };
}

/**
 * Grain probe: for the inferred candidate key columns, check whether the
 * combination is unique (count vs distinct). Returns null if no candidate key.
 */
export function buildGrainQuery(table: TableInfo, keyCols: string[]): EdaQuery | null {
  if (keyCols.length === 0) return null;
  const ref = qualify(table.schema, table.name);
  const keyList = keyCols.map(quoteIdent).join(", ");
  return {
    name: `grain__${slug(table.schema)}__${slug(table.name)}`,
    kind: "grain",
    description: `Uniqueness of candidate grain (${keyCols.join(", ")}) for ${table.schema}.${table.name}`,
    sql: [
      "SELECT",
      "  COUNT(*) AS total_rows,",
      `  COUNT(DISTINCT (${keyList}::text)) AS distinct_keys`,
      `FROM ${ref}`,
    ].join("\n"),
  };
}

/** Date-range + freshness for a date column. */
export function buildFreshnessQuery(table: TableInfo, dateCol: string): EdaQuery {
  const ref = qualify(table.schema, table.name);
  const c = quoteIdent(dateCol);
  return {
    name: `freshness__${slug(table.schema)}__${slug(table.name)}__${slug(dateCol)}`,
    kind: "freshness",
    description: `Min/max + range of ${dateCol} for ${table.schema}.${table.name}`,
    sql: [
      "SELECT",
      `  MIN(${c}) AS min_value,`,
      `  MAX(${c}) AS max_value,`,
      `  COUNT(*) AS total_rows,`,
      `  COUNT(${c}) AS nonnull_rows`,
      `FROM ${ref}`,
    ].join("\n"),
  };
}

/** Duplicate-key probe: rows that share the candidate key (top offenders). */
export function buildDuplicatesQuery(
  table: TableInfo,
  keyCols: string[],
  topN = 20,
): EdaQuery | null {
  if (keyCols.length === 0) return null;
  const ref = qualify(table.schema, table.name);
  const keyList = keyCols.map(quoteIdent).join(", ");
  return {
    name: `duplicates__${slug(table.schema)}__${slug(table.name)}`,
    kind: "duplicates",
    description: `Duplicate ${keyCols.join(", ")} values in ${table.schema}.${table.name} (key + count only — no other columns)`,
    sql: [
      `SELECT ${keyList}, COUNT(*) AS dup_count`,
      `FROM ${ref}`,
      `GROUP BY ${keyList}`,
      "HAVING COUNT(*) > 1",
      "ORDER BY dup_count DESC",
      `LIMIT ${Math.max(1, Math.floor(topN))}`,
    ].join("\n"),
  };
}

export interface JoinCandidate {
  left: TableInfo;
  right: TableInfo;
  /** Column shared (by name) on both sides. */
  column: string;
}

/**
 * Join-path probe: how many distinct keys on the left match the right side.
 * Pure aggregate; surfaces fan-out / orphan risk without returning raw rows.
 */
export function buildJoinQuery(candidate: JoinCandidate): EdaQuery {
  const l = qualify(candidate.left.schema, candidate.left.name);
  const r = qualify(candidate.right.schema, candidate.right.name);
  const col = quoteIdent(candidate.column);
  const name = `join__${slug(candidate.left.name)}__${slug(candidate.right.name)}__${slug(candidate.column)}`;
  return {
    name,
    kind: "join",
    description: `Join coverage on ${candidate.column}: ${candidate.left.name} → ${candidate.right.name}`,
    sql: [
      "SELECT",
      `  COUNT(DISTINCT l.${col}) AS left_keys,`,
      `  COUNT(DISTINCT r.${col}) AS matched_keys`,
      `FROM ${l} AS l`,
      `LEFT JOIN ${r} AS r ON l.${col} = r.${col}`,
    ].join("\n"),
  };
}

/** Compare row counts between two tables (count reconciliation). */
export function buildCountCompareQuery(left: TableInfo, right: TableInfo): EdaQuery {
  const l = qualify(left.schema, left.name);
  const r = qualify(right.schema, right.name);
  return {
    name: `count_compare__${slug(left.name)}__${slug(right.name)}`,
    kind: "count_compare",
    description: `Compare row counts: ${left.name} vs ${right.name}`,
    sql: [
      "SELECT",
      `  (SELECT COUNT(*) FROM ${l}) AS left_rows,`,
      `  (SELECT COUNT(*) FROM ${r}) AS right_rows`,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Deterministic inference over table metadata.
// ---------------------------------------------------------------------------

/**
 * Infer a candidate grain (set of key columns) for a table from column names.
 * Heuristic: prefer a single column literally named `id`/`<table>_id`; otherwise
 * collect id-like columns. Returns [] if none look like keys.
 */
export function inferCandidateKey(table: TableInfo): string[] {
  const ids = table.columns.filter((c) => looksLikeId(c.name)).map((c) => c.name);
  if (ids.length === 0) return [];

  // Singular surrogate key: exact `id` or `<table>_id` / `<table-singular>_id`.
  const singular = table.name.replace(/s$/, "");
  const preferred = ids.find(
    (n) =>
      n.toLowerCase() === "id" ||
      n.toLowerCase() === `${table.name.toLowerCase()}_id` ||
      n.toLowerCase() === `${singular.toLowerCase()}_id`,
  );
  if (preferred) return [preferred];

  // Otherwise treat the id-like columns as a composite key candidate.
  return ids;
}

/** Pick the date columns (for freshness probing). */
export function dateColumns(table: TableInfo): string[] {
  return table.columns.filter(looksLikeDate).map((c) => c.name);
}

/** The sensitive (PII-by-name) columns of a table. */
export function sensitiveColumns(
  table: TableInfo,
  isSensitive: (name: string) => boolean,
): string[] {
  return table.columns
    .filter((c) => c.sensitive === true || isSensitive(c.name))
    .map((c) => c.name);
}

/**
 * Find join candidates: id-like columns that appear (by name) in more than one
 * table across the provided set. Deterministic, name-based only.
 */
export function inferJoinCandidates(tables: TableInfo[]): JoinCandidate[] {
  const byColumn = new Map<string, TableInfo[]>();
  for (const t of tables) {
    for (const c of t.columns) {
      if (!looksLikeId(c.name)) continue;
      const key = c.name.toLowerCase();
      const arr = byColumn.get(key) ?? [];
      arr.push(t);
      byColumn.set(key, arr);
    }
  }
  const candidates: JoinCandidate[] = [];
  for (const [col, ts] of byColumn) {
    if (ts.length < 2) continue;
    // Pair the first table with each subsequent one sharing the column.
    for (let i = 1; i < ts.length; i += 1) {
      candidates.push({ left: ts[0]!, right: ts[i]!, column: col });
    }
  }
  // Deterministic ordering.
  candidates.sort((a, b) =>
    `${a.left.name}.${a.right.name}.${a.column}`.localeCompare(
      `${b.left.name}.${b.right.name}.${b.column}`,
    ),
  );
  return candidates;
}

// ---------------------------------------------------------------------------
// Result interpretation (reads structured QueryResult rows, never raw PII).
// ---------------------------------------------------------------------------

export interface GrainVerdict {
  table: string;
  keyCols: string[];
  totalRows: number | null;
  distinctKeys: number | null;
  /** "unique" | "duplicates" | "unknown". */
  status: "unique" | "duplicates" | "unknown";
}

export function interpretGrain(
  table: TableInfo,
  keyCols: string[],
  row: Record<string, unknown> | undefined,
): GrainVerdict {
  const totalRows = numberOrNull(row?.["total_rows"]);
  const distinctKeys = numberOrNull(row?.["distinct_keys"]);
  let status: GrainVerdict["status"] = "unknown";
  if (totalRows !== null && distinctKeys !== null) {
    status = totalRows === distinctKeys ? "unique" : "duplicates";
  }
  return {
    table: `${table.schema}.${table.name}`,
    keyCols,
    totalRows,
    distinctKeys,
    status,
  };
}

// ---------------------------------------------------------------------------
// Small string helpers.
// ---------------------------------------------------------------------------

/** A single-quoted SQL string literal (escaped). */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Filesystem-safe slug for query filenames (a-z0-9_ only). */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_") || "x";
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}
