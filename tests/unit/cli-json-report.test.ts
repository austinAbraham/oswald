/**
 * Unit tests for the CI/headless `--json` step-report mode of the shared
 * CLI runner (src/cli/commands/_run.ts).
 *
 * Contract under test:
 *   - exactly ONE valid JSON document per step on stdout; human block suppressed
 *   - the document shape is stable (schema id + fixed snake_case keys)
 *   - it is valid on EVERY outcome: success, blocked (exit 2), hard error (exit 1)
 *   - approval decisions are reported with action class + allow/deny + consent source
 *   - default (human) output mode is completely unchanged
 *
 * Deterministic: temp dirs, no network, no live LLM. Logger + stdout sinks are
 * injected so assertions never depend on console formatting.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runTentacleCommand,
  consentSource,
  failureStepReport,
  STEP_REPORT_SCHEMA,
  type StepReport,
} from "../../src/cli/commands/_run.js";
import { buildProgram } from "../../src/cli/index.js";
import { createLogger, type Logger } from "../../src/core/logging/index.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-json-"));
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

## Background
Finance needs a daily report of active customers sourced from Salesforce and Stripe.

## Requirements
- Produce a dbt model fct_daily_active_customers
- Grain: one row per customer per day
- Read from salesforce.accounts and stripe.charges

## Acceptance criteria
- [ ] Model builds cleanly in the sandbox
- [ ] Row count matches the legacy report within 1%
`;

/** The stable, ordered key set of a step report — the machine contract. */
const STEP_REPORT_KEYS = [
  "schema",
  "ok",
  "command",
  "ticket",
  "exit_code",
  "phase_before",
  "phase_after",
  "blocked",
  "blockers",
  "summary",
  "warnings",
  "open_questions_count",
  "artifacts",
  "approvals",
  "next_command",
  "error",
];

/** A logger that records stdout and stderr lines separately for assertions. */
function captureLogger(): { logger: Logger; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const logger = createLogger({
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { logger, out, err };
}

/** Run intake on a fixture so downstream commands have state + artifacts. */
async function seedIntake(root: string, ticketId: string): Promise<void> {
  const fixture = path.join(root, "ticket.md");
  await fs.writeFile(fixture, TICKET, "utf8");
  const { logger } = captureLogger();
  await runTentacleCommand({
    id: "intake",
    command: "intake",
    cwd: root,
    ticketId,
    options: { fromFile: fixture },
    initStateIfMissing: true,
    logger,
  });
}

describe("consentSource", () => {
  it("--draft always wins, even alongside consent flags", () => {
    expect(consentSource({ draft: true, yes: true })).toBe("--draft");
    expect(consentSource({ draft: true, open: true })).toBe("--draft");
  });

  it("names the flag that granted consent", () => {
    expect(consentSource({ yes: true })).toBe("--yes");
    expect(consentSource({ post: true })).toBe("--post");
    expect(consentSource({ open: true })).toBe("--open");
    expect(consentSource({ apply: true })).toBe("--apply");
  });

  it("is 'none' when no flags decided anything", () => {
    expect(consentSource(undefined)).toBe("none");
    expect(consentSource({})).toBe("none");
    expect(consentSource({ yes: false })).toBe("none");
  });
});

describe("--json step report: happy path", () => {
  it("emits exactly one valid JSON document on stdout and suppresses the human block", async () => {
    const root = await makeTmpDir();
    const fixture = path.join(root, "ticket.md");
    await fs.writeFile(fixture, TICKET, "utf8");
    const { logger, out } = captureLogger();
    const stdoutLines: string[] = [];

    const outcome = await runTentacleCommand({
      id: "intake",
      command: "intake",
      cwd: root,
      ticketId: "CI-1",
      options: { fromFile: fixture },
      initStateIfMissing: true,
      logger,
      json: true,
      stdout: (l) => stdoutLines.push(l),
    });

    expect(outcome.exitCode).toBe(0);
    expect(stdoutLines).toHaveLength(1);

    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    expect(report.schema).toBe(STEP_REPORT_SCHEMA);
    expect(report.ok).toBe(true);
    expect(report.command).toBe("intake");
    expect(report.ticket).toBe("CI-1");
    expect(report.exit_code).toBe(0);
    expect(report.phase_before).toBe("uninitialized");
    expect(report.phase_after).toBe("clarification");
    expect(report.blocked).toBe(false);
    expect(report.blockers).toEqual([]);
    expect(report.next_command).toBe("clarify");
    expect(report.error).toBeNull();
    expect(typeof report.summary).toBe("string");
    expect(report.open_questions_count).toBeGreaterThanOrEqual(0);

    // Artifacts are project-root-relative — never absolute user paths.
    expect(report.artifacts.length).toBeGreaterThan(0);
    for (const a of report.artifacts) {
      expect(path.isAbsolute(a)).toBe(false);
    }

    // The human-formatted block is fully suppressed on stdout.
    expect(out).toEqual([]);

    // The machine contract: exact keys, fixed order.
    expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);
  });

  it("default human mode is unchanged: no JSON on stdout, standard block printed", async () => {
    const root = await makeTmpDir();
    const fixture = path.join(root, "ticket.md");
    await fs.writeFile(fixture, TICKET, "utf8");
    const { logger, out } = captureLogger();
    const stdoutLines: string[] = [];

    const outcome = await runTentacleCommand({
      id: "intake",
      command: "intake",
      cwd: root,
      ticketId: "CI-2",
      options: { fromFile: fixture },
      initStateIfMissing: true,
      logger,
      stdout: (l) => stdoutLines.push(l),
    });

    expect(outcome.exitCode).toBe(0);
    expect(stdoutLines).toEqual([]);
    expect(out.some((l) => l.includes("intake:"))).toBe(true);
    expect(out.some((l) => l.includes("next:"))).toBe(true);
    // The report is still built for programmatic callers.
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.exit_code).toBe(0);
  });
});

