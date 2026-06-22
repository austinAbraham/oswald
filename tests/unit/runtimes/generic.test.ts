import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GenericAdapter } from "../../../src/runtimes/adapters/generic.js";
import { OSWALD_COMMANDS } from "../../../src/runtimes/commands.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-rt-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("GenericAdapter", () => {
  it("is always detected", () => {
    expect(new GenericAdapter().detect()).toBe(true);
  });

  it("renders one command-prompt file per Oswald command plus a README", () => {
    const adapter = new GenericAdapter();
    const files = adapter.renderCommands({
      root: "/tmp/x",
      artifactDir: ".oswald",
      projectName: "demo",
    });
    // 15 commands + 1 README index.
    expect(files).toHaveLength(OSWALD_COMMANDS.length + 1);
    for (const cmd of OSWALD_COMMANDS) {
      const f = files.find((x) =>
        x.path.endsWith(path.join("commands", `${cmd.name}.md`)),
      );
      expect(f, `missing file for ${cmd.name}`).toBeDefined();
      expect(f!.content).toContain(`# oswald ${cmd.name}`);
      expect(f!.content).toContain(cmd.invoke);
    }
  });

  it("install writes the expected files to a temp dir under the artifact dir", async () => {
    const root = await makeTmpDir();
    const adapter = new GenericAdapter();
    const result = await adapter.install({
      root,
      artifactDir: ".oswald",
      projectName: "demo",
    });

    expect(result.runtime).toBe("generic");
    expect(result.written.length).toBe(OSWALD_COMMANDS.length + 1);
    expect(result.skipped).toHaveLength(0);

    const cmdDir = path.join(root, ".oswald", "runtime", "generic", "commands");
    const intake = await fs.readFile(path.join(cmdDir, "intake.md"), "utf8");
    expect(intake).toContain("# oswald intake");

    const readme = await fs.readFile(
      path.join(root, ".oswald", "runtime", "generic", "README.md"),
      "utf8",
    );
    expect(readme).toContain("Oswald commands (generic runtime)");
    expect(readme).toContain("demo");
  });

  it("install skips existing files unless force is set", async () => {
    const root = await makeTmpDir();
    const adapter = new GenericAdapter();
    const opts = { root, artifactDir: ".oswald", projectName: "demo" };

    const first = await adapter.install(opts);
    expect(first.written.length).toBeGreaterThan(0);

    // Second run without force: everything skipped, nothing written.
    const second = await adapter.install(opts);
    expect(second.written).toHaveLength(0);
    expect(second.skipped.length).toBe(first.written.length);

    // With force: rewritten.
    const third = await adapter.install({ ...opts, force: true });
    expect(third.written.length).toBe(first.written.length);
    expect(third.skipped).toHaveLength(0);
  });

  it("uninstall removes installed files", async () => {
    const root = await makeTmpDir();
    const adapter = new GenericAdapter();
    const opts = { root, artifactDir: ".oswald", projectName: "demo" };
    await adapter.install(opts);

    const removed = await adapter.uninstall(opts);
    expect(removed.written.length).toBeGreaterThan(0);
    await expect(
      fs.access(
        path.join(root, ".oswald", "runtime", "generic", "commands", "intake.md"),
      ),
    ).rejects.toBeTruthy();
  });
});

describe("adapter docs never contain secrets", () => {
  it("claude-code MCP doc references official docs, no credentials", async () => {
    const { ClaudeCodeAdapter } = await import(
      "../../../src/runtimes/adapters/claude-code.js"
    );
    const adapter = new ClaudeCodeAdapter();
    const docs = adapter.renderDocs({ root: "/tmp/x", artifactDir: ".oswald" });
    const all = docs.map((d) => d.content).join("\n");
    expect(all).toContain("code.claude.com/docs/en/mcp");
    expect(all).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(all.toLowerCase()).toContain("never stores");
  });
});
