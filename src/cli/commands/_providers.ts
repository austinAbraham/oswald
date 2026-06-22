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
import type { TentacleProviders } from "../../tentacles/base.js";

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
  // Snowflake has no offline driver in this tier; fall back to the mock so the
  // EDA path still exercises the read-only gate deterministically.
  if (sel.warehouse === "mock" || sel.warehouse === "snowflake") {
    providers.warehouse = new MockWarehouseProvider();
  }
  if (sel.repo) {
    providers.repo = new MockRepoProvider({ cwd: sel.cwd });
  }
  if (sel.document) {
    providers.document = new MockDocumentProvider();
  }
  return providers;
}
