/**
 * Persistent audit ledger — the tamper-evident record of everything Oswald did.
 *
 * Every safety-relevant event (approval decisions, step outcomes, SQL
 * validations/executions, provider fallbacks, redaction/sanitizer hits) is
 * appended as one JSON line to `<artifact_dir>/audit.jsonl`. Each record
 * carries a rolling hash chain: it stores the previous record's hash
 * (`prev_hash`, genesis = 64 zeros) plus the SHA-256 of its own canonicalized
 * content (`hash`). Editing, reordering, inserting, or deleting any record
 * breaks the chain at a detectable point. (Truncating the *tail* of the file is
 * the one edit the chain alone cannot prove — an external anchor of the latest
 * hash is needed for that; `seq` still exposes it across exported copies.)
 *
 * Design rules:
 *   - FAIL-OPEN WRITES: `record()` never throws; a write failure logs a single
 *     warning and the command continues. The audit trail must never be the
 *     reason a pipeline run crashes.
 *   - DURABLE APPENDS: writes are synchronous — when `record()` returns, the
 *     record is on disk (or dropped with a warning). A crash mid-command cannot
 *     silently lose the trailing records of an otherwise-successful append.
 *   - CRASH ISOLATION: a kill/power-loss/ENOSPC mid-append can leave a partial
 *     final line with no trailing newline. The next append detects that and
 *     prepends a newline so the damaged fragment stays isolated on its own
 *     line — it never corrupts the next legitimate record. `verify()` then
 *     classifies such fragments as aborted appends (reported via
 *     `truncatedLines`), distinct from tampering: a junk line is only excused
 *     when the hash chain provably continues across it (or it trails a file
 *     that ends without a newline — the crash signature).
 *   - STRICT READS: `verify()` walks the chain strictly and reports the FIRST
 *     broken link (malformed line, sequence gap, prev-hash mismatch, or content
 *     hash mismatch).
 *   - INJECTED CLOCK: timestamps come from the injected {@link Clock}, matching
 *     the ArtifactManager pattern — no `Date.now()` in library code.
 *   - NO SECRETS / NO ABSOLUTE PATHS: callers record hashes, redacted summaries
 *     and project-relative paths only; the ledger itself never captures argv,
 *     env, credentials, or raw SQL text.
 */
import * as path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { sha256Hex } from "../artifacts/manager.js";
import { pathExists, readText, writeText } from "../../utils/fs.js";
import { systemClock, type Clock } from "../../utils/time.js";
import { logger as defaultLogger, type Logger } from "../logging/index.js";
import { ARTIFACT_FILES } from "../artifacts/names.js";
import { DEFAULT_ARTIFACT_DIR } from "../state/store.js";

/** Canonical ledger filename under the artifact dir. */
export const AUDIT_LEDGER_FILENAME = ARTIFACT_FILES.audit;

