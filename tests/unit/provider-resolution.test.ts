/**
 * Provider resolution report + strict providers.
 *
 * `selectProviders` must hand back a requested→resolved receipt for every slot
 * it wires (or suppresses), the runner must print it as a one-line table, and
 * `--strict-providers` / `policies.strict_providers` must turn any SILENT
 * fallback (snowflake→mock, jira→mock) into a hard exit-1 failure with a
 * remediation hint — while explicit suppression (--local-only, --warehouse
 * none) stays tolerated. Deterministic: temp dirs, no network, no live LLM.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  selectProviders,
  renderProviderResolution,
  type ProviderResolutionEntry,
} from "../../src/cli/commands/_providers.js";
import { runTentacleCommand } from "../../src/cli/commands/_run.js";
import { MockWarehouseProvider } from "../../src/tools/providers/mock/index.js";
import { SnowflakeWarehouseProvider } from "../../src/tools/snowflake/index.js";
import { parseConfig } from "../../src/core/config/index.js";
import { createLogger, type Logger } from "../../src/core/logging/index.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-providers-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const TICKET = `# Build a daily active customers model

## Requirements
- Produce a dbt model fct_daily_active_customers
- Grain: one row per customer per day

## Acceptance criteria
- [ ] Model builds cleanly in the sandbox
`;

/** A logger that records every line for assertions. */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  });
  return { logger, lines };
}

/** A genuine snowflake→mock fallback entry, produced by the real wiring path. */
function snowflakeFallback(): ProviderResolutionEntry[] {
  const { resolution } = selectProviders({ cwd: "/tmp", warehouse: "snowflake" });
  return resolution;
}

describe("selectProviders: resolution report", () => {
  it("reports mock slots as requested=resolved with no fallback", () => {
    const { providers, resolution } = selectProviders({
      cwd: "/tmp",
      ticket: true,
      warehouse: "mock",
      repo: true,
      document: true,
    });
    expect(providers.ticket).toBeDefined();
    expect(providers.warehouse).toBeDefined();
    expect(resolution).toHaveLength(4);
    expect(resolution.every((e) => e.fallback === false)).toBe(true);
    expect(resolution.every((e) => e.requested === e.resolved)).toBe(true);
    expect(resolution.map((e) => e.slot)).toEqual(["ticket", "warehouse", "repo", "document"]);
  });

  it("warehouse snowflake without a connection falls back to mock with remediation", () => {
    const { providers, resolution } = selectProviders({ cwd: "/tmp", warehouse: "snowflake" });
    expect(providers.warehouse).toBeInstanceOf(MockWarehouseProvider);
    const entry = resolution.find((e) => e.slot === "warehouse")!;
    expect(entry.requested).toBe("snowflake");
    expect(entry.resolved).toBe("mock");
    expect(entry.fallback).toBe(true);
    expect(entry.reason).toMatch(/connection/);
    expect(entry.remediation).toMatch(/warehouse\.connection|--connection/);
    expect(entry.remediation).toMatch(/--warehouse mock/);
  });

  it("warehouse snowflake with a connection but no snow CLI falls back to mock", () => {
    const { providers, resolution } = selectProviders({
      cwd: "/tmp",
      warehouse: "snowflake",
      snowflake: { connection: "analytics", command: "oswald-test-no-such-snow-cli" },
    });
    expect(providers.warehouse).toBeInstanceOf(MockWarehouseProvider);
    const entry = resolution.find((e) => e.slot === "warehouse")!;
    expect(entry.fallback).toBe(true);
    expect(entry.reason).toMatch(/not found on PATH/);
    expect(entry.remediation).toMatch(/Snowflake CLI/);
  });

  it("warehouse snowflake resolves for real when the CLI is detected and a connection is set", () => {
    const { providers, resolution } = selectProviders({
      cwd: "/tmp",
      warehouse: "snowflake",
      snowflake: { connection: "analytics", command: process.execPath },
    });
    expect(providers.warehouse).toBeInstanceOf(SnowflakeWarehouseProvider);
    const entry = resolution.find((e) => e.slot === "warehouse")!;
    expect(entry.requested).toBe("snowflake");
    expect(entry.resolved).toBe("snowflake");
    expect(entry.fallback).toBe(false);
  });

  it("a named non-mock ticket provider is reported as a fallback to mock", () => {
    const { resolution } = selectProviders({ cwd: "/tmp", ticket: true, ticketProvider: "jira" });
    const entry = resolution.find((e) => e.slot === "ticket")!;
    expect(entry.requested).toBe("jira");
    expect(entry.resolved).toBe("mock");
    expect(entry.fallback).toBe(true);
    expect(entry.remediation).toMatch(/--provider mock/);
  });

  it("local-only suppression is recorded but is NOT a fallback", () => {
    const { providers, resolution } = selectProviders({
      cwd: "/tmp",
      localOnly: true,
      ticket: true,
      warehouse: "snowflake",
      repo: true,
    });
    expect(providers.ticket).toBeUndefined();
    expect(providers.warehouse).toBeUndefined();
    expect(resolution).toHaveLength(3);
    expect(resolution.every((e) => e.resolved === "none")).toBe(true);
    expect(resolution.every((e) => e.fallback === false)).toBe(true);
    expect(resolution.every((e) => e.reason?.includes("--local-only"))).toBe(true);
  });

  it("warehouse none resolves to none without fallback", () => {
    const { providers, resolution } = selectProviders({ cwd: "/tmp", warehouse: "none" });
    expect(providers.warehouse).toBeUndefined();
    expect(resolution).toEqual([
      { slot: "warehouse", requested: "none", resolved: "none", fallback: false },
    ]);
  });
});

