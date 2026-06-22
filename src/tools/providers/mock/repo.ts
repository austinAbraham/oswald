/**
 * Mock repo provider.
 *
 * Read methods use safe local-git read-only fallbacks (`git rev-parse`,
 * `git status`) when a git binary + repo are present, falling back to static
 * defaults otherwise. Write methods (createBranch/commit/openPullRequest) route
 * through the ApprovalService and default-deny — they never actually mutate the
 * repo in mock mode.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ApprovalService,
  type ApprovalPolicy,
} from "../../../core/approvals/index.js";
import type {
  Capability,
  HealthReport,
  InvokeOptions,
  InvokeResult,
  PullRequest,
  RepoProvider,
} from "../types.js";

const execFileAsync = promisify(execFile);

export interface MockRepoOptions {
  cwd?: string;
  approvals?: ApprovalService;
  policy?: ApprovalPolicy;
  /** Override branch for fully-offline tests. */
  branch?: string;
}

const DEFAULT_POLICY: ApprovalPolicy = {
  requireApprovalFor: ["create_branch", "commit", "open_pull_request", "push"],
  prohibit: ["direct_push_to_protected_branch"],
};

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export class MockRepoProvider implements RepoProvider {
  readonly name = "mock-repo";
  readonly kind = "repo" as const;

  private readonly cwd: string;
  private readonly approvals: ApprovalService;
  private readonly policy: ApprovalPolicy;
  private readonly branchOverride: string | undefined;

  constructor(options: MockRepoOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.approvals = options.approvals ?? new ApprovalService();
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.branchOverride = options.branch;
  }

  capabilities(): Capability[] {
    return [
      { name: "currentBranch", write: false },
      { name: "changedFiles", write: false },
      { name: "createBranch", write: true },
      { name: "commit", write: true },
      { name: "openPullRequest", write: true },
    ];
  }

  async health(): Promise<HealthReport> {
    const inside = await tryGit(this.cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside === "true") {
      return { state: "ok", detail: `git repo at ${this.cwd} (read-only)` };
    }
    return { state: "degraded", detail: "no git repo detected; using static fallbacks" };
  }

  async currentBranch(): Promise<string> {
    if (this.branchOverride) return this.branchOverride;
    const b = await tryGit(this.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return b ?? "main";
  }

  async changedFiles(): Promise<string[]> {
    const out = await tryGit(this.cwd, ["status", "--porcelain"]);
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
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
    void message;
    void files;
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
    return {
      ok: true,
      data: { ...pr, number: 1, url: `https://example.invalid/pr/1` },
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

/** Read a file relative to the repo root, if present. Read-only helper. */
export async function readRepoFile(
  cwd: string,
  rel: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path.resolve(cwd, rel), "utf8");
  } catch {
    return null;
  }
}
