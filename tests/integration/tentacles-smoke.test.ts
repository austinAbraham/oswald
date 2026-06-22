/**
 * End-to-end integration smoke test for the wired tentacle registry.
 *
 * Proves that:
 *   1. The registry registers all eight tentacles by id.
 *   2. Intake (the entry tentacle) runs on a markdown fixture and writes
 *      artifacts under `.oswald/`.
 *   3. A downstream tentacle (clarification) reads intake's artifacts and runs,
 *      writing its own artifacts under `.oswald/` and advancing state.
 *
 * Deterministic: temp dir, injected fixed clock, no network, no live LLM.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildContext,
  TENTACLE_REGISTRY,
  getTentacle,
  tentacleIds,
  allTentacles,
} from "../../src/tentacles/index.js";
import { parseConfig } from "../../src/core/config/index.js";
import { readState } from "../../src/core/state/index.js";
import { fixedClock } from "../../src/utils/time.js";

const CLOCK = fixedClock("2026-06-22T00:00:00.000Z");
const tmpDirs: string[] = [];

const EXPECTED_IDS = [
  "intake",
  "clarification",
  "context",
  "eda",
  "design",
  "planning",
  "validate",
  "delivery",
];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-smoke-"));
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
Requested by: @jane.doe and the RevOps team.

## Requirements
- Produce a dbt model fct_daily_active_customers
- Grain: one row per customer per day
- Read from salesforce.accounts and stripe.charges

## Acceptance criteria
- [ ] Model builds cleanly in the sandbox
- [ ] Row count matches the legacy report within 1%

## Due date
- by 2026-07-15
`;

function cfg() {
  return parseConfig({ project: { name: "smoke" } });
}

async function listArtifacts(root: string): Promise<string[]> {
  const dir = path.join(root, ".oswald");
  const entries = await fs.readdir(dir);
  return entries.sort();
}

describe("tentacle registry: integration smoke", () => {
  it("registers all eight tentacles by their canonical ids", () => {
    expect(tentacleIds()).toEqual([...EXPECTED_IDS].sort());
    expect(allTentacles()).toHaveLength(8);
    for (const id of EXPECTED_IDS) {
      const t = getTentacle(id);
      expect(t, `tentacle "${id}" should be registered`).toBeDefined();
      // The registry key must match the tentacle's own id.
      expect(t!.id).toBe(id);
      expect(TENTACLE_REGISTRY[id]).toBe(t);
    }
  });

  it("runs intake then a downstream tentacle, writing artifacts under .oswald/", async () => {
    const root = await makeTmpDir();
    const fixture = path.join(root, "ticket.md");
    await fs.writeFile(fixture, TICKET, "utf8");

    // --- Stage 1: intake, from the markdown fixture. -----------------------
    const intake = getTentacle("intake")!;
    const intakeCtx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "SMOKE-1",
      options: { fromFile: fixture },
      initStateIfMissing: true,
    });
    const intakeResult = await intake.run(intakeCtx);

    expect(intakeResult.artifactsWritten.length).toBeGreaterThan(0);
    for (const p of intakeResult.artifactsWritten) {
      expect(path.isAbsolute(p)).toBe(true);
      await expect(fs.access(p)).resolves.toBeUndefined();
    }

    const afterIntake = await listArtifacts(root);
    expect(afterIntake).toContain("state.yml");
    // Intake produced more than just the state file.
    expect(afterIntake.length).toBeGreaterThan(1);

    // Intake advances state to the next pipeline phase (clarification).
    const stateAfterIntake = await readState(root);
    expect(stateAfterIntake.status.phase).toBe("clarification");

    // --- Stage 2: a downstream tentacle reads intake's artifacts. ----------
    const clarification = getTentacle("clarification")!;
    const clarifyCtx = await buildContext({
      projectRoot: root,
      config: cfg(),
      clock: CLOCK,
      ticketId: "SMOKE-1",
    });
    const clarifyResult = await clarification.run(clarifyCtx);

    expect(clarifyResult.artifactsWritten.length).toBeGreaterThan(0);
    for (const p of clarifyResult.artifactsWritten) {
      expect(path.isAbsolute(p)).toBe(true);
      await expect(fs.access(p)).resolves.toBeUndefined();
    }

    const afterClarify = await listArtifacts(root);
    // Clarification added at least one new artifact beyond intake's set.
    expect(afterClarify.length).toBeGreaterThan(afterIntake.length);

    // Clarification advances state to the next pipeline phase (context).
    const stateAfterClarify = await readState(root);
    expect(stateAfterClarify.status.phase).toBe("context");
  });
});
