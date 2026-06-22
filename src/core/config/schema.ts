import { z } from "zod";

/**
 * Zod schema for `oswald.yml`.
 *
 * Defaults are applied generously so that a minimal config (just
 * `project.name`) parses into a complete, usable configuration object.
 */

export const ProjectConfigSchema = z.object({
  name: z.string().min(1, "project.name must not be empty"),
  default_ticket_system: z.string().default("none"),
  default_warehouse: z.string().default("duckdb"),
  default_repo_provider: z.string().default("github"),
});

export const RuntimeConfigSchema = z
  .object({
    preferred_client: z.string().default("claude-code"),
    allow_runtime_adapters: z.boolean().default(true),
  })
  .default({});

export const PathsConfigSchema = z
  .object({
    artifact_dir: z.string().default(".oswald"),
    model_dir: z.string().default("models"),
    test_dir: z.string().default("tests"),
  })
  .default({});

export const StandardsConfigSchema = z
  .object({
    modeling_tool: z.string().default("dbt"),
    sql_dialect: z.string().default("ansi"),
    require_model_docs: z.boolean().default(true),
    require_tests_for_new_models: z.boolean().default(true),
  })
  .default({});

/**
 * How Oswald drives the dbt CLI when `validate` / `build --apply` run external
 * commands. All optional: with zero config Oswald auto-detects a dbt project and
 * uses `dbt` against the `sandbox` target. The `command` string is whitespace-
 * split into argv (never run through a shell), so it can be a self-contained
 * invocation like "uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt".
 */
export const DbtConfigSchema = z
  .object({
    /** The dbt invocation. Whitespace-split into argv; defaults to "dbt". */
    command: z.string().default("dbt"),
    /** The dbt target to run against. Must look like a sandbox for writes. */
    target: z.string().default("sandbox"),
    /**
     * Explicit dbt project directory. When unset, Oswald walks up from the
     * project root looking for `dbt_project.yml`.
     */
    project_dir: z.string().optional(),
    /** Subprocess timeout in milliseconds. */
    timeout_ms: z.number().int().positive().default(300000),
  })
  .default({});

/**
 * A single MCP server entry. Kept permissive (passthrough) because different
 * transports need different fields; we validate the discriminating shape only
 * loosely so adapters can read transport-specific keys.
 */
export const McpServerSchema = z
  .object({
    transport: z.string().default("stdio"),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string()).optional(),
  })
  .passthrough();

export const WarehousePolicySchema = z
  .object({
    read_only_by_default: z.boolean().default(true),
    max_sample_rows: z.number().int().positive().default(100),
    max_result_rows: z.number().int().positive().default(10000),
    prefer_aggregates_over_raw_rows: z.boolean().default(true),
  })
  .default({});

export const PrivacyPolicySchema = z
  .object({
    mask_sensitive_values: z.boolean().default(true),
    pii_allowed_in_artifacts: z.boolean().default(false),
  })
  .default({});

export const PoliciesConfigSchema = z
  .object({
    require_approval_for: z
      .array(z.string())
      .default(["warehouse_write", "pr_open", "ticket_update"]),
    prohibit: z.array(z.string()).default(["direct_push_to_protected_branch"]),
    warehouse: WarehousePolicySchema,
    privacy: PrivacyPolicySchema,
  })
  .default({});

export const OswaldConfigSchema = z.object({
  project: ProjectConfigSchema,
  runtime: RuntimeConfigSchema,
  paths: PathsConfigSchema,
  standards: StandardsConfigSchema,
  dbt: DbtConfigSchema,
  mcp_servers: z.record(McpServerSchema).default({}),
  policies: PoliciesConfigSchema,
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type PathsConfig = z.infer<typeof PathsConfigSchema>;
export type StandardsConfig = z.infer<typeof StandardsConfigSchema>;
export type DbtConfig = z.infer<typeof DbtConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type PoliciesConfig = z.infer<typeof PoliciesConfigSchema>;
export type OswaldConfig = z.infer<typeof OswaldConfigSchema>;