describe("--json step report: blocked (exit 2)", () => {
  it("serializes a blocked run as ok:false / exit_code 2 with blockers", async () => {
    const root = await makeTmpDir();
    await seedIntake(root, "CI-3");
    const { logger } = captureLogger();
    const stdoutLines: string[] = [];

    const outcome = await runTentacleCommand({
      id: "validate",
      command: "validate",
      cwd: root,
      ticketId: "CI-3",
      options: { skipExternal: true },
      logger,
      json: true,
      stdout: (l) => stdoutLines.push(l),
    });

    expect(outcome.exitCode).toBe(2);
    expect(stdoutLines).toHaveLength(1);
    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    expect(report.ok).toBe(false);
    expect(report.exit_code).toBe(2);
    expect(report.blocked).toBe(true);
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(report.phase_after).toBe("blocked");
    expect(report.error).toBeNull();
    // Blocked is NOT a crash: artifacts were still written.
    expect(report.artifacts.length).toBeGreaterThan(0);
    expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);
  });
});

describe("--json step report: hard errors (exit 1)", () => {
  it("emits a valid ok:false document for an unknown tentacle id", async () => {
    const root = await makeTmpDir();
    const { logger, err } = captureLogger();
    const stdoutLines: string[] = [];

    const outcome = await runTentacleCommand({
      id: "does-not-exist",
      command: "nope",
      cwd: root,
      logger,
      json: true,
      stdout: (l) => stdoutLines.push(l),
    });

    expect(outcome.exitCode).toBe(1);
    expect(stdoutLines).toHaveLength(1);
    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    expect(report.ok).toBe(false);
    expect(report.exit_code).toBe(1);
    expect(report.error).toMatch(/No tentacle registered/);
    expect(report.blocked).toBe(false);
    expect(report.artifacts).toEqual([]);
    expect(report.approvals).toEqual([]);
    expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);
    // Diagnostics still land on stderr, keeping stdout parseable.
    expect(err.some((l) => l.includes("No tentacle registered"))).toBe(true);
  });

  it("emits a valid ok:false document when the tentacle throws (no state)", async () => {
    const root = await makeTmpDir();
    const { logger } = captureLogger();
    const stdoutLines: string[] = [];

    // clarify without any seeded state → buildContext throws a StateError.
    const outcome = await runTentacleCommand({
      id: "clarification",
      command: "clarify",
      cwd: root,
      ticketId: "CI-4",
      logger,
      json: true,
      stdout: (l) => stdoutLines.push(l),
    });

    expect(outcome.exitCode).toBe(1);
    expect(stdoutLines).toHaveLength(1);
    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    expect(report.ok).toBe(false);
    expect(report.exit_code).toBe(1);
    expect(report.error).not.toBeNull();
    expect(report.phase_after).toBeNull();
    expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);
  });
});

