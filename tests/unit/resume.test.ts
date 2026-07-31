/**
 * Unit tests for `oswald resume` — first-class recovery from `blocked`.
 *
 * Covers the four pillars of the feature:
 *   1. `advanceWorkflow` bookkeeping of `status.blocked_from` (recorded on
 *      entering blocked, preserved on re-block, cleared on leaving) and of
 *      `status.blocked_mode` (the blocking run's fidelity: recorded, never
 *      downgraded external → local, cleared on leaving).
 *   2. `runResume`: the no-op path, the pass path (unblocks + reports next),
 *      the still-failing path (stays blocked, exit 2), the legal restore of
 *      `blocked_from`, and the never-regress guard.
 *   3. The fidelity guard: a block produced by a REAL external run refuses a
 *      local-only resume (exit 2, nothing re-run) and only clears at external
 *      fidelity; the shared runner's hint carries `--dbt` for such blocks.
 *   4. The shared runner's blocked hint now points at `oswald resume`.
 *
 * Deterministic: temp dirs, captured loggers, no network, no live LLM, and no
 * real subprocess anywhere — "external" runs use an injected stub runner.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runResume } from "../../src/cli/commands/resume.js";
import { runTentacleCommand } from "../../src/cli/commands/_run.js";
import { buildContext, advanceWorkflow } from "../../src/tentacles/base.js";
import { parseConfig } from "../../src/core/config/index.js";
import {
  createInitialState,
  writeState,
  readState,
  updateState,
} from "../../src/core/state/index.js";
import { createLogger, type Logger } from "../../src/core/logging/index.js";
import { fixedClock, systemClock } from "../../src/utils/time.js";
import type {
  CommandRunner,
  CommandSpec,
} from "../../src/tentacles/validation/expectations.js";

const CLOCK = fixedClock("2026-06-22T00:00:00.000Z");
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-resume-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A logger that records every line for assertions. */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  });
  return { logger, lines };
}

async function seedState(root: string, ticketId = "RES-1"): Promise<void> {
  const state = createInitialState({
    projectName: "resume-test",
    projectRoot: root,
    clock: systemClock,
    ticket: { id: ticketId, provider: null, url: null },
  });
  await fs.mkdir(path.join(root, ".oswald"), { recursive: true });
  await writeState(state, ".oswald");
}

/**
 * Acceptance criteria whose offline classification produces ONLY non-blocking
 * (deferred, data-shape) checks → the local validate verdict is done → PASS.
 */
const PASSING_CRITERIA = `# Acceptance Criteria

## Acceptance Criteria

1. Grain: one row per customer per day
2. customer_id is unique
`;

/**
 * A `build` criterion cannot be verified offline and is blocking when deferred
 * → the local validate verdict is BLOCKED.
 */
const BLOCKING_CRITERIA = `# Acceptance Criteria

## Acceptance Criteria

1. Model builds cleanly in the sandbox
`;

async function writeCriteria(root: string, content: string): Promise<void> {
  await fs.mkdir(path.join(root, ".oswald"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".oswald", "acceptance_criteria.md"),
    content,
    "utf8",
  );
}

/** Drive the real validate tentacle until the workflow parks in blocked. */
async function blockViaValidate(
  root: string,
  ticketId: string,
  logger: Logger,
): Promise<void> {
  const outcome = await runTentacleCommand({
    id: "validate",
    command: "validate",
    cwd: root,
    ticketId,
    options: { skipExternal: true },
    logger,
  });
  expect(outcome.exitCode).toBe(2);
}

/**
 * A stub command runner (no subprocess is ever spawned) that fails or passes
 * every check — used to produce a REAL external block/pass deterministically.
 */
function stubRunner(exitCode: number): CommandRunner {
  return async (spec: CommandSpec) => ({
    name: spec.name,
    command: spec.command,
    exitCode,
    stdout: exitCode === 0 ? "1 check passed" : "",
    stderr: exitCode === 0 ? "" : "FAIL: customer_id is not unique",
    errored: false,
  });
}

/**
 * Park the workflow in `blocked` via a REAL external run: the validate
 * tentacle executes an injected validation command that fails. This is the
 * exact scenario the fidelity guard protects — the offline classifier alone
 * would have marked the data-shape criteria skipped AND non-blocking.
 */
async function blockViaExternalValidate(
  root: string,
  ticketId: string,
  logger: Logger,
): Promise<void> {
  const outcome = await runTentacleCommand({
    id: "validate",
    command: "validate",
    cwd: root,
    ticketId,
    options: {
      skipExternal: false,
      validationCommands: ["run-data-checks --strict"],
      commandRunner: stubRunner(1),
    },
    logger,
  });
  expect(outcome.exitCode).toBe(2);
}

