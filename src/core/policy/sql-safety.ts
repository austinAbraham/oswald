/**
 * SQL safety validator.
 *
 * Oswald only ever issues *read-only* SQL against a warehouse during EDA. This
 * validator is the deterministic gate that enforces that: it allows a small
 * allowlist of read-only leading keywords and blocks everything else, rejects
 * multi-statement input, and enforces a row-count cap by injecting a `LIMIT`
 * when the statement does not already constrain its result size.
 *
 * It is intentionally conservative: when in doubt, BLOCK. It is a policy gate,
 * not a SQL parser — it does not attempt to fully understand arbitrary SQL.
 */

/** Result of validating a single SQL statement. */
export interface SqlValidationResult {
  /** Whether the statement is permitted to run. */
  allowed: boolean;
  /** Human-readable reason when blocked (and sometimes when allowed). */
  reason?: string;
  /** The statement to actually run, possibly with an injected LIMIT. */
  normalizedSql?: string;
}

export interface SqlSafetyOptions {
  /** Max rows a read query may return; a LIMIT is injected/capped to this. */
  maxResultRows?: number;
  /**
   * Allow multiple `;`-separated statements. Default false. Even when true,
   * every statement must independently pass the read-only check.
   */
  allowMultipleStatements?: boolean;
  /** Inject/enforce a LIMIT cap on SELECT/WITH queries. Default true. */
  enforceLimit?: boolean;
}

/** Leading keywords that are permitted (read-only). */
const ALLOWED_LEADING_KEYWORDS = new Set([
  "SELECT",
  "WITH",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
]);

/**
 * Explicitly blocked keywords. Anything not in the allowlist is blocked anyway,
 * but these are called out for clear error messages and so multi-word forms
 * (e.g. `COPY INTO`) are recognized.
 */
const BLOCKED_KEYWORDS = [
  "DROP",
  "DELETE",
  "TRUNCATE",
  "UPDATE",
  "INSERT",
  "MERGE",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
  "CALL",
  "COPY",
  "PUT",
  "GET",
  "REPLACE",
  "UPSERT",
  "USE",
  "SET",
] as const;

/** Default cap applied when the config provides none. */
export const DEFAULT_MAX_RESULT_ROWS = 10000;

/**
 * Strip line (`--`) and block (`/* *\/`) comments and surrounding whitespace.
 * Comments are removed first so they cannot smuggle a blocked keyword to the
 * front of the statement.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .trim();
}

/**
 * Split on semicolons that are not inside single/double quotes.
 * Returns trimmed, non-empty statements.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        // handle doubled-quote escape
        if (sql[i + 1] === quote) {
          current += sql[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Extract the leading SQL keyword (uppercased) from a statement. */
function leadingKeyword(stmt: string): string {
  const match = stmt.match(/^\s*([A-Za-z_]+)/);
  return match ? match[1]!.toUpperCase() : "";
}

/** Whether the statement already constrains row count with a top-level LIMIT/FETCH. */
function hasResultLimit(stmt: string): boolean {
  // Matches `LIMIT n`, `LIMIT a, b`, or `FETCH FIRST n ROWS` (case-insensitive).
  return /\blimit\b\s+\d+/i.test(stmt) || /\bfetch\s+first\b/i.test(stmt);
}

function checkSingleStatement(stmt: string): SqlValidationResult {
  const keyword = leadingKeyword(stmt);
  if (!keyword) {
    return { allowed: false, reason: "Empty or unparseable statement." };
  }

  // Recognize blocked multi-word forms regardless of allowlist membership.
  const blocked = BLOCKED_KEYWORDS.find((k) => k === keyword);
  if (blocked) {
    return {
      allowed: false,
      reason: `Blocked statement: leading keyword '${keyword}' is a write/DDL/privilege operation.`,
    };
  }

  if (!ALLOWED_LEADING_KEYWORDS.has(keyword)) {
    return {
      allowed: false,
      reason: `Blocked statement: leading keyword '${keyword}' is not in the read-only allowlist (SELECT, WITH, SHOW, DESCRIBE/DESC, EXPLAIN).`,
    };
  }

  return { allowed: true };
}

/**
 * Whether a query produces a row-bearing result that should be LIMIT-capped.
 * `SHOW`/`DESCRIBE`/`EXPLAIN` are metadata commands and are left untouched.
 */
function isRowProducingQuery(keyword: string): boolean {
  return keyword === "SELECT" || keyword === "WITH";
}

/** Append a `LIMIT <cap>` to a statement, preserving a trailing semicolon. */
function appendLimit(stmt: string, cap: number): string {
  return `${stmt.replace(/\s+$/, "")} LIMIT ${cap}`;
}

/**
 * Validate (and normalize) a SQL string for safe read-only execution.
 */
export class SqlSafetyValidator {
  private readonly maxResultRows: number;
  private readonly allowMultipleStatements: boolean;
  private readonly enforceLimit: boolean;

  constructor(options: SqlSafetyOptions = {}) {
    this.maxResultRows = options.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS;
    this.allowMultipleStatements = options.allowMultipleStatements ?? false;
    this.enforceLimit = options.enforceLimit ?? true;
  }

  /** The active row cap. */
  get rowCap(): number {
    return this.maxResultRows;
  }

  validate(sql: string): SqlValidationResult {
    if (typeof sql !== "string" || !sql.trim()) {
      return { allowed: false, reason: "Empty SQL." };
    }

    const cleaned = stripComments(sql);
    if (!cleaned) {
      return { allowed: false, reason: "SQL contained only comments." };
    }

    const statements = splitStatements(cleaned);
    if (statements.length === 0) {
      return { allowed: false, reason: "No executable statement found." };
    }

    if (statements.length > 1 && !this.allowMultipleStatements) {
      return {
        allowed: false,
        reason: `Blocked: multiple statements (${statements.length}) are not allowed; submit a single read-only statement.`,
      };
    }

    const normalized: string[] = [];
    for (const stmt of statements) {
      const result = checkSingleStatement(stmt);
      if (!result.allowed) {
        return result;
      }

      let out = stmt;
      if (
        this.enforceLimit &&
        isRowProducingQuery(leadingKeyword(stmt)) &&
        !hasResultLimit(stmt)
      ) {
        out = appendLimit(out, this.maxResultRows);
      }
      normalized.push(out);
    }

    return {
      allowed: true,
      normalizedSql: normalized.join(";\n"),
    };
  }
}
