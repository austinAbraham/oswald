/**
 * Detect whether a repo-side CLI (`git`, or a forge CLI like `gh` / `glab` /
 * `az`) is available on this machine.
 *
 * Mirrors the Snowflake integration's `--version` probe exactly: a single
 * synchronous `spawnSync` of `<command> --version`. It NEVER throws — a missing
 * binary, a non-zero exit, or an OS error all resolve to `{ available: false }`.
 * This lets the CLI decide at wiring time whether to construct the real git
 * provider or fall back to the deterministic mock, and lets the provider refuse
 * `openPullRequest` with clear guidance when the forge CLI is absent.
 */
import { spawnSync } from "node:child_process";
import type { CliDetection } from "./types.js";

/** Split a configurable invocation string into argv. No shell interpretation. */
function splitInvocation(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["git"];
}

/**
 * Probe for a CLI by running `<command> --version`.
 *
 * @param command the invocation to probe (whitespace-split into argv).
 * @returns `{ available, version? }` — never throws.
 */
export function detectCli(command: string): CliDetection {
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

/**
 * Probe for the `git` CLI by running `<command|git> --version`.
 *
 * @param command optional invocation override (whitespace-split into argv).
 * @returns `{ available, version? }` — never throws.
 */
export function detectGit(command?: string): CliDetection {
  return detectCli(command ?? "git");
}
