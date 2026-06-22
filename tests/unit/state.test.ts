import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createInitialState,
  readState,
  writeState,
  updateState,
  stateFilePath,
  parseState,
  StateError,
} from "../../src/core/state/index.js";
import { fixedClock } from "../../src/utils/time.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-state-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const T0 = "2026-06-22T00:00:00.000Z";
const T1 = "2026-06-22T01:00:00.000Z";

describe("state: round-trip", () => {
  it("creates, writes, and reads back identical state", async () => {
    const root = await makeTmpDir();
    const state = createInitialState({
      projectName: "demo",
      projectRoot: root,
      clock: fixedClock(T0),
    });
    await writeState(state);

    const loaded = await readState(root);
    expect(loaded.project.name).toBe("demo");
    expect(loaded.project.root).toBe(root);
    expect(loaded.status.phase).toBe("uninitialized");
    expect(loaded.timestamps.created_at).toBe(T0);
    expect(loaded.timestamps.updated_at).toBe(T0);
    expect(loaded.version).toBe(1);
  });

  it("writes state under <root>/.oswald/state.yml", async () => {
    const root = await makeTmpDir();
    const state = createInitialState({
      projectName: "demo",
      projectRoot: root,
      clock: fixedClock(T0),
    });
    const written = await writeState(state);
    expect(written).toBe(stateFilePath(root));
    expect(written).toContain(path.join(".oswald", "state.yml"));
  });
});

describe("state: updateState", () => {
  it("mutates state and stamps updated_at from the injected clock", async () => {
    const root = await makeTmpDir();
    await writeState(
      createInitialState({
        projectName: "demo",
        projectRoot: root,
        clock: fixedClock(T0),
      }),
    );

    const updated = await updateState(
      root,
      (s) => {
        s.status.phase = "intake";
        s.status.last_command = "intake";
        return s;
      },
      { clock: fixedClock(T1) },
    );

    expect(updated.status.phase).toBe("intake");
    expect(updated.status.last_command).toBe("intake");
    expect(updated.timestamps.created_at).toBe(T0);
    expect(updated.timestamps.updated_at).toBe(T1);

    const reloaded = await readState(root);
    expect(reloaded.status.phase).toBe("intake");
    expect(reloaded.timestamps.updated_at).toBe(T1);
  });
});

describe("state: errors", () => {
  it("readState throws when not initialized", async () => {
    const root = await makeTmpDir();
    await expect(readState(root)).rejects.toThrow(StateError);
  });

  it("parseState rejects an invalid phase", () => {
    expect(() =>
      parseState({
        version: 1,
        project: { name: "x", root: "/tmp/x" },
        status: { phase: "not-a-phase" },
        timestamps: { created_at: T0, updated_at: T0 },
        artifacts: {},
      }),
    ).toThrow(StateError);
  });
});