/** The `prev_hash` of the first record in a ledger. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

/** The fixed vocabulary of audit event types Oswald emits. */
export const AUDIT_EVENTS = [
  "approval_decision",
  "step_outcome",
  "sql_validated",
  "sql_executed",
  "provider_fallback",
  "redaction_applied",
  "sanitizer_detection",
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/** Structured, JSON-serializable payload attached to an event. */
export type AuditData = Record<string, unknown>;

/**
 * The minimal write-side interface. Gates (ApprovalService, SqlSafetyValidator,
 * ExternalContentSanitizer, provider selection) depend on this — not on the
 * concrete ledger — so they stay decoupled and trivially testable.
 */
export interface AuditSink {
  /** Fire-and-forget append. MUST never throw. */
  record(event: AuditEvent, data: AuditData): void;
}

/** One parsed ledger record (verification accepts any event vocabulary). */
export interface AuditRecord {
  v: 1;
  seq: number;
  ts: string;
  event: string;
  data: AuditData;
  prev_hash: string;
  hash: string;
}

const AuditRecordSchema = z.object({
  v: z.literal(1),
  seq: z.number().int().positive(),
  ts: z.string().min(1),
  event: z.string().min(1),
  data: z.record(z.unknown()),
  prev_hash: z.string().length(64),
  hash: z.string().length(64),
});

/** Result of a non-strict full read (export / tail rendering). */
export interface AuditReadResult {
  records: AuditRecord[];
  /** 1-based line numbers that failed to parse as a ledger record. */
  malformedLines: number[];
}

/** Result of a strict hash-chain walk. */
export interface AuditVerifyReport {
  ok: boolean;
  /** Records verified up to (and excluding) any broken link. */
  records: number;
  /** The first broken link, when the chain does not verify. */
  brokenAt?: { line: number; reason: string };
  /**
   * 1-based lines classified as crash-truncated (aborted) appends rather than
   * tampering: junk the hash chain provably continues across, or a trailing
   * fragment in a file that ends without a newline. Informational — the chain
   * itself still verifies.
   */
  truncatedLines?: number[];
}

// Single canonical SHA-256 helper lives in artifacts/manager (also used for
// artifact content hashing); re-exported here so audit callers keep their
// import path and both core barrels resolve to the same binding.
export { sha256Hex };

/**
 * Canonical JSON: recursively key-sorted, `undefined` properties dropped. Hash
 * input must not depend on property insertion order, so a re-serialized record
 * always re-hashes identically.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Compute the content hash of a record (everything except `hash` itself). */
export function computeRecordHash(payload: Omit<AuditRecord, "hash">): string {
  return sha256Hex(canonicalJson(payload));
}

export interface AuditLedgerOptions {
  /** Artifact dir the ledger lives under. Defaults to `.oswald`. */
  artifactDir?: string;
  /** Injected clock (tests pass a fixed clock). Defaults to systemClock. */
  clock?: Clock;
  /** Injected logger for the fail-open write warning. */
  logger?: Logger;
}

/**
 * Append-only JSONL ledger with a rolling hash chain.
 *
 * One instance per process/file: appends are synchronous and durable, so
 * records never interleave and the chain stays contiguous.
 */
export class AuditLedger implements AuditSink {
  readonly root: string;
  readonly artifactDir: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  /** Cached chain tail; null until the first append reads it from disk. */
  private tail: { seq: number; hash: string } | null = null;
  /**
   * Set when the on-disk file ends WITHOUT a newline (a crash-truncated
   * append). The next append prepends one so the partial line stays isolated
   * on its own line instead of swallowing the new record.
   */
  private isolatePartialLine = false;
  private warnedWriteFailure = false;

  constructor(root: string, options: AuditLedgerOptions = {}) {
    this.root = path.resolve(root);
    this.artifactDir = options.artifactDir ?? DEFAULT_ARTIFACT_DIR;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? defaultLogger;
  }

  /** Absolute path of the ledger file. */
  get filePath(): string {
    return path.resolve(this.root, this.artifactDir, AUDIT_LEDGER_FILENAME);
  }

  /** Ledger path relative to the project root (safe to embed in artifacts). */
  get relativePath(): string {
    return path.join(this.artifactDir, AUDIT_LEDGER_FILENAME);
  }

  /**
   * Append one record. FAIL-OPEN: never throws; a write failure warns once and
   * is otherwise silent. Durable: when this returns, the record is on disk.
   */
  record(event: AuditEvent, data: AuditData): void {
    try {
      this.tail ??= this.readTailSync();
      const payload: Omit<AuditRecord, "hash"> = {
        v: 1,
        seq: this.tail.seq + 1,
        ts: this.clock.nowIso(),
        event,
        data,
        prev_hash: this.tail.hash,
      };
      const record: AuditRecord = { ...payload, hash: computeRecordHash(payload) };
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(
        this.filePath,
        `${this.isolatePartialLine ? "\n" : ""}${JSON.stringify(record)}\n`,
        "utf8",
      );
      this.isolatePartialLine = false;
      this.tail = { seq: record.seq, hash: record.hash };
    } catch (err) {
      if (!this.warnedWriteFailure) {
        this.warnedWriteFailure = true;
        this.log.warn(
          `audit ledger write failed (${err instanceof Error ? err.message : String(err)}); continuing without a persisted audit trail`,
        );
      }
    }
  }

  /** Resume the chain from the last parseable record on disk (or genesis). */
  private readTailSync(): { seq: number; hash: string } {
    if (!existsSync(this.filePath)) {
      return { seq: 0, hash: AUDIT_GENESIS_HASH };
    }
    const content = readFileSync(this.filePath, "utf8");
    this.isolatePartialLine = content.length > 0 && !content.endsWith("\n");
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const record = parseRecordLine(lines[i]!);
      if (record) return { seq: record.seq, hash: record.hash };
    }
    return { seq: 0, hash: AUDIT_GENESIS_HASH };
  }

  /**
   * Read every record (non-strict). Malformed lines are reported by number, not
   * thrown, so a partially damaged ledger can still be inspected and exported.
   */
  async readAll(): Promise<AuditReadResult> {
    if (!(await pathExists(this.filePath))) {
      return { records: [], malformedLines: [] };
    }
    const records: AuditRecord[] = [];
    const malformedLines: number[] = [];
    const lines = (await readText(this.filePath)).split("\n");
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const record = parseRecordLine(line);
      if (record) records.push(record);
      else malformedLines.push(index + 1);
    });
    return { records, malformedLines };
  }

  /**
   * STRICT chain walk. Reports the first broken link: a malformed line, a
   * sequence gap, a `prev_hash` that does not match the prior record, or a
   * content hash that does not match the record itself.
   *
   * One class of malformed line is excused: a crash-truncated (aborted)
   * append. A junk run counts as one ONLY when the chain provably continues
   * across it — the next parseable record chains directly from the last
   * verified record — or when it trails a file that ends without a newline
   * (the crash signature; equivalent to the documented tail-truncation limit).
   * Such lines are reported via `truncatedLines`, never silently ignored.
   */
  async verify(): Promise<AuditVerifyReport> {
    if (!(await pathExists(this.filePath))) {
      return { ok: true, records: 0 };
    }
    const content = await readText(this.filePath);
    const endsWithNewline = content.endsWith("\n");
    const lines = content.split("\n");
    const truncatedLines: number[] = [];
    let prev = { seq: 0, hash: AUDIT_GENESIS_HASH };
    let verified = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      const lineNo = i + 1;
      const record = parseRecordLine(line);
      if (!record) {
        const junkRun = collectJunkRun(lines, i);
        if (isAbortedAppend(lines, junkRun, prev, endsWithNewline)) {
          for (const j of junkRun) truncatedLines.push(j + 1);
          i = junkRun[junkRun.length - 1]!;
          continue;
        }
        return brokenReport(verified, lineNo, "malformed record (not a valid ledger line)");
      }
      if (record.seq !== prev.seq + 1) {
        return brokenReport(
          verified,
          lineNo,
          `sequence break: expected seq ${prev.seq + 1}, found ${record.seq}`,
        );
      }
      if (record.prev_hash !== prev.hash) {
        return brokenReport(
          verified,
          lineNo,
          `chain break: prev_hash does not match the hash of record ${prev.seq}`,
        );
      }
      const { hash, ...payload } = record;
      if (computeRecordHash(payload) !== hash) {
        return brokenReport(
          verified,
          lineNo,
          "content mismatch: record hash does not match its content (record was altered)",
        );
      }
      prev = { seq: record.seq, hash: record.hash };
      verified += 1;
    }
    return {
      ok: true,
      records: verified,
      ...(truncatedLines.length > 0 ? { truncatedLines } : {}),
    };
  }

  /**
   * Bundle the ledger for compliance review. JSON wraps the records with the
   * chain verification result; CSV flattens one record per row (`data` as a
   * JSON cell). Returns the serialized payload.
   */
  async export(format: "json" | "csv"): Promise<string> {
    const { records, malformedLines } = await this.readAll();
    if (format === "csv") {
      const header = "seq,ts,event,ticket,data,prev_hash,hash";
      const rows = records.map((r) =>
        [
          String(r.seq),
          r.ts,
          r.event,
          typeof r.data.ticket === "string" ? r.data.ticket : "",
          JSON.stringify(r.data),
          r.prev_hash,
          r.hash,
        ]
          .map(csvCell)
          .join(","),
      );
      return [header, ...rows].join("\n") + "\n";
    }
    const chain = await this.verify();
    const bundle = {
      version: 1,
      exported_at: this.clock.nowIso(),
      source: this.relativePath,
      chain,
      malformed_lines: malformedLines,
      records,
    };
    return JSON.stringify(bundle, null, 2) + "\n";
  }

  /** Export and write to a file. Returns the absolute destination path. */
  async exportToFile(format: "json" | "csv", outPath: string): Promise<string> {
    const dest = path.resolve(this.root, outPath);
    await writeText(dest, await this.export(format));
    return dest;
  }
}

