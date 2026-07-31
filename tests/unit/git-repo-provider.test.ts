/**
 * Unit tests for the repo runner, forge routing, and the git repo provider.
 *
 * No forge CLI is ever spawned: the runner's low-level spawn is replaced with a
 * fake that captures argv and returns canned output, and the provider is driven
 * with an injected fake runner + CLI probe. These assert the security-critical
 * invariants: exact argv, approval-before-spawn (default-deny), the structural
 * no-push-to-protected-branch guard, forge selection by remote URL, graceful
 * degradation when a CLI is missing, and credential scrubbing.
 *
 * A final guarded section exercises the REAL git binary against a throwaway
 * `git init` repo in a temp dir (hermetic: no system/global config, fixed
 * identity, no network) and is skipped cleanly when git is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  splitRepoInvocation,
  scrubRemoteCredentials,
  buildCurrentBranchArgv,
  buildChangedFilesArgv,
  buildRemoteUrlArgv,
  buildCreateBranchArgv,
  buildAddArgv,
  buildCommitArgv,
  buildPushArgv,
  runRepoCommand,
  type RepoSpawn,
} from "../../src/tools/repo/runner.js";
import {
  detectForge,
  remoteHost,
  buildForgePrArgv,
  parseForgePrOutput,
  FORGE_PR_BODY,
} from "../../src/tools/repo/forge.js";
import {
  GitRepoProvider,
  isSafeRefName,
  PROTECTED_BRANCHES,
} from "../../src/tools/repo/provider.js";
import { detectGit } from "../../src/tools/repo/detect.js";
import { selectRepoProvider } from "../../src/cli/commands/_providers.js";
import type {
  RepoCommandOutcome,
  RepoRunOptions,
} from "../../src/tools/repo/types.js";
import type { PullRequest } from "../../src/tools/providers/types.js";

/** A fake RepoSpawn that records the argv it was called with and returns canned output. */
function fakeSpawn(
  result: { exitCode?: number | null; stdout?: string; stderr?: string; spawnError?: string },
): { spawn: RepoSpawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: RepoSpawn = async (argv) => {
    calls.push(argv);
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.spawnError != null ? { spawnError: result.spawnError } : {}),
    };
  };
  return { spawn, calls };
}

describe("splitRepoInvocation", () => {
  it("defaults to ['git']", () => {
    expect(splitRepoInvocation(undefined)).toEqual(["git"]);
    expect(splitRepoInvocation("   ")).toEqual(["git"]);
  });
  it("whitespace-splits a wrapper invocation", () => {
    expect(splitRepoInvocation("xcrun git")).toEqual(["xcrun", "git"]);
  });
  it("honors a different fallback for forge CLIs", () => {
    expect(splitRepoInvocation(undefined, "gh")).toEqual(["gh"]);
  });
});

describe("scrubRemoteCredentials", () => {
  it("masks scheme://user:token@host credentials", () => {
    expect(
      scrubRemoteCredentials("push failed: https://user:tok3n@github.com/o/r.git"),
    ).toBe("push failed: https://***@github.com/o/r.git");
  });
  it("leaves credential-free text untouched", () => {
    expect(scrubRemoteCredentials("https://github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
  });
});

describe("argv builders — the only git invocations Oswald can emit", () => {
  const base = ["git"];
  it("read-only builders", () => {
    expect(buildCurrentBranchArgv(base)).toEqual(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(buildChangedFilesArgv(base)).toEqual(["git", "status", "--porcelain"]);
    expect(buildRemoteUrlArgv(base, "origin")).toEqual(["git", "remote", "get-url", "origin"]);
  });
  it("write builders", () => {
    expect(buildCreateBranchArgv(base, "feat/x")).toEqual(["git", "checkout", "-b", "feat/x"]);
    expect(buildCommitArgv(base, "feat: msg")).toEqual(["git", "commit", "-m", "feat: msg"]);
  });
  it("add always stages behind '--' so paths can never become options", () => {
    expect(buildAddArgv(base, ["a.sql", "b.yml"])).toEqual(["git", "add", "--", "a.sql", "b.yml"]);
  });
  it("push can only express ONE explicit named branch", () => {
    expect(buildPushArgv(base, "origin", "feat/x")).toEqual([
      "git",
      "push",
      "--set-upstream",
      "origin",
      "feat/x",
    ]);
  });
});

describe("runRepoCommand — spawn seam", () => {
  const opts: RepoRunOptions = { cwd: "/tmp" };

  it("spawns with the exact argv it was handed", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "main\n" });
    const out = await runRepoCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], opts, spawn);
    expect(out.ok).toBe(true);
    expect(calls).toEqual([["git", "rev-parse", "--abbrev-ref", "HEAD"]]);
  });

  it("empty argv is refused without spawning", async () => {
    const { spawn, calls } = fakeSpawn({});
    const out = await runRepoCommand([], opts, spawn);
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("non-zero exit → ok:false with a scrubbed first stderr line", async () => {
    const { spawn } = fakeSpawn({
      exitCode: 128,
      stderr: "fatal: unable to access 'https://user:tok3n@github.com/o/r.git'",
    });
    const out = await runRepoCommand(["git", "push", "--set-upstream", "origin", "b"], opts, spawn);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/exited 128/);
    expect(out.reason).toContain("https://***@github.com");
    expect(out.reason).not.toContain("tok3n");
  });

  it("spawn error (ENOENT) → ok:false with spawnError", async () => {
    const { spawn } = fakeSpawn({ exitCode: null, spawnError: "Error: ENOENT" });
    const out = await runRepoCommand(["git", "status", "--porcelain"], opts, spawn);
    expect(out.ok).toBe(false);
    expect(out.spawnError).toMatch(/ENOENT/);
  });

  it("timeout → ok:false with a timeout reason", async () => {
    const { spawn } = fakeSpawn({ exitCode: null, spawnError: "timeout" });
    const out = await runRepoCommand(["git", "status", "--porcelain"], { cwd: "/tmp", timeoutMs: 5 }, spawn);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/timed out after 5ms/);
  });
});

