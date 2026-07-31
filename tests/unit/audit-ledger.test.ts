import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AuditLedger,
  AUDIT_GENESIS_HASH,
  AUDIT_LEDGER_FILENAME,
  computeRecordHash,
  sha256Hex,
  type AuditRecord,
} from "../../src/core/audit/index.js";
import { createLogger, type Logger } from "../../src/core/logging/index.js";
import { fixedClock } from "../../src/utils/time.js";

const CLOCK = fixedClock("2026-07-01T00:00:00.000Z");
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-audit-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  });
  return { logger, lines };
}

function makeLedger(root: string, logger?: Logger): AuditLedger {
  return new AuditLedger(root, {
    clock: CLOCK,
    ...(logger ? { logger } : {}),
  });
}

async function readLines(root: string): Promise<string[]> {
  const raw = await fs.readFile(
    path.join(root, ".oswald", AUDIT_LEDGER_FILENAME),
    "utf8",
  );
  return raw.split("\n").filter(Boolean);
}

async function writeLines(root: string, lines: string[]): Promise<void> {
  await fs.writeFile(
    path.join(root, ".oswald", AUDIT_LEDGER_FILENAME),
    lines.map((l) => `${l}\n`).join(""),
    "utf8",
  );
}

describe("AuditLedger: append + hash chain", () => {
  it("appends JSONL records chained from the genesis hash", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);

    ledger.record("approval_decision", { action: "commit", decision: "denied" });
    ledger.record("step_outcome", { command: "eda", exit_code: 0 });

    const lines = await readLines(root);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as AuditRecord;
    const second = JSON.parse(lines[1]!) as AuditRecord;
    expect(first.v).toBe(1);
    expect(first.seq).toBe(1);
    expect(first.ts).toBe("2026-07-01T00:00:00.000Z");
    expect(first.prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(second.seq).toBe(2);
    expect(second.prev_hash).toBe(first.hash);

    const { hash, ...payload } = second;
    expect(computeRecordHash(payload)).toBe(hash);
  });

  it("hashes are stable regardless of data key insertion order", () => {
    const a = computeRecordHash({
      v: 1,
      seq: 1,
      ts: "t",
      event: "step_outcome",
      data: { b: 2, a: 1 },
      prev_hash: AUDIT_GENESIS_HASH,
    });
    const b = computeRecordHash({
      v: 1,
      seq: 1,
      ts: "t",
      event: "step_outcome",
      data: { a: 1, b: 2 },
      prev_hash: AUDIT_GENESIS_HASH,
    });
    expect(a).toBe(b);
  });

  it("resumes the chain across ledger instances", async () => {
    const root = await makeTmpDir();
    makeLedger(root).record("step_outcome", { command: "intake", exit_code: 0 });
    makeLedger(root).record("step_outcome", { command: "eda", exit_code: 0 });

    const report = await makeLedger(root).verify();
    expect(report.ok).toBe(true);
    expect(report.records).toBe(2);
  });

  it("sha256Hex digests deterministically", () => {
    expect(sha256Hex("SELECT 1")).toBe(sha256Hex("SELECT 1"));
    expect(sha256Hex("SELECT 1")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("SELECT 1")).not.toBe(sha256Hex("SELECT 2"));
  });
});

describe("AuditLedger: fail-open writes", () => {
  it("never throws when the ledger location is unwritable, and warns once", async () => {
    const root = await makeTmpDir();
    // Occupy the artifact-dir path with a FILE so mkdir/append must fail.
    await fs.writeFile(path.join(root, ".oswald"), "not a directory", "utf8");
    const { logger, lines } = captureLogger();
    const ledger = makeLedger(root, logger);

    expect(() => {
      ledger.record("step_outcome", { command: "intake", exit_code: 0 });
      ledger.record("step_outcome", { command: "eda", exit_code: 0 });
    }).not.toThrow();

    const warnings = lines.filter((l) => l.includes("audit ledger write failed"));
    expect(warnings).toHaveLength(1);
  });
});