function brokenReport(
  records: number,
  line: number,
  reason: string,
): AuditVerifyReport {
  return { ok: false, records, brokenAt: { line, reason } };
}

/**
 * Collect the 0-based indices of the contiguous run of non-blank, unparseable
 * lines starting at `start` (blank lines inside the run are skipped over).
 */
function collectJunkRun(lines: string[], start: number): number[] {
  const run: number[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (parseRecordLine(line)) break;
    run.push(i);
  }
  return run;
}

/**
 * Whether a junk run is a crash-truncated (aborted) append rather than
 * tampering. True when the next parseable record chains DIRECTLY from the last
 * verified record (the junk never entered the chain), or when the run trails a
 * file that ends without a newline — the signature of an interrupted write.
 * Anything else stays a hard break: excusing it could hide an altered record.
 */
function isAbortedAppend(
  lines: string[],
  junkRun: number[],
  prev: { seq: number; hash: string },
  endsWithNewline: boolean,
): boolean {
  const last = junkRun[junkRun.length - 1];
  if (last === undefined) return false;
  for (let i = last + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const next = parseRecordLine(line);
    return next !== null && next.seq === prev.seq + 1 && next.prev_hash === prev.hash;
  }
  return !endsWithNewline;
}

/** Parse one JSONL line into a record, or null when it is not one. */
function parseRecordLine(line: string): AuditRecord | null {
  try {
    const result = AuditRecordSchema.safeParse(JSON.parse(line));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Escape a CSV cell (RFC-4180 style: quote when needed, double quotes). */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
