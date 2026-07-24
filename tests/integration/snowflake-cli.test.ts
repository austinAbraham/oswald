/**
 * GUARDED integration test: actually run read-only EDA SQL against a real
 * Snowflake account via the `snow` CLI.
 *
 * This spawns a real subprocess and talks to a live Snowflake connection, so it
 * is skipped cleanly unless BOTH:
 *   - OSWALD_RUN_SNOW_IT=1        (explicit opt-in), and
 *   - OSWALD_SNOW_CONNECTION=<name> (a configured, non-interactive `snow` connection),
 * AND a working `snow --version` is detected. Absent any of these it is
 * `describe.skip` so `npm test` stays green offline. An always-present marker
 * test reports whether the real path was exercised.
 *
 * The connection must be NON-INTERACTIVE (key-pair or cached SSO) — the runner's
 * SIGKILL timeout bounds any hang, but an interactive auth prompt would block.
 */
import { describe, it, expect } from "vitest";
import { detectSnow } from "../../src/tools/snowflake/detect.js";
import { SnowflakeWarehouseProvider } from "../../src/tools/snowflake/warehouse.js";

const OPTED_IN = process.env.OSWALD_RUN_SNOW_IT === "1";
const CONNECTION = process.env.OSWALD_SNOW_CONNECTION ?? "";
const COMMAND = process.env.OSWALD_SNOW_COMMAND; // optional invocation override
const DETECTED = OPTED_IN ? detectSnow(COMMAND).available : false;
const RUN = OPTED_IN && DETECTED && CONNECTION.length > 0;

(RUN ? describe : describe.skip)("snowflake CLI integration (real snow)", () => {
  function provider(): SnowflakeWarehouseProvider {
    return new SnowflakeWarehouseProvider({
      connection: CONNECTION,
      ...(COMMAND != null ? { command: COMMAND } : {}),
      sql: { maxResultRows: 100 },
      timeoutMs: 120000,
    });
  }

  it("health() reaches the connection", async () => {
    const h = await provider().health();
    expect(h.state, `health: ${h.detail}`).toBe("ok");
  });

  it("executes a read-only SELECT and returns rows", async () => {
    const res = await provider().executeReadOnlySql("SELECT 1 AS one");
    expect(res.ok, res.error).toBe(true);
    expect(res.data!.rows.length).toBeGreaterThan(0);
  });

  it("refuses a write statement without spawning", async () => {
    const res = await provider().executeReadOnlySql("DELETE FROM whatever");
    expect(res.ok).toBe(false);
  });

  it("lists schemas via SHOW SCHEMAS", async () => {
    const schemas = await provider().listSchemas();
    expect(Array.isArray(schemas)).toBe(true);
  });
});

// Always-present marker so the file reports something even when skipped.
describe("snowflake CLI integration availability", () => {
  it("reports whether the real snow path was exercised", () => {
    if (!OPTED_IN) {
      expect(RUN).toBe(false); // opt-in via OSWALD_RUN_SNOW_IT=1 + OSWALD_SNOW_CONNECTION
    } else {
      expect(typeof RUN).toBe("boolean");
    }
  });
});