describe("AuditLedger: verify", () => {
  it("reports an empty/missing ledger as intact with zero records", async () => {
    const root = await makeTmpDir();
    const report = await makeLedger(root).verify();
    expect(report).toEqual({ ok: true, records: 0 });
  });

  it("detects an edited record via its content hash", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);
    ledger.record("approval_decision", { action: "push", decision: "denied" });
    ledger.record("step_outcome", { command: "pr", exit_code: 0 });

    const lines = await readLines(root);
    const tampered = JSON.parse(lines[0]!) as AuditRecord;
    tampered.data = { action: "push", decision: "allowed" };
    await writeLines(root, [JSON.stringify(tampered), lines[1]!]);

    const report = await makeLedger(root).verify();
    expect(report.ok).toBe(false);
    expect(report.records).toBe(0);
    expect(report.brokenAt?.line).toBe(1);
    expect(report.brokenAt?.reason).toMatch(/content mismatch/);
  });

  it("detects a deleted record via the prev_hash chain", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);
    ledger.record("step_outcome", { command: "intake", exit_code: 0 });
    ledger.record("step_outcome", { command: "clarify", exit_code: 0 });
    ledger.record("step_outcome", { command: "eda", exit_code: 0 });

    const lines = await readLines(root);
    await writeLines(root, [lines[0]!, lines[2]!]);

    const report = await makeLedger(root).verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt?.line).toBe(2);
    expect(report.brokenAt?.reason).toMatch(/sequence break/);
  });

  it("detects a reordered ledger", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);
    ledger.record("step_outcome", { command: "intake", exit_code: 0 });
    ledger.record("step_outcome", { command: "eda", exit_code: 0 });

    const lines = await readLines(root);
    await writeLines(root, [lines[1]!, lines[0]!]);

    const report = await makeLedger(root).verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt?.line).toBe(1);
  });

  it("reports the first malformed line", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);
    ledger.record("step_outcome", { command: "intake", exit_code: 0 });

    const lines = await readLines(root);
    await writeLines(root, [lines[0]!, "{not json"]);

    const report = await makeLedger(root).verify();
    expect(report.ok).toBe(false);
    expect(report.records).toBe(1);
    expect(report.brokenAt).toEqual({
      line: 2,
      reason: "malformed record (not a valid ledger line)",
    });
  });
});

describe("AuditLedger: readAll + export", () => {
  it("readAll returns records and flags malformed lines without throwing", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);
    ledger.record("step_outcome", { command: "intake", exit_code: 0 });

    const lines = await readLines(root);
    await writeLines(root, ["garbage", lines[0]!]);

    const result = await makeLedger(root).readAll();
    expect(result.records).toHaveLength(1);
    expect(result.malformedLines).toEqual([1]);
  });

  it("exports a JSON bundle with the chain verification result", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);
    ledger.record("approval_decision", {
      action: "open_pull_request",
      decision: "allowed",
      ticket: "AE-1",
    });

    const bundle = JSON.parse(await ledger.export("json")) as {
      version: number;
      exported_at: string;
      source: string;
      chain: { ok: boolean; records: number };
      records: AuditRecord[];
    };
    expect(bundle.version).toBe(1);
    expect(bundle.exported_at).toBe("2026-07-01T00:00:00.000Z");
    expect(bundle.source).toBe(path.join(".oswald", "audit.jsonl"));
    expect(bundle.chain).toEqual({ ok: true, records: 1 });
    expect(bundle.records).toHaveLength(1);
    expect(bundle.records[0]!.data.ticket).toBe("AE-1");
  });

  it("exports CSV with a header, a ticket column, and escaped cells", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);
    ledger.record("approval_decision", {
      action: "commit",
      decision: "denied",
      ticket: "AE-2",
      reason: 'needs "explicit, human" consent',
    });

    const csv = await ledger.export("csv");
    const [header, row] = csv.trim().split("\n");
    expect(header).toBe("seq,ts,event,ticket,data,prev_hash,hash");
    expect(row).toContain("approval_decision");
    expect(row).toContain(",AE-2,");
    // The data cell contains commas + quotes, so it must be quoted with
    // embedded quotes doubled (RFC-4180).
    expect(row).toContain(',"{');
    expect(row).toContain('""');
    expect(row).toContain("explicit, human");
  });

  it("exportToFile writes the bundle to the requested path", async () => {
    const root = await makeTmpDir();
    const ledger = makeLedger(root);
    ledger.record("step_outcome", { command: "eda", exit_code: 0 });

    const dest = await ledger.exportToFile("csv", "out/audit-export.csv");
    expect(dest).toBe(path.join(root, "out", "audit-export.csv"));
    const content = await fs.readFile(dest, "utf8");
    expect(content.startsWith("seq,ts,event,ticket,data,prev_hash,hash")).toBe(true);
  });
});
