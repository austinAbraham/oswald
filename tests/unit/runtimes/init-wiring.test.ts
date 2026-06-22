import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProgram } from "../../../src/cli/index.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-init-rt-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function runInit(root: string, args: string[] = []): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "oswald", "init", "--cwd", root, ...args]);
}

describe("oswald init --runtime wiring", () => {
  it("defaults to the generic runtime and installs its command templates", async () => {
    const root = await makeTmpDir();
    await runInit(root);

    // State exists.
    await expect(
      fs.access(path.join(root, ".oswald", "state.yml")),
    ).resolves.toBeUndefined();

    // Generic runtime templates installed.
    const intake = path.join(
      root,
      ".oswald",
      "runtime",
      "generic",
      "commands",
      "intake.md",
    );
    await expect(fs.access(intake)).resolves.toBeUndefined();
    expect(await fs.readFile(intake, "utf8")).toContain("# oswald intake");
  });

  it("installs claude-code templates + MCP doc when requested", async () => {
    const root = await makeTmpDir();
    await runInit(root, ["--runtime", "claude-code"]);

    const slash = path.join(
      root,
      ".oswald",
      "runtime",
      "claude-code",
      "commands",
      "oswald-intake.md",
    );
    const mcp = path.join(
      root,
      ".oswald",
      "runtime",
      "claude-code",
      "MCP-SETUP.md",
    );
    await expect(fs.access(slash)).resolves.toBeUndefined();
    await expect(fs.access(mcp)).resolves.toBeUndefined();
    expect(await fs.readFile(mcp, "utf8")).toContain("code.claude.com/docs/en/mcp");
  });

  it("falls back to generic templates for an unknown runtime", async () => {
    const root = await makeTmpDir();
    await runInit(root, ["--runtime", "bogus-runtime"]);

    await expect(
      fs.access(
        path.join(root, ".oswald", "runtime", "generic", "commands", "intake.md"),
      ),
    ).resolves.toBeUndefined();
    // No bogus dir created.
    await expect(
      fs.access(path.join(root, ".oswald", "runtime", "bogus-runtime")),
    ).rejects.toBeTruthy();
  });

  it("does not overwrite existing runtime files without --force", async () => {
    const root = await makeTmpDir();
    await runInit(root);

    const intake = path.join(
      root,
      ".oswald",
      "runtime",
      "generic",
      "commands",
      "intake.md",
    );
    await fs.writeFile(intake, "CUSTOM EDIT", "utf8");

    // Re-run without --force: file preserved.
    await runInit(root);
    expect(await fs.readFile(intake, "utf8")).toBe("CUSTOM EDIT");

    // Re-run with --force: file regenerated.
    await runInit(root, ["--force"]);
    expect(await fs.readFile(intake, "utf8")).toContain("# oswald intake");
  });

  it("honors --artifact-dir", async () => {
    const root = await makeTmpDir();
    await runInit(root, ["--artifact-dir", ".custom"]);
    await expect(
      fs.access(
        path.join(root, ".custom", "runtime", "generic", "commands", "intake.md"),
      ),
    ).resolves.toBeUndefined();
  });
});
