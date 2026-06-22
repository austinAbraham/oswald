import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactManager,
  ArtifactError,
  ARTIFACT_FILENAMES,
} from "../../src/core/artifacts/index.js";
import { fixedClock } from "../../src/utils/time.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-art-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("artifacts: write/read/append", () => {
  it("ensures the dir and writes then reads content", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root);
    await am.ensureArtifactDir();
    await am.write("intake.md", "hello");
    expect(await am.read("intake.md")).toBe("hello");
    expect(await am.exists("intake.md")).toBe(true);
  });

  it("appends to an existing artifact", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root);
    await am.write("eda.md", "line1\n");
    await am.append("eda.md", "line2\n");
    expect(await am.read("eda.md")).toBe("line1\nline2\n");
  });

  it("append creates the file if missing", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root);
    await am.append("new.md", "x");
    expect(await am.read("new.md")).toBe("x");
  });

  it("read throws for a missing artifact", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root);
    await expect(am.read("missing.md")).rejects.toThrow(ArtifactError);
  });

  it("rejects path traversal outside the artifact dir", () => {
    const root = "/tmp/whatever";
    const am = new ArtifactManager(root);
    expect(() => am.resolve("../escape.md")).toThrow(ArtifactError);
  });
});

describe("artifacts: archive", () => {
  it("moves an artifact into archive/ with a timestamped name", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root, { clock: fixedClock("2026-06-22T00:00:00.000Z") });
    await am.write("design.md", "v1");
    const archived = await am.archive("design.md");
    expect(archived).toBeTruthy();
    expect(archived!).toContain(path.join("archive"));
    expect(await am.exists("design.md")).toBe(false);
    expect(await fs.readFile(archived!, "utf8")).toBe("v1");
  });

  it("returns null when archiving a missing artifact", async () => {
    const root = await makeTmpDir();
    const am = new ArtifactManager(root, { clock: fixedClock("2026-06-22T00:00:00.000Z") });
    expect(await am.archive("nope.md")).toBeNull();
  });
});

describe("artifacts: rendering", () => {
  it("renders structured markdown", () => {
    const am = new ArtifactManager("/tmp/x");
    const md = am.renderMarkdown({
      title: "Intake",
      summary: "A summary.",
      sections: [{ heading: "Goal", body: "Do the thing." }],
    });
    expect(md).toContain("# Intake");
    expect(md).toContain("## Goal");
    expect(md).toContain("Do the thing.");
  });

  it("renders safe yaml", () => {
    const am = new ArtifactManager("/tmp/x");
    const y = am.renderYaml({ a: 1, b: ["x", "y"] });
    expect(y).toContain("a: 1");
    expect(y).toContain("- x");
  });
});

describe("artifacts: canonical names", () => {
  it("exposes the full filename set", () => {
    expect(ARTIFACT_FILENAMES).toContain("intake.md");
    expect(ARTIFACT_FILENAMES).toContain("validation.md");
    expect(ARTIFACT_FILENAMES).toContain("audit.log");
  });
});
