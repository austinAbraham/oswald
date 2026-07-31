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
import type { TentacleProviders } from "../../tentacles/base.js";
import type { AuditSink } from "../../core/audit/index.js";
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
  /** Optional audit sink; provider fallbacks are recorded when present. */
  audit?: AuditSink | undefined;
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
    providers.warehouse = selectSnowflakeWarehouse(sel.snowflake, sel.audit);
  }
  if (sel.repo) {
    providers.repo = new MockRepoProvider({ cwd: sel.cwd });
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
  audit?: AuditSink,
): SnowflakeWarehouseProvider | MockWarehouseProvider {
  const fallback = (reason: string): MockWarehouseProvider => {
    audit?.record("provider_fallback", {
      provider: "warehouse",
      requested: "snowflake",
      used: "mock",
      reason,
    });
    return new MockWarehouseProvider();
  };
  const connection = settings?.connection?.trim();
  if (!connection) {
    logger.warn(
      "warehouse 'snowflake' requested but no connection name is configured; falling back to the mock warehouse (dry-run-safe). Set warehouse.connection in oswald.yml or pass --connection.",
    );
    return fallback("no connection name configured");
  }
  const detection = detectSnow(settings?.command);
  if (!detection.available) {
    logger.warn(
      `warehouse 'snowflake' requested but the '${
        settings?.command ?? "snow"
      }' CLI was not found on PATH; falling back to the mock warehouse. Install the Snowflake CLI and configure a non-interactive connection to run real EDA.`,
    );
    return fallback("snow CLI not found on PATH");
  }
  return new SnowflakeWarehouseProvider({
    connection,
    ...(settings?.command != null ? { command: settings.command } : {}),
    ...(settings?.timeoutMs != null ? { timeoutMs: settings.timeoutMs } : {}),
    ...(settings?.dialect != null ? { dialect: settings.dialect } : {}),
    ...(settings?.maskSensitive != null ? { maskSensitive: settings.maskSensitive } : {}),
    sql: settings?.maxResultRows != null ? { maxResultRows: settings.maxResultRows } : {},
    // Thread the ledger into the provider so its internal read-only gate and
    // every spawned statement (health/SHOW/DESCRIBE/EXPLAIN/EDA SQL) are
    // recorded — not just the tentacle-level queries.
    ...(audit ? { audit } : {}),
  });
}
