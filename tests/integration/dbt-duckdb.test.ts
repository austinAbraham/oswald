/**
 * GUARDED integration test: actually run the example dbt project via dbt-duckdb
 * and assert it seeds + builds + tests green, and that the runner parses the
 * real artifacts correctly.
 *
 * This spawns a real subprocess and may download dbt-duckdb on first run, so it
 * is skipped cleanly when no usable dbt invocation is available — `npm test`
 * stays green on machines without dbt/uv. It is also skipped unless explicitly
 * opted-in via OSWALD_RUN_DBT_IT=1 (so CI/dev runs stay fast and offline by
 * default); set that env var to exercise it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runDbt, detectDbtProject } from "../../src/tools/dbt/index.js";
import { buildContext } from "../../src/tentacles/base.js";
import { validationTentacle } from "../../src/tentacles/validation/index.js";
import { parseConfig } from "../../src/core/config/index.js";
import {
  createInitialState,
  writeState,
  readState,
} from "../../src/core/state/index.js";
import { fixedClock } from "../../src/utils/time.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const EXAMPLE_PROJECT = path.join(REPO_ROOT, "examples", "dbt-project");

/** Candidate dbt invocations, most-preferred first. */
const CANDIDATES: string[] = [
  process.env.OSWALD_DBT_COMMAND ?? "",
  "uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt",
  "dbt",
].filter(Boolean);

/** Probe each candidate with `--version`; return the first that works. */
function findWorkingDbt(): string | null {
  for (const inv of CANDIDATES) {
    const parts = inv.split(/\s+/).filter(Boolean);
    const [cmd, ...rest] = parts;
    try {
      const res = spawnSync(cmd!, [...rest, "--version"], {
        encoding: "utf8",
        timeout: 180000,
        env: { ...process.env, DO_NOT_TRACK: "1" },
      });
      if (res.status === 0 && /duckdb/i.test(`${res.stdout}${res.stderr}`)) {
        return inv;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

const OPTED_IN = process.env.OSWALD_RUN_DBT_IT === "1";
const dbtCommand = OPTED_IN ? findWorkingDbt() : null;
const RUN = OPTED_IN && dbtCommand !== null;

(RUN ? describe : describe.skip)("dbt-duckdb integration (real build)", () => {
  beforeAll(async () => {
    // Clean any prior artifacts so the run is deterministic.
    await fs
      .rm(path.join(EXAMPLE_PROJECT, "target"), { recursive: true, force: true })
      .catch(() => undefined);
  });

  it("detects the example project", async () => {
    expect(await detectDbtProject(EXAMPLE_PROJECT)).toBe(EXAMPLE_PROJECT);
  });

  it("seeds, builds, and tests green against duckdb", async () => {
    const opts = {
      projectDir: EXAMPLE_PROJECT,
      target: "sandbox",
      dbtCommand: dbtCommand!,
      timeoutMs: 300000,
    };

    const seed = await runDbt("seed", opts);
    expect(seed.skipped).toBe(false);
    expect(seed.ok, `seed failed: ${seed.reason}\n${seed.stderr}`).toBe(true);

    const build = await runDbt("build", opts);
    expect(build.ok, `build failed: ${build.reason}\n${build.stderr}`).toBe(true);
    expect(build.failed).toEqual([]);
    // The mart model materialized.
    expect(build.nodes.map((n) => n.name)).toContain("fct_customer_retention");
    // Logical checks were exercised.
    const kinds = new Set(build.tests.map((t) => t.kind));
    expect(kinds.has("unique")).toBe(true);
    expect(kinds.has("not_null")).toBe(true);
    expect(kinds.has("accepted_values")).toBe(true);
    expect(kinds.has("relationships")).toBe(true);

    const test = await runDbt("test", opts);
    expect(test.ok, `test failed: ${test.reason}\n${test.stderr}`).toBe(true);
    expect(test.tests.every((t) => t.status === "pass")).toBe(true);
  }, 600000);
});

(RUN ? describe : describe.skip)(
  "validate tentacle drives REAL dbt build/test → non-blocked",
  () => {
    it("a clean example project reaches a NON-blocked validation verdict", async () => {
      // Clean prior artifacts for a deterministic run.
      await fs
        .rm(path.join(EXAMPLE_PROJECT, "target"), { recursive: true, force: true })
        .catch(() => undefined);

      // Use a temp project root for Oswald state/artifacts; point the dbt path
      // at the example project explicitly so detection resolves to it.
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-validate-it-"));
      try {
        const clock = fixedClock("2026-06-22T00:00:00.000Z");
        const state = createInitialState({
          projectName: "validate-it",
          projectRoot: root,
          clock,
          ticket: { id: "AE-1234", provider: null, url: null },
        });
        await fs.mkdir(path.join(root, ".oswald"), { recursive: true });
        await writeState(state, ".oswald");
        await fs.writeFile(
          path.join(root, ".oswald", "acceptance_criteria.md"),
          [
            "## Acceptance Criteria",
            "",
            "1. Model builds cleanly in the sandbox",
            "2. customer_id is unique",
            "3. customer_id is not null",
            "",
          ].join("\n"),
          "utf8",
        );

        // Seeds must exist before build for duckdb; run seed first via the runner.
        const seed = await runDbt("seed", {
          projectDir: EXAMPLE_PROJECT,
          target: "sandbox",
          dbtCommand: dbtCommand!,
          timeoutMs: 300000,
        });
        expect(seed.ok, `seed failed: ${seed.reason}\n${seed.stderr}`).toBe(true);

        const ctx = await buildContext({
          projectRoot: root,
          config: parseConfig({ project: { name: "validate-it" } }),
          clock,
          ticketId: "AE-1234",
          options: {
            skipExternal: false,
            dbtProject: true,
            dbtProjectDir: EXAMPLE_PROJECT,
            dbtTarget: "sandbox",
            dbtCommand: dbtCommand!,
            dbtTimeoutMs: 600000,
          },
        });
        const result = await validationTentacle.run(ctx);

        expect(
          result.output!.done,
          `validation blocked: ${JSON.stringify(result.output!.blockers)}`,
        ).toBe(true);
        expect(result.output!.failed).toBe(0);
        expect(result.output!.passed).toBeGreaterThan(0);

        const st = await readState(root, ".oswald");
        expect(st.status.phase).not.toBe("blocked");
        expect(st.status.phase).toBe("ready_for_pr");
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    }, 600000);
  },
);

// Always-present marker test so the file reports something even when skipped.
describe("dbt-duckdb integration availability", () => {
  it("reports whether a real dbt invocation was used", () => {
    if (!OPTED_IN) {
      expect(RUN).toBe(false); // opt-in via OSWALD_RUN_DBT_IT=1
    } else {
      expect(typeof RUN).toBe("boolean");
    }
  });
});
