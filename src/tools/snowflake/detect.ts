/**
 * Detect whether the Snowflake CLI (`snow`) is available on this machine.
 *
 * Mirrors the dbt integration's `--version` probe: a single synchronous
 * `spawnSync` of `<command> --version`. It NEVER throws — a missing binary, a
 * non-zero exit, or an OS error all resolve to `{ available: false }`. This lets
 * the CLI decide at wiring time whether to construct the real Snowflake provider
 * or fall back to the deterministic mock.
 */
import { spawnSync } from "node:child_process";

/** Result of probing for the `snow` binary. */
export interface SnowDetection {
  /** True when `<command> --version` ran and exited 0. */
  available: boolean;
  /** The trimmed version string, when recoverable. */
  version?: string;
}

/** Split a configurable invocation string into argv. No shell interpretation. */
function splitInvocation(command: string | undefined): string[] {
  const raw = (command ?? "snow").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["snow"];
}

/**
 * Probe for the `snow` CLI by running `<command|snow> --version`.
 *
 * @param command optional invocation override (whitespace-split into argv).
 * @returns `{ available, version? }` — never throws.
 */
export function detectSnow(command?: string): SnowDetection {
  const parts = splitInvocation(command);
  const [cmd, ...rest] = parts;
  try {
    const res = spawnSync(cmd!, [...rest, "--version"], {
      encoding: "utf8",
      timeout: 30000,
    });
    if (res.status === 0) {
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
      const version = out.length > 0 ? out.split(/\r?\n/)[0]!.trim() : undefined;
      return version ? { available: true, version } : { available: true };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}
