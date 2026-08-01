/**
 * Git repo provider — runs Oswald's repo operations against the LOCAL git
 * repository by shelling out to the `git` CLI, and opens pull requests via the
 * forge CLI (`gh` / `glab` / `az`) selected from the remote URL (NON-MCP path).
 *
 * Structural clone of {@link MockRepoProvider}: same interface, same
 * approval-gate-before-side-effect discipline. The only difference is the
 * backend — write operations actually run, via {@link runRepoCommand} (the
 * single git/forge-spawning seam).
 *
 * SAFETY INVARIANTS:
 *   - APPROVAL BEFORE SPAWN: createBranch / commit / openPullRequest route
 *     through the ApprovalService FIRST (action classes `create_branch`,
 *     `commit`, `open_pull_request` — plus `push`, since opening a PR pushes
 *     the feature branch), exactly as the mock does. Default-deny: no explicit
 *     `yes` + permitting policy → refused WITHOUT spawning. A config
 *     `policies.prohibit: ["push"]` refuses the PR push outright.
 *   - NO PUSH-TO-PROTECTED PATH: there is no way to push `main`/`master` (or
 *     the PR base branch) through this provider. `openPullRequest` pushes ONLY
 *     the named feature branch, refuses protected names outright, refuses
 *     ref-qualified names (`refs/…`, `heads/…`) that could dodge the name
 *     check, and pushes a fully qualified `refs/heads/` refspec — the
 *     `direct_push_to_protected_branch` prohibition is enforced structurally,
 *     not just by policy.
 *   - ARGV SAFETY: branch names are validated against a conservative ref
 *     grammar (no leading `-`, no `..`, no `refs/`/`heads/` prefix) and file
 *     paths are staged behind `--`, so caller-supplied strings can never become
 *     git options. Nothing is ever interpolated into a shell.
 *   - GRACEFUL DEGRADATION: a missing forge CLI or an unrecognized remote
 *     refuses `openPullRequest` with actionable guidance (and `health()`
 *     reports it) instead of failing mysteriously.
 *   - NO SECRETS: git and the forge CLIs hold their own auth; error reasons
 *     are credential-scrubbed by the runner before they surface.
 */
import * as path from "node:path";
import {
  ApprovalService,
  type ApprovalPolicy,
} from "../../core/approvals/index.js";
import type {
  Capability,
  HealthReport,
  InvokeOptions,
  InvokeResult,
  PullRequest,
  RepoProvider,
} from "../providers/types.js";
import { detectCli } from "./detect.js";
import {
  buildAddArgv,
  buildChangedFilesArgv,
  buildCommitArgv,
  buildCreateBranchArgv,
  buildCurrentBranchArgv,
  buildIsInsideWorkTreeArgv,
  buildPushArgv,
  buildRemoteUrlArgv,
  runRepoCommand,
  splitRepoInvocation,
} from "./runner.js";
import {
  buildForgePrArgv,
  defaultForgeInvocation,
  detectForge,
  parseForgePrOutput,
} from "./forge.js";
import type {
  CliDetector,
  GitRepoProviderOptions,
  RepoRunner,
} from "./types.js";

/** Same conservative default policy as the mock repo provider. */
const DEFAULT_POLICY: ApprovalPolicy = {
  requireApprovalFor: ["create_branch", "commit", "open_pull_request", "push"],
  prohibit: ["direct_push_to_protected_branch"],
};

/**
 * Branch names that must never be pushed by this provider, regardless of
 * policy or consent. The PR base branch is treated as protected too.
 */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/**
 * Conservative ref-name gate: letters/digits/`.`/`_`/`/`/`-`, must start with
 * a letter or digit (so a name can never be parsed as a git option), no `..`,
 * and no `refs/` or `heads/` leading path segment — a ref-qualified name like
 * `refs/heads/main` would otherwise slip past the exact-string protected-branch
 * guard while resolving to the protected ref. Stricter than git's own rules on
 * purpose — when in doubt, refuse.
 */
export function isSafeRefName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.includes("..")) return false;
  if (/^(refs|heads)\//i.test(name)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name);
}

export class GitRepoProvider implements RepoProvider {
  readonly name = "git";
  readonly kind = "repo" as const;

  private readonly cwd: string;
  private readonly command: string | undefined;
  private readonly forgeCommand: string | undefined;
  private readonly remote: string;
  private readonly timeoutMs: number | undefined;
  private readonly approvals: ApprovalService;
  private readonly policy: ApprovalPolicy;
  private readonly runner: RepoRunner;
  private readonly detect: CliDetector;

  constructor(options: GitRepoProviderOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.command = options.command;
    this.forgeCommand = options.forgeCommand;
    this.remote = options.remote ?? "origin";
    this.timeoutMs = options.timeoutMs;
    this.approvals = options.approvals ?? new ApprovalService();
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.runner = options.runner ?? runRepoCommand;
    this.detect = options.detectCli ?? detectCli;
  }

