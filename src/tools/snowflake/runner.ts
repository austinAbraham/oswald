/**
 * The Snowflake runner — the ONE place in Oswald that shells out to `snow`.
 *
 * Design rules (mirroring the dbt runner exactly):
 *   - NO SHELL: the invocation string is whitespace-split and passed to `spawn`
 *     argv-style; SQL is a single `-q` argv element. We never interpolate into a
 *     shell, so there is no command-injection surface.
 *   - ONLY THE `sql` SUBCOMMAND is ever emitted. This runner never runs
 *     `connection`, `stage`, or any other `snow` subcommand — read-only SQL only.
 *   - NO SECRETS: only a connection NAME crosses the boundary (`--connection`).
 *     Credentials live in `snow`'s own config; they never enter argv/env/logs.
 *   - DEFENSIVE BOUNDS: parsed rows are truncated client-side to a caller cap
 *     (all result paths, incl. SHOW/DESCRIBE/EXPLAIN) and buffered stdout is
 *     size-bounded. Malformed/unexpected JSON is reported as `ok:false` — the
 *     runner NEVER throws for an expected failure.
 *   - CONFIGURABLE INVOCATION: `command` defaults to "snow" but can be a wrapper.
 *
 * The read-only enforcement itself lives in the warehouse provider, which runs
 * every statement through the SqlSafetyValidator BEFORE calling this runner. The
 * runner is transport only.
 */
import { spawn } from "node:child_process";
import type { SnowQueryOutcome, SnowRunOptions } from "./types.js";

/** Default subprocess timeout (2 min) when the caller provides none. */
const DEFAULT_TIMEOUT_MS = 120000;
/** Default defensive row cap when the caller provides none. */
const DEFAULT_ROW_CAP = 10000;
/**
 * Hard ceiling on buffered stdout (~16 MiB). A read-only, LIMIT-capped query
 * should never approach this; the bound protects against a pathological /
 * unexpected response streaming unbounded memory into the process.
 */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/** Split a configurable invocation string into argv. No shell interpretation. */
export function splitInvocation(command: string | undefined): string[] {
  const raw = (command ?? "snow").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["snow"];
}

/**
 * Build the exact argv for a read-only `snow sql` invocation. Pure + deterministic
 * (unit-tested directly): `[...base, "sql", "-q", <sql>, "--connection", <name>,
 * "--format", "json"]`. The `sql` subcommand is hard-coded here so no other
 * subcommand can ever be emitted.
 */
export function buildSnowArgv(
  base: string[],
  sql: string,
  connection: string,
): string[] {
  return [
    ...base,
    "sql",
    "-q",
    sql,
    "--connection",
    connection,
    "--format",
    "json",
  ];
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/** Injectable low-level spawn (tests pass a fake). */
export type SnowSpawn = (
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<SpawnOutcome>;

/** Spawn `snow` argv-style, capturing bounded stdout/stderr with a SIGKILL timeout. */
const spawnSnow: SnowSpawn = (argv, env, timeoutMs) => {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let truncatedOutput = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + `\n[oswald] snow timed out after ${timeoutMs}ms`,
        spawnError: "timeout",
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!truncatedOutput) {
          truncatedOutput = true;
          stderr += `\n[oswald] snow stdout exceeded ${MAX_STDOUT_BYTES} bytes; truncated`;
          child.kill("SIGKILL");
        }
        return;
      }
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: String(err), spawnError: String(err) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
};

/**
 * Parse `snow --format json` stdout into an array of row objects.
 *
 * `snow sql --format json` emits a JSON array of row objects (one object per
 * row, keyed by column name). Anything else — a non-array, a non-object element,
 * invalid JSON — is treated as malformed and returned as `null` so the caller
 * reports `ok:false` rather than throwing.
 */
function parseSnowJson(stdout: string): Array<Record<string, unknown>> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const el of parsed) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) return null;
    rows.push(el as Record<string, unknown>);
  }
  return rows;
}

/**
 * Derive the column list from parsed rows as the ordered union of keys across
 * rows. Zero rows → empty column list (never crashes deriving keys).
 */
function deriveColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols;
}

/**
 * Run a single read-only SQL statement via `snow sql` and return a typed outcome.
 *
 * Never throws for an expected failure (missing connection, spawn error, timeout,
 * malformed JSON) — those come back as `{ ok:false, reason }`. The caller is
 * responsible for having validated the SQL as read-only BEFORE calling this.
 *
 * @param spawnImpl injectable spawn (tests); defaults to the real `snow` spawn.
 */
export async function runSnowQuery(
  sql: string,
  options: SnowRunOptions,
  spawnImpl: SnowSpawn = spawnSnow,
): Promise<SnowQueryOutcome> {
  const dialect = options.dialect ?? "snow";

  // --- snowsql dialect: reserved, NOT implemented. ----------------------
  // TODO(snowsql): wire the legacy `snowsql` client here. It uses a different
  // invocation (`snowsql -c <conn> -o output_format=json -o friendly=false
  // -o header=true -q <sql>`) and emits a different JSON shape, so it needs its
  // own argv builder + parser. Intentionally left as a stub so adding it later
  // does NOT reshape the `snow` path above.
  if (dialect === "snowsql") {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      reason:
        "snowsql dialect is not implemented yet; use dialect 'snow' (the modern Snowflake CLI).",
    };
  }

  // --- Guard: a connection NAME is mandatory (no spawn without it). ------
  const connection = (options.connection ?? "").trim();
  if (!connection) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      reason: "no snow connection name configured; refusing to run.",
    };
  }

  // --- Build argv + spawn. ----------------------------------------------
  const base = splitInvocation(options.command);
  const argv = buildSnowArgv(base, sql, connection);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: Record<string, string> = { ...(options.env ?? {}) };

  const outcome = await spawnImpl(argv, env, timeoutMs);

  if (outcome.spawnError) {
    return {
      ok: false,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      reason:
        outcome.spawnError === "timeout"
          ? `snow timed out after ${timeoutMs}ms`
          : `snow failed to run: ${outcome.spawnError}`,
      spawnError: outcome.spawnError,
    };
  }

  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      reason: `snow sql exited ${outcome.exitCode}`,
    };
  }

  // --- Parse JSON rows (malformed → ok:false, never throw). -------------
  const parsed = parseSnowJson(outcome.stdout);
  if (parsed === null) {
    return {
      ok: false,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      reason: "snow returned malformed or unexpected JSON (expected an array of row objects).",
    };
  }

  // --- Defensive client-side truncation (ALL result paths). -------------
  const cap = options.rowCap ?? DEFAULT_ROW_CAP;
  const truncated = parsed.length > cap;
  const rows = truncated ? parsed.slice(0, cap) : parsed;
  const columns = deriveColumns(rows);

  return {
    ok: true,
    exitCode: outcome.exitCode,
    rows,
    columns,
    truncated,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  };
}