describe("detectForge — forge routing by remote URL", () => {
  it("routes github.com (https + ssh + scp-like) to github", () => {
    expect(detectForge("https://github.com/acme/demo.git")).toBe("github");
    expect(detectForge("ssh://git@github.com/acme/demo.git")).toBe("github");
    expect(detectForge("git@github.com:acme/demo.git")).toBe("github");
  });
  it("routes gitlab.com and self-hosted gitlab to gitlab", () => {
    expect(detectForge("https://gitlab.com/acme/demo.git")).toBe("gitlab");
    expect(detectForge("git@gitlab.example.com:acme/demo.git")).toBe("gitlab");
  });
  it("routes dev.azure.com and visualstudio.com to azure", () => {
    expect(detectForge("https://dev.azure.com/acme/proj/_git/demo")).toBe("azure");
    expect(detectForge("git@ssh.dev.azure.com:v3/acme/proj/demo")).toBe("azure");
    expect(detectForge("https://acme.visualstudio.com/proj/_git/demo")).toBe("azure");
  });
  it("anything unrecognized is unknown (conservative)", () => {
    expect(detectForge("https://bitbucket.org/acme/demo.git")).toBe("unknown");
    expect(detectForge("not a url")).toBe("unknown");
    expect(detectForge("")).toBe("unknown");
  });
  it("ignores embedded credentials when extracting the host", () => {
    expect(remoteHost("https://user:tok3n@github.com/acme/demo.git")).toBe("github.com");
  });
});

describe("buildForgePrArgv + parseForgePrOutput", () => {
  const pr: PullRequest = { title: "feat: revenue model", branch: "feat/rev", base: "main" };

  it("github → gh pr create with title/head/base/body as single argv elements", () => {
    expect(buildForgePrArgv("github", ["gh"], pr)).toEqual([
      "gh", "pr", "create",
      "--title", "feat: revenue model",
      "--head", "feat/rev",
      "--base", "main",
      "--body", FORGE_PR_BODY,
    ]);
  });

  it("gitlab → glab mr create (non-interactive via --yes)", () => {
    expect(buildForgePrArgv("gitlab", ["glab"], pr)).toEqual([
      "glab", "mr", "create",
      "--title", "feat: revenue model",
      "--source-branch", "feat/rev",
      "--target-branch", "main",
      "--description", FORGE_PR_BODY,
      "--yes",
    ]);
  });

  it("azure → az repos pr create", () => {
    expect(buildForgePrArgv("azure", ["az"], pr)).toEqual([
      "az", "repos", "pr", "create",
      "--title", "feat: revenue model",
      "--source-branch", "feat/rev",
      "--target-branch", "main",
      "--description", FORGE_PR_BODY,
    ]);
  });

  it("parses the gh PR URL and number", () => {
    const parsed = parseForgePrOutput("github", "https://github.com/acme/demo/pull/7\n");
    expect(parsed.url).toBe("https://github.com/acme/demo/pull/7");
    expect(parsed.number).toBe(7);
  });

  it("parses the glab MR URL and number", () => {
    const parsed = parseForgePrOutput(
      "gitlab",
      "!42 feat\nhttps://gitlab.com/acme/demo/-/merge_requests/42\n",
    );
    expect(parsed.url).toBe("https://gitlab.com/acme/demo/-/merge_requests/42");
    expect(parsed.number).toBe(42);
  });

  it("parses the az JSON payload", () => {
    const stdout = JSON.stringify({
      pullRequestId: 9,
      repository: { webUrl: "https://dev.azure.com/acme/proj/_git/demo" },
    });
    const parsed = parseForgePrOutput("azure", stdout);
    expect(parsed.number).toBe(9);
    expect(parsed.url).toBe("https://dev.azure.com/acme/proj/_git/demo/pullrequest/9");
  });

  it("unparseable output degrades to {} (never throws)", () => {
    expect(parseForgePrOutput("github", "created!")).toEqual({});
    expect(parseForgePrOutput("azure", "not json")).toEqual({});
  });
});