// ---------------------------------------------------------------------------
// advanceWorkflow: blocked_from bookkeeping
// ---------------------------------------------------------------------------

describe("advanceWorkflow: blocked_from bookkeeping", () => {
  function testConfig() {
    return parseConfig({ project: { name: "demo" } });
  }

  it("records the origin phase when entering blocked", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });

    await advanceWorkflow(ctx, { phase: "validating", lastCommand: "build" });
    const blocked = await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockers: ["Builds cleanly — not verified"],
    });

    expect(blocked.status.phase).toBe("blocked");
    expect(blocked.status.blocked_from).toBe("validating");
    expect(blocked.status.next_recommended_command).toBe("resume");
  });

  it("preserves the original origin when re-blocking while already blocked", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });

    await advanceWorkflow(ctx, { phase: "validating", lastCommand: "build" });
    await advanceWorkflow(ctx, { phase: "blocked", lastCommand: "validate" });
    const reblocked = await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
    });

    expect(reblocked.status.blocked_from).toBe("validating");
  });

  it("clears blocked_from when leaving blocked", async () => {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });

    await advanceWorkflow(ctx, { phase: "validating", lastCommand: "build" });
    await advanceWorkflow(ctx, { phase: "blocked", lastCommand: "validate" });
    const resumed = await advanceWorkflow(ctx, {
      phase: "ready_for_pr",
      lastCommand: "validate",
      blockers: [],
    });

    expect(resumed.status.blocked_from).toBeUndefined();
    const onDisk = await readState(root);
    expect(onDisk.status.blocked_from).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// advanceWorkflow: blocked_mode fidelity bookkeeping
// ---------------------------------------------------------------------------

