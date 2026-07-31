/**
 * Provider wiring for the CLI.
 *
 * In the current offline tier the concrete providers are the local mocks — the
 * same ones `doctor` reports on and the ones that power the data-residency
 * story. This module centralizes how the CLI decides which providers to hand a
 * tentacle, so every command degrades the same way:
 *
 *   - `--local-only` / `--skip-external` → no remote-ish providers at all
 *     (filesystem-only context, draft-only delivery, dry-run EDA).
 *   - a `--provider <name>` of `local`/`mock` → mock providers.
 *   - a `--warehouse none` → no warehouse provider (EDA stays dry-run).
 *   - the repo provider is the deterministic mock unless the config opts in
 *     (`repo.provider: git`) AND the git CLI is detected — then the real
 *     {@link GitRepoProvider} (git + gh/glab/az, all writes approval-gated).
 *
 * MCP-backed providers slot in here unchanged once the MCP seam is wired; the
 * tentacles only ever see the typed provider interfaces.
 */
import {
  MockTicketProvider,
  MockWarehouseProvider,
  MockRepoProvider,
  MockDocumentProvider,
} from "../../tools/providers/mock/index.js";
import { SnowflakeWarehouseProvider, detectSnow } from "../../tools/snowflake/index.js";
import { GitRepoProvider, detectGit } from "../../tools/repo/index.js";
import type { TentacleProviders } from "../../tentacles/base.js";
import type { OswaldConfig } from "../../core/config/index.js";
import { policyFromConfig, type ApprovalPolicy } from "../../core/approvals/index.js";
import { logger } from "../../core/logging/index.js";

/**
 * Settings for the real Snowflake (`snow`) execution path. Threaded from config
 * (+ CLI flags). Only a connection NAME is carried — never credentials.
 */
export interface SnowflakeSettings {
  /** The `snow` invocation (whitespace-split into argv). Defaults to "snow". */
  command?: string;
  /** The `snow` connection NAME. Required for real execution. */
  connection?: string;
  /** Subprocess timeout in ms. */
  timeoutMs?: number;
  /** CLI dialect. Only "snow" is implemented. */
  dialect?: "snow" | "snowsql";
  /** Row cap (from policies.warehouse.max_result_rows). */
  maxResultRows?: number;
  /** Whether PII redaction is enabled (from policies.privacy.mask_sensitive_values). */
  maskSensitive?: boolean;
}

/**
 * Settings for the real git repo path. Threaded from the config `repo` block.
 * Only CLI invocations and a remote NAME are carried — never credentials
 * (forge auth lives in the forge CLI's own config).
 */
export interface RepoSettings {
  /** Which repo provider to wire: the hermetic mock (default) or real git. */
  provider?: "mock" | "git";
  /** The git invocation (whitespace-split into argv). Defaults to "git". */
  command?: string;
  /** Override the forge CLI invocation (default derived: gh/glab/az). */
  forgeCommand?: string;
  /** The git remote pull requests target. Defaults to "origin". */
  remote?: string;
  /** Subprocess timeout in ms. */
  timeoutMs?: number;
  /** Approval policy from `config.policies` — enforced INSIDE the provider. */
  policy?: ApprovalPolicy;
}

/** Build {@link RepoSettings} from the config `repo` + `policies` blocks. */
export function repoSettingsFromConfig(config: OswaldConfig): RepoSettings {
  return {
    provider: config.repo.provider,
    command: config.repo.command,
    ...(config.repo.forge_command != null
      ? { forgeCommand: config.repo.forge_command }
      : {}),
    remote: config.repo.remote,
    timeoutMs: config.repo.timeout_ms,
    policy: policyFromConfig(config.policies),
  };
}

export interface ProviderSelection {
  /** Project root (used for the repo provider's git cwd). */
  cwd: string;
  /** Include a ticket provider (intake/clarify/delivery). */
  ticket?: boolean;
  /** Include a warehouse provider ("mock" → mock, "none"/undefined → none). */
  warehouse?: "mock" | "snowflake" | "none" | undefined;
  /** Include a repo provider (context/delivery). */
  repo?: boolean;
  /** Include a document provider (context). */
  document?: boolean;
  /** If true, drop every non-filesystem provider regardless of the above. */
  localOnly?: boolean;
  /** Optional path to a ticket fixture file for the mock ticket provider. */
  ticketFixture?: string | undefined;
  /** Settings for the real Snowflake path (used when `warehouse === "snowflake"`). */
  snowflake?: SnowflakeSettings | undefined;
  /** Settings for the real git path (used when `repo` is requested). */
  repoSettings?: RepoSettings | undefined;
}