describe("isSafeRefName", () => {
  it("accepts conventional branch names", () => {
    expect(isSafeRefName("feat/rev-model")).toBe(true);
    expect(isSafeRefName("TICKET-42")).toBe(true);
    expect(isSafeRefName("release/1.2.3")).toBe(true);
  });
  it("refuses option-lookalikes, traversal, and empties", () => {
    expect(isSafeRefName("-delete")).toBe(false);
    expect(isSafeRefName("--force")).toBe(false);
    expect(isSafeRefName("a..b")).toBe(false);
    expect(isSafeRefName("")).toBe(false);
    expect(isSafeRefName("has space")).toBe(false);
  });
});

describe("GitRepoProvider — approval gate + forge selection (injected runner)", () => {
  const PERMIT = {
    requireApprovalFor: ["create_branch", "commit", "open_pull_request", "push"],
    prohibit: ["direct_push_to_protected_branch"],
  };

  /** Build a provider with an injected runner that routes canned outcomes by argv. */
  function providerWith(
    handler: (argv: string[]) => Partial<RepoCommandOutcome>,
    overrides: Record<string, unknown> = {},
  ) {
    const calls: string[][] = [];
    const provider = new GitRepoProvider({
      cwd: "/tmp/demo",
      policy: PERMIT,
      detectCli: () => ({ available: true, version: "test 1.0" }),
      runner: async (argv: string[]) => {
        calls.push(argv);
        const partial = handler(argv);
        return { ok: true, stdout: "", stderr: "", ...partial };
      },
      ...overrides,
    });
    return { provider, calls };
  }

  const githubRemote = (argv: string[]): Partial<RepoCommandOutcome> => {
    if (argv[1] === "remote") return { stdout: "https://github.com/acme/demo.git\n" };
    if (argv[0] === "gh") return { stdout: "https://github.com/acme/demo/pull/3\n" };
    return {};
  };

  const pr: PullRequest = { title: "feat: x", branch: "feat/x", base: "main" };

  it("advertises read + write-classified capabilities", () => {
    const { provider } = providerWith(() => ({}));
    const caps = provider.capabilities();
    expect(caps.find((c) => c.name === "currentBranch")?.write).toBe(false);
    expect(caps.find((c) => c.name === "changedFiles")?.write).toBe(false);
    expect(caps.find((c) => c.name === "createBranch")?.write).toBe(true);
    expect(caps.find((c) => c.name === "commit")?.write).toBe(true);
    expect(caps.find((c) => c.name === "openPullRequest")?.write).toBe(true);
  });

  it("default-denies every write WITHOUT spawning (no yes)", async () => {
    const { provider, calls } = providerWith(() => ({}));
    expect((await provider.createBranch("feat/x")).ok).toBe(false);
    expect((await provider.commit("msg", ["a.sql"])).ok).toBe(false);
    expect((await provider.openPullRequest(pr)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a prohibited action is refused even WITH explicit yes (no spawn)", async () => {
    const { provider, calls } = providerWith(() => ({}), {
      policy: { requireApprovalFor: [], prohibit: ["create_branch"] },
    });
    const res = await provider.createBranch("feat/x", { yes: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/prohibited/i);
    expect(calls).toHaveLength(0);
  });

  it("createBranch with yes runs exactly `git checkout -b <name>`", async () => {
    const { provider, calls } = providerWith(() => ({}));
    const res = await provider.createBranch("feat/x", { yes: true });
    expect(res.ok).toBe(true);
    expect(res.data?.branch).toBe("feat/x");
    expect(calls).toEqual([["git", "checkout", "-b", "feat/x"]]);
  });

  it("refuses an option-lookalike branch name WITHOUT spawning", async () => {
    const { provider, calls } = providerWith(() => ({}));
    const res = await provider.createBranch("--force", { yes: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsafe branch name/i);
    expect(calls).toHaveLength(0);
  });

  it("commit stages the explicit list behind '--' then commits", async () => {
    const { provider, calls } = providerWith(() => ({}));
    const res = await provider.commit("feat: add model", ["models/a.sql", "models/a.yml"], {
      yes: true,
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      ["git", "add", "--", "models/a.sql", "models/a.yml"],
      ["git", "commit", "-m", "feat: add model"],
    ]);
  });

  it("commit refuses an empty file list WITHOUT spawning (never stages everything)", async () => {
    const { provider, calls } = providerWith(() => ({}));
    const res = await provider.commit("msg", [], { yes: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/explicit file list/i);
    expect(calls).toHaveLength(0);
  });

  it("commit refuses an option-lookalike path WITHOUT spawning", async () => {
    const { provider, calls } = providerWith(() => ({}));
    const res = await provider.commit("msg", ["-rf"], { yes: true });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("openPullRequest pushes ONLY the feature branch, then runs gh with exact argv", async () => {
    const { provider, calls } = providerWith(githubRemote);
    const res = await provider.openPullRequest(pr, { yes: true });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      ["git", "remote", "get-url", "origin"],
      ["git", "push", "--set-upstream", "origin", "feat/x"],
      [
        "gh", "pr", "create",
        "--title", "feat: x",
        "--head", "feat/x",
        "--base", "main",
        "--body", FORGE_PR_BODY,
      ],
    ]);
    expect(res.data?.url).toBe("https://github.com/acme/demo/pull/3");
    expect(res.data?.number).toBe(3);
  });

  it("refuses to push a protected branch even WITH yes (no spawn at all)", async () => {
    const { provider, calls } = providerWith(githubRemote);
    for (const branch of PROTECTED_BRANCHES) {
      const res = await provider.openPullRequest({ ...pr, branch, base: "develop" }, { yes: true });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/protected/i);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses when the feature branch equals the base (no spawn)", async () => {
    const { provider, calls } = providerWith(githubRemote);
    const res = await provider.openPullRequest({ ...pr, branch: "develop", base: "develop" }, { yes: true });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("an unrecognized forge remote refuses BEFORE any push", async () => {
    const { provider, calls } = providerWith((argv) =>
      argv[1] === "remote" ? { stdout: "https://bitbucket.org/acme/demo.git\n" } : {},
    );
    const res = await provider.openPullRequest(pr, { yes: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/recognized forge/i);
    expect(calls.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("a missing forge CLI refuses BEFORE any push (graceful degradation)", async () => {
    const { provider, calls } = providerWith(githubRemote, {
      detectCli: () => ({ available: false }),
    });
    const res = await provider.openPullRequest(pr, { yes: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/'gh' CLI is required/);
    expect(calls.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("a gitlab remote routes to glab mr create", async () => {
    const { provider, calls } = providerWith((argv) => {
      if (argv[1] === "remote") return { stdout: "git@gitlab.example.com:acme/demo.git\n" };
      if (argv[0] === "glab") return { stdout: "https://gitlab.example.com/acme/demo/-/merge_requests/5\n" };
      return {};
    });
    const res = await provider.openPullRequest(pr, { yes: true });
    expect(res.ok).toBe(true);
    const forgeCall = calls.at(-1)!;
    expect(forgeCall.slice(0, 3)).toEqual(["glab", "mr", "create"]);
    expect(res.data?.number).toBe(5);
  });

  it("an azure remote routes to az repos pr create", async () => {
    const { provider, calls } = providerWith((argv) => {
      if (argv[1] === "remote") return { stdout: "https://dev.azure.com/acme/proj/_git/demo\n" };
      if (argv[0] === "az") return { stdout: JSON.stringify({ pullRequestId: 11 }) };
      return {};
    });
    const res = await provider.openPullRequest(pr, { yes: true });
    expect(res.ok).toBe(true);
    const forgeCall = calls.at(-1)!;
    expect(forgeCall.slice(0, 4)).toEqual(["az", "repos", "pr", "create"]);
    expect(res.data?.number).toBe(11);
  });

  it("a failed push surfaces the (scrubbed) reason and never reaches the forge CLI", async () => {
    const { provider, calls } = providerWith((argv) => {
      if (argv[1] === "remote") return { stdout: "https://github.com/acme/demo.git\n" };
      if (argv[1] === "push") return { ok: false, reason: "'git push' exited 128" };
      return {};
    });
    const res = await provider.openPullRequest(pr, { yes: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exited 128/);
    expect(calls.some((argv) => argv[0] === "gh")).toBe(false);
  });

  it("currentBranch parses rev-parse output and falls back to main on failure", async () => {
    const { provider } = providerWith((argv) =>
      argv[1] === "rev-parse" ? { stdout: "feat/rev\n" } : {},
    );
    expect(await provider.currentBranch()).toBe("feat/rev");
    const { provider: broken } = providerWith(() => ({ ok: false, reason: "boom" }));
    expect(await broken.currentBranch()).toBe("main");
  });

  it("changedFiles parses porcelain output", async () => {
    const { provider } = providerWith((argv) =>
      argv[1] === "status"
        ? { stdout: " M src/a.ts\n?? models/new.sql\nA  docs/x.md\n" }
        : {},
    );
    expect(await provider.changedFiles()).toEqual(["src/a.ts", "models/new.sql", "docs/x.md"]);
  });

  it("health is ok with a recognized forge + available CLI", async () => {
    const { provider } = providerWith((argv) => {
      if (argv[1] === "rev-parse") return { stdout: "true\n" };
      if (argv[1] === "remote") return { stdout: "https://github.com/acme/demo.git\n" };
      return {};
    });
    const h = await provider.health();
    expect(h.state).toBe("ok");
    expect(h.detail).toMatch(/forge github/);
  });

  it("health degrades when the forge CLI is missing (and says so)", async () => {
    const { provider } = providerWith(
      (argv) => {
        if (argv[1] === "rev-parse") return { stdout: "true\n" };
        if (argv[1] === "remote") return { stdout: "https://github.com/acme/demo.git\n" };
        return {};
      },
      { detectCli: () => ({ available: false }) },
    );
    const h = await provider.health();
    expect(h.state).toBe("degraded");
    expect(h.detail).toMatch(/gh/);
  });

  it("health is unavailable outside a git repo", async () => {
    const { provider } = providerWith(() => ({ ok: false, stdout: "", reason: "not a repo" }));
    const h = await provider.health();
    expect(h.state).toBe("unavailable");
  });
});

describe("selectRepoProvider — opt-in wiring with mock fallback", () => {
  it("wires the deterministic mock by default (no settings)", () => {
    expect(selectRepoProvider("/tmp/demo", undefined).name).toBe("mock-repo");
  });

  it("wires the mock when the config asks for it explicitly", () => {
    expect(selectRepoProvider("/tmp/demo", { provider: "mock" }).name).toBe("mock-repo");
  });

  it("falls back to the mock when the configured git CLI does not exist", () => {
    const p = selectRepoProvider("/tmp/demo", {
      provider: "git",
      command: "definitely-not-a-real-git-binary-xyz",
    });
    expect(p.name).toBe("mock-repo");
  });
});

// ---------------------------------------------------------------------------
// REAL git — hermetic temp-repo tests (skipped cleanly when git is missing).
// ---------------------------------------------------------------------------

const GIT_AVAILABLE = detectGit().available;

(GIT_AVAILABLE ? describe : describe.skip)(
  "selectRepoProvider — real git opt-in",
  () => {
    it("wires the real GitRepoProvider when opted in and git is detected", () => {
      expect(selectRepoProvider("/tmp/demo", { provider: "git" }).name).toBe("git");
    });
  },
);

(GIT_AVAILABLE ? describe : describe.skip)("GitRepoProvider — real local git repo", () => {
  const PERMIT = {
    requireApprovalFor: ["create_branch", "commit", "open_pull_request", "push"],
    prohibit: ["direct_push_to_protected_branch"],
  };
  const HERMETIC_ENV_KEYS = [
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_TERMINAL_PROMPT",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  const tmpDirs: string[] = [];
  let emptyGlobalConfig: string;

  beforeAll(async () => {
    for (const key of HERMETIC_ENV_KEYS) savedEnv[key] = process.env[key];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-gitcfg-"));
    tmpDirs.push(dir);
    emptyGlobalConfig = path.join(dir, "gitconfig");
    await fs.writeFile(emptyGlobalConfig, "", "utf8");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
    process.env.GIT_AUTHOR_NAME = "Oswald Test";
    process.env.GIT_AUTHOR_EMAIL = "oswald-test@example.invalid";
    process.env.GIT_COMMITTER_NAME = "Oswald Test";
    process.env.GIT_COMMITTER_EMAIL = "oswald-test@example.invalid";
    process.env.GIT_TERMINAL_PROMPT = "0";
  });

  afterAll(async () => {
    for (const key of HERMETIC_ENV_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    while (tmpDirs.length > 1) {
      const dir = tmpDirs.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const out = await runRepoCommand(["git", ...args], { cwd, timeoutMs: 30000 });
    expect(out.ok, out.reason ?? out.stderr).toBe(true);
    return out.stdout.trim();
  }

  async function makeRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-git-"));
    tmpDirs.push(dir);
    await git(dir, "init", "--initial-branch", "main");
    await fs.writeFile(path.join(dir, "README.md"), "# demo\n", "utf8");
    await git(dir, "add", "--", "README.md");
    await git(dir, "commit", "-m", "initial");
    return dir;
  }

  function provider(cwd: string): GitRepoProvider {
    return new GitRepoProvider({ cwd, policy: PERMIT, timeoutMs: 30000 });
  }

  it("currentBranch reads the real branch", async () => {
    const dir = await makeRepo();
    expect(await provider(dir).currentBranch()).toBe("main");
  });

  it("changedFiles reports untracked + modified files", async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, "notes.txt"), "hello\n", "utf8");
    expect(await provider(dir).changedFiles()).toEqual(["notes.txt"]);
  });

  it("createBranch without yes leaves the repo untouched", async () => {
    const dir = await makeRepo();
    const p = provider(dir);
    const res = await p.createBranch("feat/demo");
    expect(res.ok).toBe(false);
    expect(await p.currentBranch()).toBe("main");
  });

  it("createBranch with yes actually creates + switches", async () => {
    const dir = await makeRepo();
    const p = provider(dir);
    const res = await p.createBranch("feat/demo", { yes: true });
    expect(res.ok, res.error).toBe(true);
    expect(await p.currentBranch()).toBe("feat/demo");
  });

  it("commit with yes stages the explicit list and commits it", async () => {
    const dir = await makeRepo();
    const p = provider(dir);
    await fs.writeFile(path.join(dir, "model.sql"), "select 1\n", "utf8");
    const res = await p.commit("feat: add model", ["model.sql"], { yes: true });
    expect(res.ok, res.error).toBe(true);
    expect(await p.changedFiles()).toEqual([]);
    expect(await git(dir, "log", "-1", "--format=%s")).toBe("feat: add model");
  });

  it("commit without yes stages nothing", async () => {
    const dir = await makeRepo();
    const p = provider(dir);
    await fs.writeFile(path.join(dir, "model.sql"), "select 1\n", "utf8");
    const res = await p.commit("feat: add model", ["model.sql"]);
    expect(res.ok).toBe(false);
    expect(await p.changedFiles()).toEqual(["model.sql"]);
  });

  it("openPullRequest refuses with guidance when no remote is configured", async () => {
    const dir = await makeRepo();
    const res = await provider(dir).openPullRequest(
      { title: "t", branch: "feat/demo", base: "main" },
      { yes: true },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/remote 'origin'/);
  });

  it("openPullRequest refuses an unrecognized forge remote (nothing pushed)", async () => {
    const dir = await makeRepo();
    await git(dir, "remote", "add", "origin", "https://example.invalid/acme/demo.git");
    const res = await provider(dir).openPullRequest(
      { title: "t", branch: "feat/demo", base: "main" },
      { yes: true },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/recognized forge/i);
  });

  it("openPullRequest refuses when the forge CLI is unavailable (nothing pushed)", async () => {
    const dir = await makeRepo();
    await git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
    const p = new GitRepoProvider({
      cwd: dir,
      policy: PERMIT,
      timeoutMs: 30000,
      detectCli: () => ({ available: false }),
    });
    const res = await p.openPullRequest(
      { title: "t", branch: "feat/demo", base: "main" },
      { yes: true },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/'gh' CLI/);
  });

  it("health reports the degradation story against a real repo", async () => {
    const dir = await makeRepo();
    const h = await provider(dir).health();
    // No remote configured → degraded with openPullRequest guidance.
    expect(h.state).toBe("degraded");
    expect(h.detail).toMatch(/remote 'origin'/);
  });
});