describe("advanceWorkflow: blocked_mode fidelity bookkeeping", () => {
  function testConfig() {
    return parseConfig({ project: { name: "demo" } });
  }

  async function blockedContext() {
    const root = await makeTmpDir();
    const ctx = await buildContext({
      projectRoot: root,
      config: testConfig(),
      clock: CLOCK,
      initStateIfMissing: true,
    });
    await advanceWorkflow(ctx, { phase: "validating", lastCommand: "build" });
    return { root, ctx };
  }

  it("records the fidelity of the run that blocked", async () => {
    const { ctx } = await blockedContext();
    const blocked = await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockedMode: "external",
    });
    expect(blocked.status.blocked_mode).toBe("external");
  });

  it("never downgrades an external block to local while blocked", async () => {
    const { ctx } = await blockedContext();
    await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockedMode: "external",
    });
    const reblocked = await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockedMode: "local",
    });
    expect(reblocked.status.blocked_mode).toBe("external");
  });

  it("upgrades a local block to external on an external re-block", async () => {
    const { ctx } = await blockedContext();
    await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockedMode: "local",
    });
    const reblocked = await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockedMode: "external",
    });
    expect(reblocked.status.blocked_mode).toBe("external");
  });

  it("preserves the recorded fidelity when a re-block omits it (delivery-style)", async () => {
    const { ctx } = await blockedContext();
    await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockedMode: "external",
    });
    const reblocked = await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "delivery",
    });
    expect(reblocked.status.blocked_mode).toBe("external");
  });

  it("clears blocked_mode when leaving blocked", async () => {
    const { root, ctx } = await blockedContext();
    await advanceWorkflow(ctx, {
      phase: "blocked",
      lastCommand: "validate",
      blockedMode: "external",
    });
    const resumed = await advanceWorkflow(ctx, {
      phase: "ready_for_pr",
      lastCommand: "validate",
      blockers: [],
    });
    expect(resumed.status.blocked_mode).toBeUndefined();
    const onDisk = await readState(root);
    expect(onDisk.status.blocked_mode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runResume
// ---------------------------------------------------------------------------

describe("runResume", () => {
  it("returns exit 1 when Oswald is not initialized", async () => {
    const root = await makeTmpDir();
    const { logger, lines } = captureLogger();
    const outcome = await runResume({ cwd: root, ticketId: "RES-0", logger });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.phase).toBeNull();
    expect(lines.some((l) => l.includes("oswald init"))).toBe(true);
  });

  it("is an idempotent no-op when the workflow is not blocked (exit 0)", async () => {
    const root = await makeTmpDir();
    await seedState(root);
    const { logger, lines } = captureLogger();

    const outcome = await runResume({ cwd: root, ticketId: "RES-1", logger });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.phase).toBe("uninitialized");
    expect(lines.some((l) => l.includes("nothing to resume"))).toBe(true);
    // No state mutation happened.
    const state = await readState(root);
    expect(state.status.phase).toBe("uninitialized");
  });

  it("re-runs the blocking check and unblocks when it passes (exit 0)", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-2");
    await writeCriteria(root, BLOCKING_CRITERIA);
    const { logger, lines } = captureLogger();
    await blockViaValidate(root, "RES-2", logger);

    // The blocker is resolved out-of-band (the criterion no longer requires an
    // unverifiable build) — resume's re-run now passes.
    await writeCriteria(root, PASSING_CRITERIA);
    const outcome = await runResume({ cwd: root, ticketId: "RES-2", logger });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.phase).toBe("ready_for_pr");
    const state = await readState(root);
    expect(state.status.phase).toBe("ready_for_pr");
    expect(state.status.blockers).toEqual([]);
    expect(state.status.blocked_from).toBeUndefined();
    expect(state.status.next_recommended_command).toBe("pr");
    expect(lines.some((l) => l.includes("unblocked"))).toBe(true);
    expect(lines.some((l) => l.includes("oswald pr"))).toBe(true);
  });

  it("stays blocked with exit 2 when the check still fails", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-3");
    await writeCriteria(root, BLOCKING_CRITERIA);
    const { logger, lines } = captureLogger();
    await blockViaValidate(root, "RES-3", logger);

    const outcome = await runResume({ cwd: root, ticketId: "RES-3", logger });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.phase).toBe("blocked");
    const state = await readState(root);
    expect(state.status.phase).toBe("blocked");
    expect(state.status.blockers.length).toBeGreaterThan(0);
    // The recovery target survives a failed resume attempt.
    expect(state.status.blocked_from).toBeDefined();
    expect(lines.some((l) => l.includes("stays BLOCKED"))).toBe(true);
  });

  it("restores blocked_from over a legal edge when the re-run lands earlier", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-4");
    await writeCriteria(root, PASSING_CRITERIA);
    // Simulate delivery having blocked at ready_for_ticket_update (a phase
    // AHEAD of where a passing validate lands).
    await updateState(
      root,
      (s) => ({
        ...s,
        status: {
          ...s.status,
          phase: "blocked",
          blocked_from: "ready_for_ticket_update",
          last_command: "delivery",
          next_recommended_command: "resume",
          blockers: ["Validation reported failures — resolve before shipping."],
        },
      }),
      { clock: systemClock },
    );
    const { logger } = captureLogger();

    const outcome = await runResume({
      cwd: root,
      ticketId: "RES-4",
      clock: CLOCK,
      logger,
    });

    // validate lands on ready_for_pr; ready_for_pr → ready_for_ticket_update
    // is the legal linear edge, so the recorded origin is restored.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.phase).toBe("ready_for_ticket_update");
    const state = await readState(root);
    expect(state.status.phase).toBe("ready_for_ticket_update");
    expect(state.status.last_command).toBe("resume");
    expect(state.status.next_recommended_command).toBe("update-ticket");
    expect(state.status.blocked_from).toBeUndefined();
    expect(state.status.blockers).toEqual([]);
  });

  it("never regresses: an unreachable blocked_from is left where the check landed", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-5");
    await writeCriteria(root, PASSING_CRITERIA);
    // The realistic validate case: blocked from `validating`. A passing re-run
    // lands on ready_for_pr; going BACK to validating is not a legal edge.
    await updateState(
      root,
      (s) => ({
        ...s,
        status: {
          ...s.status,
          phase: "blocked",
          blocked_from: "validating",
          last_command: "validate",
          next_recommended_command: "resume",
          blockers: ["Builds cleanly — not verified"],
        },
      }),
      { clock: systemClock },
    );
    const { logger } = captureLogger();

    const outcome = await runResume({ cwd: root, ticketId: "RES-5", logger });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.phase).toBe("ready_for_pr");
    const state = await readState(root);
    expect(state.status.phase).toBe("ready_for_pr");
    expect(state.status.blocked_from).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The fidelity guard: an external block is never cleared by a local re-run
// ---------------------------------------------------------------------------