describe("--json step report: approval decisions", () => {
  it("reports denied decisions with consent_source --draft (draft always wins)", async () => {
    const root = await makeTmpDir();
    await seedIntake(root, "CI-5");
    const { logger } = captureLogger();
    const stdoutLines: string[] = [];

    const outcome = await runTentacleCommand({
      id: "delivery",
      command: "pr",
      cwd: root,
      ticketId: "CI-5",
      options: { decisionNote: "pr CLI" },
      approval: { draft: true, open: true }, // --draft forces draft-only
      logger,
      json: true,
      stdout: (l) => stdoutLines.push(l),
    });

    expect(outcome.exitCode).toBe(0);
    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    expect(report.approvals.length).toBeGreaterThan(0);
    for (const a of report.approvals) {
      expect(a.allowed).toBe(false);
      expect(a.decision).toBe("denied");
      expect(a.consent_source).toBe("--draft");
    }
    const actions = report.approvals.map((a) => a.action);
    expect(actions).toContain("open_pull_request");
    expect(actions).toContain("ticket_update");
  });

  it("reports allowed decisions with consent_source --open when consent is granted", async () => {
    const root = await makeTmpDir();
    await seedIntake(root, "CI-6");
    const { logger } = captureLogger();
    const stdoutLines: string[] = [];

    await runTentacleCommand({
      id: "delivery",
      command: "pr",
      cwd: root,
      ticketId: "CI-6",
      options: { decisionNote: "pr CLI" },
      approval: { open: true },
      logger,
      json: true,
      stdout: (l) => stdoutLines.push(l),
    });

    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    const pr = report.approvals.find((a) => a.action === "open_pull_request");
    expect(pr).toBeDefined();
    expect(pr!.allowed).toBe(true);
    expect(pr!.decision).toBe("allowed");
    expect(pr!.consent_source).toBe("--open");
  });
});

describe("failureStepReport helper", () => {
  it("builds a valid ok:false document with the stable key set", () => {
    const report = failureStepReport({
      command: "eda",
      ticket: "CI-7",
      exitCode: 2,
      error: "boom",
    });
    expect(report.schema).toBe(STEP_REPORT_SCHEMA);
    expect(report.ok).toBe(false);
    expect(report.exit_code).toBe(2);
    expect(report.ticket).toBe("CI-7");
    expect(report.error).toBe("boom");
    expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  });

  it("defaults ticket to null", () => {
    const report = failureStepReport({ command: "x", exitCode: 1, error: "e" });
    expect(report.ticket).toBeNull();
  });
});

