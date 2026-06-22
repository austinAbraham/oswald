import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDiagnostics, detectRuntime } from "../../src/core/doctor/index.js";
import {
  MockWarehouseProvider,
  MockDocumentProvider,
} from "../../src/tools/providers/mock/index.js";

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-doctor-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("detectRuntime", () => {
  it("detects the node version", () => {
    const c = detectRuntime();
    expect(c.name).toBe("runtime");
    expect(["ok", "fail"]).toContain(c.status);
  });
});

describe("runDiagnostics", () => {
  it("produces checks, provider health, and policy mode for an empty dir", async () => {
    const dir = await makeTmpDir();
    const report = await runDiagnostics({
      cwd: dir,
      providers: [new MockWarehouseProvider(), new MockDocumentProvider()],
    });

    const names = report.checks.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["runtime", "config", "artifact_dir", "state"]));

    expect(report.providers.length).toBe(2);
    expect(report.providers[0]?.health.state).toBeDefined();

    // No config file present → default policy mode is still default-deny.
    expect(report.policyMode?.mode).toBe("default-deny");
    expect(report.policyMode?.maskSensitiveValues).toBe(true);

    // Empty dir = uninitialized → recommend init.
    expect(report.recommendedNext).toBe("init");
  });

  it("reports config as valid when oswald.yml is present", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "oswald.yml"), "project:\n  name: demo\n", "utf8");
    const report = await runDiagnostics({ cwd: dir });
    const config = report.checks.find((c) => c.name === "config");
    expect(config?.status).toBe("ok");
    expect(config?.detail).toMatch(/demo/);
  });
});
