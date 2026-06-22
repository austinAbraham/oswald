/**
 * The dbt runner — the one place in Oswald that actually shells out to dbt.
 *
 * Design rules (mirroring the rest of the codebase):
 *   - DETERMINISTIC GUARD FIRST: write-y commands (`seed`/`build`) against a
 *     target whose name doesn't look like a sandbox are BLOCKED before any
 *     process is spawned (policy: never run writes against non-sandbox).
 *   - OFFLINE BY DEFAULT: `skipExternal` returns a `skipped (offline)` result
 *     WITHOUT spawning anything — same posture as `validate --skip-external`.
 *   - NO SHELL: the invocation string is whitespace-split and passed to
 *     `spawn` argv-style; we never interpolate into a shell, so there is no
 *     command-injection surface.
 *   - CONFIGURABLE INVOCATION: `dbtCommand` defaults to "dbt" but can be e.g.
 *     "uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt".
 *
 * After a run, we parse `<targetPath>/run_results.json` (+ `manifest.json` when
 * present) into the typed {@link DbtRunResult}. `parse` produces no run_results,
 * so for `parse` we synthesize ok/!ok from the exit code alone.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseRunResults, skippedResult } from "./parse.js";
import type { DbtCommand, DbtRunResult, RunDbtOptions } from "./types.js";

/**
 * Find the dbt project root by walking up from `dir` looking for
 * `dbt_project.yml`. Returns the absolute directory containing it, or null.
 */
export async function detectDbtProject(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  // Walk up to the filesystem root.
  for (;;) {
    const candidate = path.join(current, "dbt_project.yml");
    try {
      await fs.access(candidate);
      return current;
    } catch {
      /* not here — keep walking */
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Commands that WRITE to the warehouse. These are guarded against non-sandbox
 * targets. `parse` and `test` are read-only (test reads model output; parse
 * touches nothing), so they are never blocked on target name.
 */
const WRITE_COMMANDS: ReadonlySet<DbtCommand> = new Set<DbtCommand>(["seed", "build"]);

/**
 * Positive heuristic for "this target is a sandbox". Conservative: a target is
 * considered sandbox-safe only when its name (or schema-ish suffix) clearly
 * signals a non-production scratch space. When in doubt → NOT sandbox → blocked.
 */
export function isSandboxTarget(target: string | undefined): boolean {
  if (!target) return false;
  const t = target.toLowerCase();
  const SANDBOX_TOKENS = [
    "sandbox",
    "dev",
    "development",
    "ci",
    "test",
    "testing",
    "scratch",
    "staging",
    "local",
    "duckdb",
  ];
  // Match a whole-word/token, not a substring inside e.g. "production".
  return SANDBOX_TOKENS.some((tok) =>
    new RegExp(`(^|[^a-z])${tok}([^a-z]|$)`).test(t),
  );
}

/** Split a configurable invocation string into argv. No shell interpretation. */
function splitInvocation(dbtCommand: string | undefined): string[] {
  const raw = (dbtCommand ?? "dbt").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["dbt"];
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function spawnDbt(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + `\n[oswald] dbt timed out after ${timeoutMs}ms`,
        spawnError: "timeout",
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
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
}

/** Read + JSON-parse a dbt artifact, returning undefined when absent. */
async function readArtifact(file: string): Promise<unknown | undefined> {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Run a dbt command and return a typed result.
 *
 * Never throws for an expected failure (blocked target, spawn error, test
 * failures) — those come back as a non-ok {@link DbtRunResult}. Throws only for
 * truly unexpected programmer errors.
 */
export async function runDbt(
  command: DbtCommand,
  options: RunDbtOptions,
): Promise<DbtRunResult> {
  const projectDir = path.resolve(options.projectDir);

  // --- 1. Offline guard (no spawn). -------------------------------------
  if (options.skipExternal) {
    return skippedResult(command, "skipped (offline): --skip-external set");
  }

  // --- 2. Sandbox-target policy guard (write commands only). ------------
  if (
    WRITE_COMMANDS.has(command) &&
    !options.allowNonSandboxTarget &&
    !isSandboxTarget(options.target)
  ) {
    return {
      ok: false,
      command,
      exitCode: null,
      skipped: true,
      reason: `blocked: '${command}' is a warehouse-write command and target '${
        options.target ?? "(default)"
      }' is not recognized as a sandbox. Use a sandbox target or pass allowNonSandboxTarget.`,
      nodes: [],
      tests: [],
      failed: [],
      stdout: "",
      stderr: "",
    };
  }

  // --- 3. Build argv and spawn. -----------------------------------------
  const base = splitInvocation(options.dbtCommand);
  const argv = [...base, command];
  if (options.target) argv.push("--target", options.target);
  // Keep dbt's project/profiles co-located with the project dir.
  argv.push("--project-dir", projectDir);
  argv.push("--profiles-dir", projectDir);

  const env: Record<string, string> = {
    DO_NOT_TRACK: "1",
    DBT_SEND_ANONYMOUS_USAGE_STATS: "False",
    ...(options.env ?? {}),
  };

  const timeoutMs = options.timeoutMs ?? 300000;
  const outcome = await spawnDbt(argv, projectDir, env, timeoutMs);

  // --- 4. Parse artifacts. ----------------------------------------------
  const targetPath = options.targetPath
    ? path.resolve(options.targetPath)
    : path.join(projectDir, "target");
  const runResults = await readArtifact(path.join(targetPath, "run_results.json"));
  const manifest = await readArtifact(path.join(targetPath, "manifest.json"));

  // `parse` produces no run_results — derive ok purely from the exit code.
  if (command === "parse" || runResults === undefined) {
    const ok = outcome.exitCode === 0 && !outcome.spawnError;
    return {
      ok,
      command,
      exitCode: outcome.exitCode,
      skipped: false,
      nodes: [],
      tests: [],
      failed: [],
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      ...(ok
        ? {}
        : {
            reason: outcome.spawnError
              ? `dbt failed to run: ${outcome.spawnError}`
              : `dbt ${command} exited ${outcome.exitCode}${
                  runResults === undefined ? " (no run_results.json produced)" : ""
                }`,
          }),
    };
  }

  return parseRunResults({
    command,
    runResults,
    manifest,
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  });
}
