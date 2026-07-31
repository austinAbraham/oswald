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
 *
 * Every selection also produces a RESOLUTION REPORT — per slot, what was
 * requested vs what was actually wired and why any fallback happened — which
 * the shared runner prints as a one-line table and which powers
 * `--strict-providers` / `policies.strict_providers` (fallback → exit 1).
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
  /**
   * The ticket source the user NAMED (e.g. "jira"/"github"/"mock"). Only mocks
   * are wired in this tier, so any other name is recorded as a fallback in the
   * resolution report. Purely informational — never changes what is wired.
   */
  ticketProvider?: string | undefined;
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

/** The provider slots a command can request. */
export type ProviderSlot = "ticket" | "warehouse" | "repo" | "document";

/**
 * One slot's requested→resolved wiring outcome. `fallback: true` marks a
 * SILENT degradation (the user asked for a real provider and got a mock) —
 * exactly the case `--strict-providers` / `policies.strict_providers` turns
 * into a hard failure. Explicit suppression (`--local-only`, `--warehouse
 * none`) is recorded but is NOT a fallback.
 */
export interface ProviderResolutionEntry {
  slot: ProviderSlot;
  /** What the caller asked for (e.g. "snowflake", "jira", "mock", "none"). */
  requested: string;
  /** What was actually wired (e.g. "snowflake", "mock", "none"). */
  resolved: string;
  /** True when the resolution silently degraded from the request. */
  fallback: boolean;
  /** Why the resolution differs from the request (fallback or suppression). */
  reason?: string;
  /** How to make the request resolve for real (set when `fallback` is true). */
  remediation?: string;
}

/** What {@link selectProviders} hands back: the bundle plus its receipt. */
export interface ProviderSelectionResult {
  providers: TentacleProviders;
  resolution: ProviderResolutionEntry[];
}

/**
 * Render the resolution report as the one-line table every pipeline command
 * prints, e.g. `warehouse: snowflake→MOCK (snow CLI not found on PATH);
 * ticket: mock; repo: mock`. Fallback targets are uppercased so a mock
 * masquerading as real evidence is impossible to miss.
 */
export function renderProviderResolution(resolution: ProviderResolutionEntry[]): string {
  if (resolution.length === 0) return "none";
  return resolution
    .map((e) => {
      const reason = e.reason ? ` (${e.reason})` : "";
      if (e.requested === e.resolved) return `${e.slot}: ${e.resolved}${reason}`;
      const resolved = e.fallback ? e.resolved.toUpperCase() : e.resolved;
      return `${e.slot}: ${e.requested}→${resolved}${reason}`;
    })
    .join("; ");
}

/**
 * Build the {@link TentacleProviders} bundle for a command, plus a resolution
 * report of what was REQUESTED vs what was RESOLVED (and why any fallback
 * happened). Anything not requested (or suppressed by `localOnly`) is left
 * undefined so the tentacle degrades gracefully.
 */
export function selectProviders(sel: ProviderSelection): ProviderSelectionResult {
  const providers: TentacleProviders = {};
  const resolution: ProviderResolutionEntry[] = [];

  if (sel.localOnly) {
    for (const [slot, requested] of requestedSlots(sel)) {
      resolution.push({
        slot,
        requested,
        resolved: "none",
        fallback: false,
        reason: "suppressed by --local-only",
      });
    }
    return { providers, resolution };
  }

  if (sel.ticket) {
    providers.ticket = new MockTicketProvider(
      sel.ticketFixture ? { fixturePath: sel.ticketFixture } : {},
    );
    resolution.push(resolveTicketEntry(sel.ticketProvider));
  }
  if (sel.warehouse === "mock") {
    providers.warehouse = new MockWarehouseProvider();
    resolution.push({ slot: "warehouse", requested: "mock", resolved: "mock", fallback: false });
  } else if (sel.warehouse === "snowflake") {
    const { provider, entry } = selectSnowflakeWarehouse(sel.snowflake, sel.audit);
    providers.warehouse = provider;
    resolution.push(entry);
  } else if (sel.warehouse === "none") {
    resolution.push({ slot: "warehouse", requested: "none", resolved: "none", fallback: false });
  }
  if (sel.repo) {
    providers.repo = new MockRepoProvider({ cwd: sel.cwd });
    resolution.push({ slot: "repo", requested: "mock", resolved: "mock", fallback: false });
  }
  if (sel.document) {
    providers.document = new MockDocumentProvider();
    resolution.push({ slot: "document", requested: "mock", resolved: "mock", fallback: false });
  }
  return { providers, resolution };
}

