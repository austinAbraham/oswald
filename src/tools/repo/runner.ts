/**
 * The repo runner — the ONE place in Oswald that shells out to `git` and the
 * forge CLIs (`gh` / `glab` / `az`).
 *
 * Design rules (mirroring the snow runner exactly):
 *   - NO SHELL: every invocation is a single argv array passed to `spawn`;
 *     branch names, commit messages, and file paths are single argv elements.
 *     We never interpolate into a shell, so there is no command-injection
 *     surface.
 *   - FIXED ARGV BUILDERS: every git subcommand Oswald can emit is hard-coded
 *     in a pure, unit-tested builder below (rev-parse / status / remote get-url
 *     / checkout -b / add / commit / push). No other git subcommand can ever be
 *     constructed here. File paths are always preceded by `--` so an
 *     option-lookalike path cannot become a flag.
 *   - NO SECRETS: nothing credential-shaped crosses this boundary — git and the
 *     forge CLIs hold their own auth. Failure reasons are scrubbed of
 *     `scheme://user:token@host` credentials before they are surfaced.
 *   - DEFENSIVE BOUNDS: buffered stdout is size-bounded and every spawn has a
 *     SIGKILL timeout. Failures come back as `ok:false` — the runner NEVER
 *     throws for an expected failure.
 *
 * The write gating itself lives in the repo provider, which routes every
 * side-effecting call through the ApprovalService BEFORE calling this runner.
 * The runner is transport only.
 */
import { spawn } from "node:child_process";
import type { RepoCommandOutcome, RepoRunOptions } from "./types.js";

/** Default subprocess timeout (1 min) when the caller provides none. */
const DEFAULT_TIMEOUT_MS = 60000;
/**
 * Hard ceiling on buffered stdout (~16 MiB). Repo metadata commands should
 * never approach this; the bound protects against a pathological / unexpected
 * response streaming unbounded memory into the process.
 */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/** Split a configurable invocation string into argv. No shell interpretation. */
export function splitRepoInvocation(
  command: string | undefined,
  fallback = "git",
): string[] {
  const raw = (command ?? fallback).trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : [fallback];
}

/**
 * Scrub `scheme://user:secret@host` credentials out of a string before it is
 * surfaced in an error reason. Git can echo the remote URL on push failures,
 * and remote URLs occasionally embed tokens — those must never leak into logs.
 */
export function scrubRemoteCredentials(text: string): string {
  return text.replace(/(\w+:\/\/)[^/\s@]+@/g, "$1***@");
}

// ---------------------------------------------------------------------------
// Pure argv builders — the ONLY git invocations Oswald can emit. Each builder
// hard-codes its subcommand so nothing else can ever be constructed.
// ---------------------------------------------------------------------------

/** `git rev-parse --abbrev-ref HEAD` — the current branch name (read-only). */
export function buildCurrentBranchArgv(base: string[]): string[] {
  return [...base, "rev-parse", "--abbrev-ref", "HEAD"];
}

/** `git rev-parse --is-inside-work-tree` — repo presence probe (read-only). */
export function buildIsInsideWorkTreeArgv(base: string[]): string[] {
  return [...base, "rev-parse", "--is-inside-work-tree"];
}

/** `git status --porcelain` — machine-readable changed files (read-only). */
export function buildChangedFilesArgv(base: string[]): string[] {
  return [...base, "status", "--porcelain"];
}

/** `git remote get-url <remote>` — the forge URL for PR routing (read-only). */
export function buildRemoteUrlArgv(base: string[], remote: string): string[] {
  return [...base, "remote", "get-url", remote];
}

/** `git checkout -b <name>` — create + switch to a branch (write). */
export function buildCreateBranchArgv(base: string[], name: string): string[] {
  return [...base, "checkout", "-b", name];
}

/** `git add -- <files...>` — stage an EXPLICIT file list (write). */
export function buildAddArgv(base: string[], files: string[]): string[] {
  return [...base, "add", "--", ...files];
}

/** `git commit -m <message>` — commit the staged files (write). */
export function buildCommitArgv(base: string[], message: string): string[] {
  return [...base, "commit", "-m", message];
}

/**
 * `git push --set-upstream <remote> refs/heads/<branch>:refs/heads/<branch>` —
 * push ONE named branch (write). There is deliberately NO builder for a bare
 * `git push` or a caller-supplied refspec: the only push Oswald can express is
 * a single explicit branch, and the refspec is fully qualified on BOTH sides so
 * a ref-qualified branch name (e.g. `refs/heads/main`) can never resolve to a
 * different ref than the guard in the provider validated.
 */
export function buildPushArgv(
  base: string[],
  remote: string,
  branch: string,
): string[] {
  return [
    ...base,
    "push",
    "--set-upstream",
    remote,
    `refs/heads/${branch}:refs/heads/${branch}`,
  ];
}

// ---------------------------------------------------------------------------
// Low-level spawn (injectable) + the runner.
// ---------------------------------------------------------------------------

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/** Injectable low-level spawn (tests pass a fake). */
export type RepoSpawn = (
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<SpawnOutcome>;

/** Spawn argv-style, capturing bounded stdout/stderr with a SIGKILL timeout. */
const spawnRepo: RepoSpawn = (argv, cwd, env, timeoutMs) => {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let truncatedOutput = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + `\n[oswald] ${cmd} timed out after ${timeoutMs}ms`,
        spawnError: "timeout",
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!truncatedOutput) {
          truncatedOutput = true;
          stderr += `\n[oswald] ${cmd} stdout exceeded ${MAX_STDOUT_BYTES} bytes; truncated`;
          child.kill("SIGKILL");
        }
        return;
      }
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
};

/**
 * Run a single git / forge CLI invocation and return a typed outcome.
 *
 * Never throws for an expected failure (missing binary, spawn error, timeout,
 * non-zero exit) — those come back as `{ ok:false, reason }`. The caller is
 * responsible for having routed any write through the ApprovalService BEFORE
 * calling this.
 *
 * @param spawnImpl injectable spawn (tests); defaults to the real spawn.
 */
export async function runRepoCommand(
  argv: string[],
  options: RepoRunOptions,
  spawnImpl: RepoSpawn = spawnRepo,
): Promise<RepoCommandOutcome> {
  if (argv.length === 0) {
    return { ok: false, stdout: "", stderr: "", reason: "empty argv; refusing to run." };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: Record<string, string> = { ...(options.env ?? {}) };
  const outcome = await spawnImpl(argv, options.cwd, env, timeoutMs);
  const label = argv.slice(0, 2).join(" ");

  if (outcome.spawnError) {
    return {
      ok: false,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      reason:
        outcome.spawnError === "timeout"
          ? `'${label}' timed out after ${timeoutMs}ms`
          : `'${label}' failed to run: ${scrubRemoteCredentials(outcome.spawnError)}`,
      spawnError: outcome.spawnError,
    };
  }

  if (outcome.exitCode !== 0) {
    const firstErrLine =
      outcome.stderr.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    return {
      ok: false,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      reason: `'${label}' exited ${outcome.exitCode}${
        firstErrLine ? `: ${scrubRemoteCredentials(firstErrLine.trim())}` : ""
      }`,
    };
  }

  return {
    ok: true,
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  };
}