describe("renderProviderResolution", () => {
  it("renders an empty report as none", () => {
    expect(renderProviderResolution([])).toBe("none");
  });

  it("renders clean resolutions as slot: name", () => {
    const { resolution } = selectProviders({ cwd: "/tmp", ticket: true, repo: true });
    expect(renderProviderResolution(resolution)).toBe("ticket: mock; repo: mock");
  });

  it("uppercases the fallback target and includes the reason", () => {
    const line = renderProviderResolution(snowflakeFallback());
    expect(line).toContain("warehouse: snowflake→MOCK");
    expect(line).toMatch(/\(.*connection.*\)/);
  });

  it("renders suppressions with an arrow but without uppercasing", () => {
    const { resolution } = selectProviders({ cwd: "/tmp", localOnly: true, ticket: true });
    expect(renderProviderResolution(resolution)).toBe(
      "ticket: mock→none (suppressed by --local-only)",
    );
  });
});

describe("strict providers via runTentacleCommand", () => {
  async function runIntake(
    root: string,
    extra: {
      providerResolution?: ProviderResolutionEntry[];
      strictProviders?: boolean;
      logger: Logger;
    },
  ): Promise<{ exitCode: number; artifactsWritten: string[] }> {
    const fixture = path.join(root, "ticket.md");
    await fs.writeFile(fixture, TICKET, "utf8");
    return runTentacleCommand({
      id: "intake",
      command: "intake",
      cwd: root,
      ticketId: "STRICT-1",
      options: { fromFile: fixture },
      initStateIfMissing: true,
      ...extra,
    });
  }

  it("default behavior tolerates a fallback and prints the resolution table", async () => {
    const root = await makeTmpDir();
    const { logger, lines } = captureLogger();
    const outcome = await runIntake(root, {
      providerResolution: snowflakeFallback(),
      logger,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.artifactsWritten.length).toBeGreaterThan(0);
    const providersLine = lines.find((l) => l.includes("providers:"))!;
    expect(providersLine).toContain("warehouse: snowflake→MOCK");
  });

  it("prints providers: none when a command wires no providers", async () => {
    const root = await makeTmpDir();
    const { logger, lines } = captureLogger();
    const outcome = await runIntake(root, { logger });
    expect(outcome.exitCode).toBe(0);
    expect(lines.some((l) => l.includes("providers: none"))).toBe(true);
  });

  it("--strict-providers turns a fallback into exit 1 with remediation and writes nothing", async () => {
    const root = await makeTmpDir();
    const { logger, lines } = captureLogger();
    const outcome = await runIntake(root, {
      providerResolution: snowflakeFallback(),
      strictProviders: true,
      logger,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.artifactsWritten).toEqual([]);
    expect(lines.some((l) => l.includes("strict providers"))).toBe(true);
    expect(lines.some((l) => l.includes("Fix:"))).toBe(true);
    expect(lines.some((l) => l.includes("--warehouse mock"))).toBe(true);
    await expect(fs.access(path.join(root, ".oswald", "state.yml"))).rejects.toBeTruthy();
  });

  it("policies.strict_providers in oswald.yml enforces strictness without the flag", async () => {
    const root = await makeTmpDir();
    await fs.writeFile(
      path.join(root, "oswald.yml"),
      "project:\n  name: strict-test\npolicies:\n  strict_providers: true\n",
      "utf8",
    );
    const { logger } = captureLogger();
    const outcome = await runIntake(root, {
      providerResolution: snowflakeFallback(),
      logger,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.artifactsWritten).toEqual([]);
  });

  it("strict providers lets a clean resolution run", async () => {
    const root = await makeTmpDir();
    const { logger, lines } = captureLogger();
    const { resolution } = selectProviders({ cwd: root, ticket: true });
    const outcome = await runIntake(root, {
      providerResolution: resolution,
      strictProviders: true,
      logger,
    });
    expect(outcome.exitCode).toBe(0);
    expect(lines.some((l) => l.includes("providers: ticket: mock"))).toBe(true);
  });

  it("strict providers tolerates explicit --local-only suppression", async () => {
    const root = await makeTmpDir();
    const { logger } = captureLogger();
    const { resolution } = selectProviders({ cwd: root, localOnly: true, ticket: true });
    const outcome = await runIntake(root, {
      providerResolution: resolution,
      strictProviders: true,
      logger,
    });
    expect(outcome.exitCode).toBe(0);
  });
});

describe("config: policies.strict_providers", () => {
  it("defaults to false so fallbacks stay loud-but-tolerated", () => {
    const config = parseConfig({ project: { name: "demo" } });
    expect(config.policies.strict_providers).toBe(false);
  });

  it("parses an explicit true", () => {
    const config = parseConfig({
      project: { name: "demo" },
      policies: { strict_providers: true },
    });
    expect(config.policies.strict_providers).toBe(true);
  });
});