  capabilities(): Capability[] {
    return [
      { name: "currentBranch", write: false },
      { name: "changedFiles", write: false },
      {
        name: "createBranch",
        write: true,
        description: "Approval-gated; runs `git checkout -b` (argv-only, no shell)",
      },
      {
        name: "commit",
        write: true,
        description: "Approval-gated; stages an explicit file list then commits",
      },
      {
        name: "openPullRequest",
        write: true,
        description:
          "Approval-gated; pushes ONLY the feature branch, then opens the PR via gh/glab/az",
      },
    ];
  }

  async health(): Promise<HealthReport> {
    // Best-effort probe. Uses read-only git commands through the same single
    // spawn seam, and CATCHES everything so health never throws.
    try {
      const base = splitRepoInvocation(this.command);
      const inside = await this.runner(buildIsInsideWorkTreeArgv(base), {
        cwd: this.cwd,
        ...(this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
      });
      if (!inside.ok || inside.stdout.trim() !== "true") {
        return {
          state: "unavailable",
          detail: `no git repo at ${this.cwd} (or the '${this.command ?? "git"}' CLI is missing)`,
        };
      }
      const remoteUrl = await this.runner(buildRemoteUrlArgv(base, this.remote), {
        cwd: this.cwd,
        ...(this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
      });
      if (!remoteUrl.ok) {
        return {
          state: "degraded",
          detail: `git repo at ${this.cwd}; remote '${this.remote}' not configured — openPullRequest unavailable`,
        };
      }
      const forge = detectForge(remoteUrl.stdout.trim());
      if (forge === "unknown") {
        return {
          state: "degraded",
          detail: `git repo at ${this.cwd}; remote '${this.remote}' is not a recognized forge (github/gitlab/azure) — openPullRequest unavailable`,
        };
      }
      const invocation = this.forgeCommand ?? defaultForgeInvocation(forge);
      const cli = this.detect(invocation);
      if (!cli.available) {
        return {
          state: "degraded",
          detail: `git repo at ${this.cwd}; forge ${forge} detected but the '${invocation}' CLI was not found — openPullRequest will be refused`,
        };
      }
      return {
        state: "ok",
        detail: `git repo at ${this.cwd}; forge ${forge} via '${invocation}' (writes approval-gated)`,
      };
    } catch (err) {
      return {
        state: "degraded",
        detail: `git health probe errored: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async currentBranch(): Promise<string> {
    const base = splitRepoInvocation(this.command);
    const out = await this.runner(buildCurrentBranchArgv(base), {
      cwd: this.cwd,
      ...(this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
    });
    // Same degrade behavior as the mock: fall back to "main" when unresolvable.
    const branch = out.ok ? out.stdout.trim() : "";
    return branch || "main";
  }

  async changedFiles(): Promise<string[]> {
    const base = splitRepoInvocation(this.command);
    const out = await this.runner(buildChangedFilesArgv(base), {
      cwd: this.cwd,
      ...(this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
    });
    if (!out.ok) return [];
    return out.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  async createBranch(
    name: string,
    options: InvokeOptions = {},
  ): Promise<InvokeResult<{ branch: string }>> {
    const decision = this.approvals.requireApproval("create_branch", {
      yes: options.yes,
      policy: this.policy,
      reason: options.reason,
    });
    if (!decision.allowed) return { ok: false, error: decision.reason };
    if (!isSafeRefName(name)) {
      return {
        ok: false,
        error: `unsafe branch name refused (letters/digits/'.'/'_'/'/'/'-' only, must not start with '-' or contain '..')`,
      };
    }
    const base = splitRepoInvocation(this.command);
    const res = await this.runner(buildCreateBranchArgv(base, name), {
      cwd: this.cwd,
      ...(this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
    });
    if (!res.ok) {
      return { ok: false, error: res.reason ?? "git checkout -b failed" };
    }
    return { ok: true, data: { branch: name } };
  }

  async commit(
    message: string,
    files: string[],
    options: InvokeOptions = {},
  ): Promise<InvokeResult<{ committed: boolean }>> {
    const decision = this.approvals.requireApproval("commit", {
      yes: options.yes,
      policy: this.policy,
      reason: options.reason,
    });
    if (!decision.allowed) return { ok: false, error: decision.reason };
    if (!message.trim()) {
      return { ok: false, error: "commit refused: message must not be empty." };
    }
    if (files.length === 0) {
      return {
        ok: false,
        error:
          "commit refused: an explicit file list is required (Oswald never stages everything implicitly).",
      };
    }
    for (const file of files) {
      if (!file || file.startsWith("-")) {
        return { ok: false, error: `commit refused: unsafe path in file list.` };
      }
    }
    const base = splitRepoInvocation(this.command);
    const runOpts = {
      cwd: this.cwd,
      ...(this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
    };
    const added = await this.runner(buildAddArgv(base, files), runOpts);
    if (!added.ok) {
      return { ok: false, error: added.reason ?? "git add failed" };
    }
    const committed = await this.runner(buildCommitArgv(base, message), runOpts);
    if (!committed.ok) {
      return { ok: false, error: committed.reason ?? "git commit failed" };
    }
    return { ok: true, data: { committed: true } };
  }

  async openPullRequest(
    pr: PullRequest,
    options: InvokeOptions = {},
  ): Promise<InvokeResult<PullRequest>> {
    const decision = this.approvals.requireApproval("open_pull_request", {
      yes: options.yes,
      policy: this.policy,
      reason: options.reason,
    });
    if (!decision.allowed) return { ok: false, error: decision.reason };

    // Opening a PR pushes the feature branch, so the `push` action class must
    // also permit it — a config `policies.prohibit: ["push"]` refuses here,
    // BEFORE anything spawns.
    const pushDecision = this.approvals.requireApproval("push", {
      yes: options.yes,
      policy: this.policy,
      reason: options.reason,
    });
    if (!pushDecision.allowed) return { ok: false, error: pushDecision.reason };

    if (!isSafeRefName(pr.branch) || !isSafeRefName(pr.base)) {
      return {
        ok: false,
        error:
          "openPullRequest refused: unsafe branch or base name (ref-qualified names like 'refs/heads/…' are rejected).",
      };
    }
    // Structural no-push-to-protected guard: the ONLY branch this provider can
    // push is the feature branch, and it must never be a protected branch or
    // the PR base itself. This cannot be overridden by consent or policy.
    // (isSafeRefName above already refused `refs/`-/`heads/`-qualified names,
    // so the exact-string comparison here cannot be sidestepped, and
    // buildPushArgv pushes a fully qualified refs/heads/ refspec besides.)
    if (
      PROTECTED_BRANCHES.includes(pr.branch) ||
      pr.branch === pr.base
    ) {
      return {
        ok: false,
        error: `openPullRequest refused: pushing protected branch '${pr.branch}' is prohibited; open PRs from a feature branch.`,
      };
    }

    const base = splitRepoInvocation(this.command);
    const runOpts = {
      cwd: this.cwd,
      ...(this.timeoutMs != null ? { timeoutMs: this.timeoutMs } : {}),
    };

    // Resolve the forge BEFORE any push, so nothing is pushed when the PR
    // cannot be completed.
    const remoteUrl = await this.runner(
      buildRemoteUrlArgv(base, this.remote),
      runOpts,
    );
    if (!remoteUrl.ok) {
      return {
        ok: false,
        error: `openPullRequest refused: cannot resolve remote '${this.remote}' (${remoteUrl.reason ?? "no remote"}).`,
      };
    }
    const forge = detectForge(remoteUrl.stdout.trim());
    if (forge === "unknown") {
      return {
        ok: false,
        error: `openPullRequest refused: remote '${this.remote}' does not point at a recognized forge (github.com / gitlab / dev.azure.com); open the PR manually from branch '${pr.branch}'.`,
      };
    }
    const invocation = this.forgeCommand ?? defaultForgeInvocation(forge);
    const cli = this.detect(invocation);
    if (!cli.available) {
      return {
        ok: false,
        error: `openPullRequest refused: the '${invocation}' CLI is required for ${forge} but was not found on PATH; install it (or set repo.forge_command) or open the PR manually from branch '${pr.branch}'.`,
      };
    }

    // Push ONLY the feature branch.
    const pushed = await this.runner(
      buildPushArgv(base, this.remote, pr.branch),
      runOpts,
    );
    if (!pushed.ok) {
      return { ok: false, error: pushed.reason ?? "git push failed" };
    }

    const forgeBase = splitRepoInvocation(invocation, defaultForgeInvocation(forge));
    const created = await this.runner(
      buildForgePrArgv(forge, forgeBase, pr),
      runOpts,
    );
    if (!created.ok) {
      return { ok: false, error: created.reason ?? `${invocation} PR creation failed` };
    }
    const parsed = parseForgePrOutput(forge, created.stdout);
    return {
      ok: true,
      data: {
        ...pr,
        ...(parsed.url != null ? { url: parsed.url } : {}),
        ...(parsed.number != null ? { number: parsed.number } : {}),
      },
    };
  }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    options?: InvokeOptions,
  ): Promise<InvokeResult> {
    switch (toolName) {
      case "currentBranch":
        return { ok: true, data: await this.currentBranch() };
      case "changedFiles":
        return { ok: true, data: await this.changedFiles() };
      case "createBranch":
        return this.createBranch(String(args.name), options);
      case "commit":
        return this.commit(
          String(args.message),
          Array.isArray(args.files) ? (args.files as string[]) : [],
          options,
        );
      case "openPullRequest":
        return this.openPullRequest(args.pr as PullRequest, options);
      default:
        return { ok: false, error: `unknown repo tool: ${toolName}` };
    }
  }
}