/**
 * Build the {@link TentacleProviders} bundle for a command. Anything not
 * requested (or suppressed by `localOnly`) is left undefined so the tentacle
 * degrades gracefully.
 */
export function selectProviders(sel: ProviderSelection): TentacleProviders {
  const providers: TentacleProviders = {};
  if (sel.localOnly) return providers;

  if (sel.ticket) {
    providers.ticket = new MockTicketProvider(
      sel.ticketFixture ? { fixturePath: sel.ticketFixture } : {},
    );
  }
  if (sel.warehouse === "mock") {
    providers.warehouse = new MockWarehouseProvider();
  } else if (sel.warehouse === "snowflake") {
    providers.warehouse = selectSnowflakeWarehouse(sel.snowflake);
  }
  if (sel.repo) {
    providers.repo = selectRepoProvider(sel.cwd, sel.repoSettings);
  }
  if (sel.document) {
    providers.document = new MockDocumentProvider();
  }
  return providers;
}

/**
 * Choose the concrete warehouse provider for `--warehouse snowflake`.
 *
 * Constructs the real {@link SnowflakeWarehouseProvider} ONLY when the `snow` CLI
 * is detected AND a connection NAME is configured. Otherwise it logs a clear
 * warning and falls back to the deterministic {@link MockWarehouseProvider}, so
 * the read-only gate is still exercised and nothing spawns.
 */
function selectSnowflakeWarehouse(
  settings: SnowflakeSettings | undefined,
): SnowflakeWarehouseProvider | MockWarehouseProvider {
  const connection = settings?.connection?.trim();
  if (!connection) {
    logger.warn(
      "warehouse 'snowflake' requested but no connection name is configured; falling back to the mock warehouse (dry-run-safe). Set warehouse.connection in oswald.yml or pass --connection.",
    );
    return new MockWarehouseProvider();
  }
  const detection = detectSnow(settings?.command);
  if (!detection.available) {
    logger.warn(
      `warehouse 'snowflake' requested but the '${
        settings?.command ?? "snow"
      }' CLI was not found on PATH; falling back to the mock warehouse. Install the Snowflake CLI and configure a non-interactive connection to run real EDA.`,
    );
    return new MockWarehouseProvider();
  }
  return new SnowflakeWarehouseProvider({
    connection,
    ...(settings?.command != null ? { command: settings.command } : {}),
    ...(settings?.timeoutMs != null ? { timeoutMs: settings.timeoutMs } : {}),
    ...(settings?.dialect != null ? { dialect: settings.dialect } : {}),
    ...(settings?.maskSensitive != null ? { maskSensitive: settings.maskSensitive } : {}),
    sql: settings?.maxResultRows != null ? { maxResultRows: settings.maxResultRows } : {},
  });
}

/**
 * Choose the concrete repo provider.
 *
 * Constructs the real {@link GitRepoProvider} ONLY when the config opts in
 * (`repo.provider: git`) AND the git CLI is detected. Otherwise it falls back
 * to the deterministic {@link MockRepoProvider} (with a clear warning when the
 * opt-in could not be honored), so tests and the offline demo stay hermetic
 * and writes remain draft-only.
 */
export function selectRepoProvider(
  cwd: string,
  settings: RepoSettings | undefined,
): GitRepoProvider | MockRepoProvider {
  if (settings?.provider !== "git") {
    return new MockRepoProvider({
      cwd,
      ...(settings?.policy != null ? { policy: settings.policy } : {}),
    });
  }
  const detection = detectGit(settings.command);
  if (!detection.available) {
    logger.warn(
      `repo provider 'git' requested but the '${
        settings.command ?? "git"
      }' CLI was not found on PATH; falling back to the mock repo provider (draft-only). Install git to enable real branch/commit/PR operations.`,
    );
    return new MockRepoProvider({
      cwd,
      ...(settings.policy != null ? { policy: settings.policy } : {}),
    });
  }
  return new GitRepoProvider({
    cwd,
    ...(settings.command != null ? { command: settings.command } : {}),
    ...(settings.forgeCommand != null ? { forgeCommand: settings.forgeCommand } : {}),
    ...(settings.remote != null ? { remote: settings.remote } : {}),
    ...(settings.timeoutMs != null ? { timeoutMs: settings.timeoutMs } : {}),
    ...(settings.policy != null ? { policy: settings.policy } : {}),
  });
}