/** The slots (and requested names) a selection asks for — used by `localOnly`. */
function requestedSlots(sel: ProviderSelection): Array<[ProviderSlot, string]> {
  const slots: Array<[ProviderSlot, string]> = [];
  if (sel.ticket) slots.push(["ticket", sel.ticketProvider ?? "mock"]);
  if (sel.warehouse === "mock" || sel.warehouse === "snowflake") {
    slots.push(["warehouse", sel.warehouse]);
  }
  if (sel.repo) slots.push(["repo", "mock"]);
  if (sel.document) slots.push(["document", "mock"]);
  return slots;
}

/** Resolution entry for the ticket slot — only mocks are wired in this tier. */
function resolveTicketEntry(requested: string | undefined): ProviderResolutionEntry {
  const name = requested ?? "mock";
  if (name === "mock") {
    return { slot: "ticket", requested: "mock", resolved: "mock", fallback: false };
  }
  return {
    slot: "ticket",
    requested: name,
    resolved: "mock",
    fallback: true,
    reason: `the '${name}' ticket provider is not wired in this tier`,
    remediation: `pass --provider mock explicitly, or wire a '${name}' MCP server`,
  };
}

/**
 * Choose the concrete warehouse provider for `--warehouse snowflake`.
 *
 * Constructs the real {@link SnowflakeWarehouseProvider} ONLY when the `snow` CLI
 * is detected AND a connection NAME is configured. Otherwise it logs a clear
 * warning, records the fallback in the resolution entry, and falls back to the
 * deterministic {@link MockWarehouseProvider}, so the read-only gate is still
 * exercised and nothing spawns.
 */
function selectSnowflakeWarehouse(
  settings: SnowflakeSettings | undefined,
  audit?: AuditSink,
): {
  provider: SnowflakeWarehouseProvider | MockWarehouseProvider;
  entry: ProviderResolutionEntry;
} {
  const fallback = (
    reason: string,
    remediation: string,
  ): { provider: MockWarehouseProvider; entry: ProviderResolutionEntry } => {
    audit?.record("provider_fallback", {
      provider: "warehouse",
      requested: "snowflake",
      used: "mock",
      reason,
    });
    return {
      provider: new MockWarehouseProvider(),
      entry: {
        slot: "warehouse",
        requested: "snowflake",
        resolved: "mock",
        fallback: true,
        reason,
        remediation,
      },
    };
  };
  const connection = settings?.connection?.trim();
  if (!connection) {
    logger.warn(
      "warehouse 'snowflake' requested but no connection name is configured; falling back to the mock warehouse (dry-run-safe). Set warehouse.connection in oswald.yml or pass --connection.",
    );
    return fallback(
      "no connection name configured",
      "set warehouse.connection in oswald.yml or pass --connection <name>, or pass --warehouse mock explicitly",
    );
  }
  const command = settings?.command ?? "snow";
  const detection = detectSnow(settings?.command);
  if (!detection.available) {
    logger.warn(
      `warehouse 'snowflake' requested but the '${command}' CLI was not found on PATH; falling back to the mock warehouse. Install the Snowflake CLI and configure a non-interactive connection to run real EDA.`,
    );
    return fallback(
      `'${command}' CLI not found on PATH`,
      "install the Snowflake CLI and configure warehouse.connection, or pass --warehouse mock explicitly",
    );
  }
  return {
    provider: new SnowflakeWarehouseProvider({
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
    }),
    entry: { slot: "warehouse", requested: "snowflake", resolved: "snowflake", fallback: false },
  };
}
