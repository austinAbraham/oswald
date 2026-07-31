/**
 * Typed contracts for the real git repo provider path.
 *
 * These shapes are the boundary between Oswald and the `git` binary (plus the
 * forge CLI — `gh` / `glab` / `az` — used to open pull requests). The design
 * mirrors the Snowflake runner's types: stable, transport-decoupled, and
 * carrying only what crosses the process edge. NO secrets ever appear here —
 * forge authentication lives in the forge CLI's own config (`gh auth`,
 * `glab auth`, `az login`) and never enters argv, env, logs, or artifacts.
 */
import type { ApprovalService, ApprovalPolicy } from "../../core/approvals/index.js";

/**
 * The forge a git remote points at, derived from the remote URL. Determines
 * which CLI opens the pull request: `gh` (github), `glab` (gitlab), or
 * `az repos` (azure). `unknown` means openPullRequest is refused with guidance.
 */
export type ForgeKind = "github" | "gitlab" | "azure" | "unknown";

/** Options for a single {@link runRepoCommand} invocation. */
export interface RepoRunOptions {
  /** Working directory the subprocess runs in (the project root). Required. */
  cwd: string;
  /** Timeout in ms for the subprocess. Default 60000 (1 min). */
  timeoutMs?: number;
  /** Extra environment variables for the subprocess (never used for secrets). */
  env?: Record<string, string>;
}

/** The typed outcome of a single git / forge CLI invocation. Never thrown. */
export interface RepoCommandOutcome {
  /** True when the command ran and exited 0. */
  ok: boolean;
  /** Process exit code (0 = clean). `null` when nothing ran or on spawn error. */
  exitCode?: number | null;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Human-readable reason when not ok (spawn/exit failure). Credential-scrubbed. */
  reason?: string;
  /** Set to a short token ("timeout" / the OS error) when the spawn itself failed. */
  spawnError?: string;
}

/** A pluggable runner function (defaults to {@link runRepoCommand}; injected in tests). */
export type RepoRunner = (
  argv: string[],
  options: RepoRunOptions,
) => Promise<RepoCommandOutcome>;

/** Result of probing for a CLI binary (git / gh / glab / az). */
export interface CliDetection {
  /** True when `<command> --version` ran and exited 0. */
  available: boolean;
  /** The trimmed version string, when recoverable. */
  version?: string;
}

/** A pluggable CLI probe (defaults to {@link detectCli}; injected in tests). */
export type CliDetector = (command: string) => CliDetection;

/** Options for {@link GitRepoProvider}. */
export interface GitRepoProviderOptions {
  /** Project root the git commands run in. Defaults to process.cwd(). */
  cwd?: string;
  /** The git invocation (whitespace-split into argv). Defaults to "git". */
  command?: string;
  /**
   * Override the forge CLI invocation (whitespace-split into argv). When unset
   * the invocation is derived from the detected forge: "gh" / "glab" / "az".
   */
  forgeCommand?: string;
  /** The git remote pull requests target. Defaults to "origin". */
  remote?: string;
  /** Subprocess timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Approval service for the write gate. Defaults to a fresh ApprovalService. */
  approvals?: ApprovalService;
  /** Approval policy for the write gate. Defaults to the conservative default. */
  policy?: ApprovalPolicy;
  /** Injectable runner (tests). Defaults to the real {@link runRepoCommand}. */
  runner?: RepoRunner;
  /** Injectable CLI probe (tests). Defaults to the real {@link detectCli}. */
  detectCli?: CliDetector;
}
