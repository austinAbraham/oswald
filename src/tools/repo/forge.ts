/**
 * Forge routing for `openPullRequest` — which CLI opens the PR, and with what
 * argv, decided by the git remote URL.
 *
 * Supported forges (detection → CLI):
 *   - github.com                          → `gh pr create`
 *   - gitlab (gitlab.com or self-hosted)  → `glab mr create`
 *   - dev.azure.com / *.visualstudio.com  → `az repos pr create`
 *
 * Everything here is pure + deterministic (unit-tested directly): URL parsing,
 * argv construction, and output parsing. Nothing in this module spawns a
 * process. NO secrets — forge auth lives in the forge CLI's own config.
 */
import type { PullRequest } from "../providers/types.js";
import type { ForgeKind } from "./types.js";

/** A forge we can actually open a PR on (i.e. not `unknown`). */
export type KnownForge = Exclude<ForgeKind, "unknown">;

/**
 * The deterministic PR body used when the forge CLI requires one. The real,
 * evidence-backed description lives in the `pr_summary.md` artifact; the body
 * points reviewers there rather than duplicating (possibly sensitive) content.
 */
export const FORGE_PR_BODY =
  "Opened by Oswald delivery. See the pr_summary.md artifact in the project's artifact directory for the full, evidence-backed description.";

/**
 * Extract the host from a git remote URL. Handles both URL-style remotes
 * (`https://…`, `ssh://…`) and scp-like remotes (`git@host:org/repo.git`).
 * Returns null when no host is recoverable. Never throws.
 */
export function remoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  const scpLike = /^[\w.+-]+@([\w.-]+):/.exec(trimmed);
  if (scpLike) return scpLike[1]!.toLowerCase();
  try {
    return new URL(trimmed).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Classify a git remote URL into a forge. Conservative: anything not clearly
 * recognized is `unknown`, and `unknown` means openPullRequest is refused with
 * guidance rather than guessing a CLI.
 */
export function detectForge(remoteUrl: string): ForgeKind {
  const host = remoteHost(remoteUrl);
  if (!host) return "unknown";
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (
    host === "dev.azure.com" ||
    host === "ssh.dev.azure.com" ||
    host.endsWith(".visualstudio.com")
  ) {
    return "azure";
  }
  return "unknown";
}

/** The default CLI invocation for a forge (`gh` / `glab` / `az`). */
export function defaultForgeInvocation(forge: KnownForge): string {
  switch (forge) {
    case "github":
      return "gh";
    case "gitlab":
      return "glab";
    case "azure":
      return "az";
  }
}

/**
 * Build the exact argv that opens a pull request on a forge. Pure +
 * deterministic (unit-tested directly). Title / branch / base are single argv
 * elements — never interpolated into a shell.
 */
export function buildForgePrArgv(
  forge: KnownForge,
  base: string[],
  pr: PullRequest,
): string[] {
  switch (forge) {
    case "github":
      return [
        ...base,
        "pr",
        "create",
        "--title",
        pr.title,
        "--head",
        pr.branch,
        "--base",
        pr.base,
        "--body",
        FORGE_PR_BODY,
      ];
    case "gitlab":
      return [
        ...base,
        "mr",
        "create",
        "--title",
        pr.title,
        "--source-branch",
        pr.branch,
        "--target-branch",
        pr.base,
        "--description",
        FORGE_PR_BODY,
        "--yes",
      ];
    case "azure":
      return [
        ...base,
        "repos",
        "pr",
        "create",
        "--title",
        pr.title,
        "--source-branch",
        pr.branch,
        "--target-branch",
        pr.base,
        "--description",
        FORGE_PR_BODY,
      ];
  }
}

/**
 * Best-effort extraction of the created PR's URL + number from the forge CLI's
 * stdout. `gh` / `glab` print the PR/MR URL; `az` prints a JSON document with
 * `pullRequestId`. Anything unparseable degrades to `{}` — never throws.
 */
export function parseForgePrOutput(
  forge: KnownForge,
  stdout: string,
): { url?: string; number?: number } {
  if (forge === "azure") {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const id = record.pullRequestId;
        if (typeof id === "number" && Number.isInteger(id)) {
          const repo = record.repository;
          const webUrl =
            repo !== null && typeof repo === "object"
              ? (repo as Record<string, unknown>).webUrl
              : undefined;
          return typeof webUrl === "string" && webUrl
            ? { url: `${webUrl}/pullrequest/${id}`, number: id }
            : { number: id };
        }
      }
    } catch {
      /* fall through to the generic URL scan */
    }
  }
  const urlMatch = /https?:\/\/\S+/.exec(stdout);
  if (!urlMatch) return {};
  const url = urlMatch[0];
  const numberMatch = /\/(?:pull|merge_requests|pullrequest)\/(\d+)/.exec(url);
  return numberMatch ? { url, number: Number(numberMatch[1]) } : { url };
}
