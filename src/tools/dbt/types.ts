/**
 * Typed contracts for the dbt runner.
 *
 * These shapes are what the rest of Oswald reasons over — they are intentionally
 * decoupled from dbt's own (verbose, version-drifting) `run_results.json` /
 * `manifest.json` layout. The parser in `parse.ts` maps dbt's artifacts down to
 * these stable types; the check-mapper in `checks.ts` maps dbt test nodes to the
 * same logical-check taxonomy the validation tentacle already speaks.
 */

/** The dbt subcommands the runner knows how to drive. */
export type DbtCommand = "parse" | "seed" | "build" | "test";

/** Logical check kinds — aligned with the validation tentacle's expectations. */
export const DBT_CHECK_KINDS = [
  "unique",
  "not_null",
  "accepted_values",
  "freshness",
  "relationships",
  "row_count",
  "other",
] as const;

export type DbtCheckKind = (typeof DBT_CHECK_KINDS)[number];

/** Normalized node status, collapsed from dbt's status vocabulary. */
export type DbtNodeStatus = "pass" | "fail" | "error" | "skipped" | "warn" | "success";

/** A single non-test node (model/seed/snapshot) result. */
export interface DbtNodeResult {
  /** Unique node name (e.g. "stg_crm_customers"). */
  name: string;
  /** dbt resource type ("model" | "seed" | "test" | "snapshot" | ...). */
  resourceType: string;
  status: DbtNodeStatus;
  /** Failure / error detail when present. */
  message?: string;
}

/** A single data-test result, mapped to a logical check kind. */
export interface DbtTestResult {
  /** dbt test node name (e.g. "unique_stg_crm_customers_customer_id"). */
  name: string;
  status: DbtNodeStatus;
  /** Logical check this test maps to. */
  kind: DbtCheckKind;
  /** The model/column the test targets, when recoverable. */
  column?: string;
  message?: string;
}

/** The typed result of a single dbt invocation. */
export interface DbtRunResult {
  /** True when the command completed with no failed/errored nodes or tests. */
  ok: boolean;
  /** The subcommand that produced this result. */
  command: DbtCommand;
  /** The process exit code (0 = clean). `null` when the run was skipped. */
  exitCode: number | null;
  /** True when the run was skipped (offline / policy) — no process was spawned. */
  skipped: boolean;
  /** Human-readable reason when skipped or failed. */
  reason?: string;
  /** Non-test nodes (models, seeds, snapshots). */
  nodes: DbtNodeResult[];
  /** Data tests, mapped to logical checks. */
  tests: DbtTestResult[];
  /** Names of nodes + tests that failed or errored (convenience). */
  failed: string[];
  /** Captured stdout (may be empty when skipped). */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/** Options for {@link runDbt}. */
export interface RunDbtOptions {
  /** The dbt project directory (must contain `dbt_project.yml`). */
  projectDir: string;
  /** dbt target/profile target to run against. */
  target?: string;
  /**
   * Stay fully offline: return a `skipped (offline)` result WITHOUT spawning a
   * process. Mirrors the validation tentacle's `--skip-external` default.
   */
  skipExternal?: boolean;
  /**
   * The dbt invocation. A single shell-style string, whitespace-split (NOT run
   * through a shell). Defaults to "dbt". Example for a self-contained local run:
   * "uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt".
   */
  dbtCommand?: string;
  /** Extra environment variables for the dbt subprocess. */
  env?: Record<string, string>;
  /**
   * Allow a non-sandbox target. Default false — write-y commands (seed/build)
   * against a target whose name does not look like a sandbox are BLOCKED by the
   * policy guard. Read-only commands (parse/test) are never blocked on target.
   */
  allowNonSandboxTarget?: boolean;
  /**
   * Override the directory dbt writes its artifacts to (defaults to
   * `<projectDir>/target`). Used to locate run_results.json / manifest.json.
   */
  targetPath?: string;
  /** Timeout in ms for the subprocess. Default 300000 (5 min). */
  timeoutMs?: number;
}
