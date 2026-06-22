import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectDbtProject, runDbt } from "../../../src/tools/dbt/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const EXAMPLE_PROJECT = path.join(REPO_ROOT, "examples", "dbt-project");

describe("detectDbtProject", () => {
  it("finds dbt_project.yml at the project root", async () => {
    const found = await detectDbtProject(EXAMPLE_PROJECT);
    expect(found).toBe(EXAMPLE_PROJECT);
  });

  it("walks up from a nested subdirectory", async () => {
    const nested = path.join(EXAMPLE_PROJECT, "models", "marts", "customer");
    const found = await detectDbtProject(nested);
    expect(found).toBe(EXAMPLE_PROJECT);
  });

  it("returns null when no project is found", async () => {
    // os tmp-ish dir guaranteed to have no dbt_project.yml above it within repo.
    const found = await detectDbtProject(path.join(REPO_ROOT, "src", "core"));
    // src/core has no dbt_project.yml; walking up hits repo root (no file there).
    expect(found).toBeNull();
  });
});

describe("runDbt — guards (no subprocess spawned)", () => {
  it("skipExternal returns a skipped (offline) result without spawning", async () => {
    const result = await runDbt("build", {
      projectDir: EXAMPLE_PROJECT,
      target: "sandbox",
      skipExternal: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.reason).toMatch(/offline/);
    expect(result.nodes).toEqual([]);
  });

  it("blocks a write command (build) against a non-sandbox target", async () => {
    const result = await runDbt("build", {
      projectDir: EXAMPLE_PROJECT,
      target: "production",
    });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/not recognized as a sandbox/);
    // No artifacts parsed — nothing ran.
    expect(result.nodes).toEqual([]);
  });

  it("blocks seed against a non-sandbox target too", async () => {
    const result = await runDbt("seed", {
      projectDir: EXAMPLE_PROJECT,
      target: "prod",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/sandbox/);
  });

  it("allows a non-sandbox target when explicitly overridden (still offline here)", async () => {
    // We do NOT actually want to spawn dbt in unit tests; combine the override
    // with skipExternal so the offline guard short-circuits first and proves the
    // sandbox guard did not block.
    const result = await runDbt("build", {
      projectDir: EXAMPLE_PROJECT,
      target: "production",
      allowNonSandboxTarget: true,
      skipExternal: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/offline/);
  });

  it("does NOT block read-only commands (parse/test) on target name", async () => {
    // Offline so no spawn; the point is the sandbox guard must not fire for read
    // commands — reason should be the offline skip, not a sandbox block.
    const parse = await runDbt("parse", {
      projectDir: EXAMPLE_PROJECT,
      target: "production",
      skipExternal: true,
    });
    expect(parse.reason).toMatch(/offline/);
    expect(parse.reason).not.toMatch(/sandbox/);
  });
});