describe("runResume: fidelity guard (blocked_mode)", () => {
  it("records blocked_mode from the run that blocked (local vs external)", async () => {
    const localRoot = await makeTmpDir();
    await seedState(localRoot, "RES-7");
    await writeCriteria(localRoot, BLOCKING_CRITERIA);
    const { logger } = captureLogger();
    await blockViaValidate(localRoot, "RES-7", logger);
    expect((await readState(localRoot)).status.blocked_mode).toBe("local");

    const externalRoot = await makeTmpDir();
    await seedState(externalRoot, "RES-8");
    await writeCriteria(externalRoot, PASSING_CRITERIA);
    await blockViaExternalValidate(externalRoot, "RES-8", logger);
    expect((await readState(externalRoot)).status.blocked_mode).toBe(
      "external",
    );
  });

  it("refuses to clear a REAL external block with a local-only re-run (exit 2, nothing re-run)", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-9");
    // Data-shape-only criteria: a LOCAL re-run would mark them skipped AND
    // non-blocking, waving the gate through — exactly what the guard forbids.
    await writeCriteria(root, PASSING_CRITERIA);
    const { logger, lines } = captureLogger();
    await blockViaExternalValidate(root, "RES-9", logger);

    // The recommended one-liner without flags must NOT evaporate the block.
    const outcome = await runResume({ cwd: root, ticketId: "RES-9", logger });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.phase).toBe("blocked");
    const state = await readState(root);
    expect(state.status.phase).toBe("blocked");
    expect(state.status.blocked_mode).toBe("external");
    expect(state.status.blocked_from).toBeDefined();
    expect(state.status.blockers.length).toBeGreaterThan(0);
    expect(
      lines.some((l) => l.includes("a local-only re-run cannot clear it")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("oswald resume RES-9 --dbt"))).toBe(
      true,
    );
    // Nothing was re-run: the validation report still carries the REAL
    // verdict (a local rewrite would have flipped it to PASS).
    const report = await fs.readFile(
      path.join(root, ".oswald", "validation_report.md"),
      "utf8",
    );
    expect(report).toContain("BLOCKED");
    expect(report).not.toContain("PASS —");
  });

  it("clears an external block when the re-run happens at external fidelity and passes", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-10");
    await writeCriteria(root, PASSING_CRITERIA);
    const { logger } = captureLogger();
    await blockViaExternalValidate(root, "RES-10", logger);

    // The data issue is fixed out-of-band; the REAL check now passes.
    const outcome = await runResume({
      cwd: root,
      ticketId: "RES-10",
      options: {
        skipExternal: false,
        validationCommands: ["run-data-checks --strict"],
        commandRunner: stubRunner(0),
      },
      logger,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.phase).toBe("ready_for_pr");
    const state = await readState(root);
    expect(state.status.phase).toBe("ready_for_pr");
    expect(state.status.blocked_mode).toBeUndefined();
    expect(state.status.blocked_from).toBeUndefined();
    expect(state.status.blockers).toEqual([]);
  });

  it("still resumes a local block locally (the guard only fires for external blocks)", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-11");
    await writeCriteria(root, BLOCKING_CRITERIA);
    const { logger, lines } = captureLogger();
    await blockViaValidate(root, "RES-11", logger);
    expect((await readState(root)).status.blocked_mode).toBe("local");

    await writeCriteria(root, PASSING_CRITERIA);
    const outcome = await runResume({ cwd: root, ticketId: "RES-11", logger });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.phase).toBe("ready_for_pr");
    expect(
      lines.some((l) => l.includes("a local-only re-run cannot clear it")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The runner's blocked report points at resume
// ---------------------------------------------------------------------------

describe("blocked workflows recommend resume", () => {
  it("the shared runner's blocked hint names 'oswald resume <ticket>'", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-6");
    await writeCriteria(root, BLOCKING_CRITERIA);
    const { logger, lines } = captureLogger();

    await blockViaValidate(root, "RES-6", logger);

    expect(lines.some((l) => l.includes("oswald resume RES-6"))).toBe(true);
    // The persisted recommendation (what `oswald next` reads) is resume too.
    const state = await readState(root);
    expect(state.status.next_recommended_command).toBe("resume");
    expect(state.status.blocked_from).toBeDefined();
  });

  it("the blocked hint appends --dbt when the block came from a REAL external run", async () => {
    const root = await makeTmpDir();
    await seedState(root, "RES-12");
    await writeCriteria(root, PASSING_CRITERIA);
    const { logger, lines } = captureLogger();

    await blockViaExternalValidate(root, "RES-12", logger);

    expect(lines.some((l) => l.includes("oswald resume RES-12 --dbt"))).toBe(
      true,
    );
  });
});