describe("build --json (via the program)", () => {
  // `build` is the one pipeline command that does not route through the shared
  // runner, so its step report is assembled in build.ts — same contract.
  const PLAN = `# Implementation Plan

Build \`fct_daily_active_customers\` at grain one row per customer per day,
staged from \`stg_stripe_charges\`.
`;

  /** Run `oswald build <args>` through the real program, capturing stdout. */
  async function runBuildProgram(
    root: string,
    args: string[],
  ): Promise<{ stdoutLines: string[]; exitCode: number | undefined }> {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prevExitCode = process.exitCode;
    try {
      const program = buildProgram();
      program.exitOverride();
      await program.parseAsync(["node", "oswald", "build", ...args, "--cwd", root]);
      return {
        stdoutLines: logSpy.mock.calls.map((c) => String(c[0])),
        exitCode: process.exitCode as number | undefined,
      };
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  }

  async function seedPlan(root: string): Promise<void> {
    await fs.mkdir(path.join(root, ".oswald"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".oswald", "implementation_plan.md"),
      PLAN,
      "utf8",
    );
  }

  it("emits exactly one valid JSON document on stdout for a dry-run build", async () => {
    const root = await makeTmpDir();
    await seedIntake(root, "CI-9");
    await seedPlan(root);

    const { stdoutLines, exitCode } = await runBuildProgram(root, [
      "CI-9",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    // Machine output: ONE JSON document on stdout and nothing else.
    expect(stdoutLines).toHaveLength(1);
    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    expect(report.schema).toBe(STEP_REPORT_SCHEMA);
    expect(report.ok).toBe(true);
    expect(report.command).toBe("build");
    expect(report.ticket).toBe("CI-9");
    expect(report.exit_code).toBe(0);
    expect(report.phase_before).toBe("clarification");
    expect(report.phase_after).toBe("validating");
    expect(report.blocked).toBe(false);
    expect(report.summary).toMatch(/dry-run/);
    expect(report.next_command).toBe("validate");
    expect(report.error).toBeNull();
    expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);

    // Artifacts are project-root-relative — never absolute user paths.
    expect(report.artifacts.some((a) => a.endsWith("build_preview.md"))).toBe(true);
    expect(report.artifacts.some((a) => a.endsWith("changed_files.json"))).toBe(true);
    for (const a of report.artifacts) {
      expect(path.isAbsolute(a)).toBe(false);
    }

    // The "commit"-class gate was consulted and default-denied (no --yes).
    const commit = report.approvals.find((a) => a.action === "commit");
    expect(commit).toBeDefined();
    expect(commit!.allowed).toBe(false);
    expect(commit!.decision).toBe("denied");
    expect(commit!.consent_source).toBe("none");
  });

  it("emits a valid ok:false document when the implementation plan is missing", async () => {
    const root = await makeTmpDir();
    await seedIntake(root, "CI-10"); // state exists, but no plan artifact

    const { stdoutLines, exitCode } = await runBuildProgram(root, [
      "CI-10",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    expect(stdoutLines).toHaveLength(1);
    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    expect(report.ok).toBe(false);
    expect(report.exit_code).toBe(1);
    expect(report.command).toBe("build");
    expect(report.error).toMatch(/implementation_plan/);
    expect(report.phase_before).toBe("clarification");
    expect(report.artifacts).toEqual([]);
    expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);
  });

  it("emits a valid ok:false document when state is missing (hard error)", async () => {
    const root = await makeTmpDir(); // no state.yml → buildContext throws

    const { stdoutLines, exitCode } = await runBuildProgram(root, [
      "CI-11",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    expect(stdoutLines).toHaveLength(1);
    const report = JSON.parse(stdoutLines[0]!) as StepReport;
    expect(report.ok).toBe(false);
    expect(report.exit_code).toBe(1);
    expect(report.error).not.toBeNull();
    expect(report.phase_before).toBeNull();
    expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);
  });

  it("default human mode is unchanged: no JSON on stdout, standard block printed", async () => {
    const root = await makeTmpDir();
    await seedIntake(root, "CI-12");
    await seedPlan(root);

    const { stdoutLines, exitCode } = await runBuildProgram(root, ["CI-12"]);

    expect(exitCode).toBe(0);
    expect(stdoutLines.filter((l) => l.startsWith("{"))).toEqual([]);
    expect(stdoutLines.some((l) => l.includes("build (dry-run):"))).toBe(true);
    expect(stdoutLines.some((l) => l.includes("next:  oswald validate"))).toBe(true);
  });
});

describe("eda --json precondition refusal (via the program)", () => {
  it("still emits one valid JSON failure document when --execute lacks a connection", async () => {
    const root = await makeTmpDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prevExitCode = process.exitCode;
    try {
      const program = buildProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "oswald", "eda", "CI-8",
        "--warehouse", "snowflake", "--execute", "--json",
        "--cwd", root,
      ]);

      expect(process.exitCode).toBe(2);
      const jsonLines = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("{"));
      expect(jsonLines).toHaveLength(1);
      const report = JSON.parse(jsonLines[0]!) as StepReport;
      expect(report.ok).toBe(false);
      expect(report.exit_code).toBe(2);
      expect(report.command).toBe("eda");
      expect(report.ticket).toBe("CI-8");
      expect(report.error).toMatch(/requires a connection/);
      expect(Object.keys(report)).toEqual(STEP_REPORT_KEYS);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });
});
