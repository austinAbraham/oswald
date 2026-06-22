/**
 * Parse dbt's `run_results.json` (and, when present, `manifest.json`) into the
 * stable {@link DbtRunResult} shape.
 *
 * This is a PURE function over already-read JSON text/objects — it does no file
 * I/O and spawns nothing, so it is trivially unit-testable against fixtures.
 * The runner (`runner.ts`) reads the files and calls this.
 *
 * dbt's run_results schema (v4/v5/v6) is stable enough in the parts we need:
 *   { results: [ { unique_id, status, message?, failures?, ... } ], ... }
 * and the manifest maps `unique_id` → node detail (resource_type, column_name,
 * test_metadata, depends_on). We tolerate missing fields defensively.
 */
import { classifyDbtTest, extractTestColumn } from "./checks.js";
import type {
  DbtCommand,
  DbtNodeResult,
  DbtNodeStatus,
  DbtRunResult,
  DbtTestResult,
} from "./types.js";

interface RawRunResult {
  unique_id?: string;
  status?: string;
  message?: string | null;
  failures?: number | null;
}

interface RawManifestNode {
  name?: string;
  resource_type?: string;
  column_name?: string | null;
  test_metadata?: { name?: string; kwargs?: Record<string, unknown> } | null;
}

/** Collapse dbt's status strings into our normalized vocabulary. */
function normalizeStatus(raw: string | undefined): DbtNodeStatus {
  const s = (raw ?? "").toLowerCase();
  switch (s) {
    case "pass":
      return "pass";
    case "fail":
      return "fail";
    case "error":
      return "error";
    case "warn":
      return "warn";
    case "skipped":
      return "skipped";
    case "success":
      return "success";
    default:
      // dbt sometimes emits "runtime error" etc.
      if (s.includes("error")) return "error";
      if (s.includes("fail")) return "fail";
      if (s.includes("skip")) return "skipped";
      return s ? "warn" : "skipped";
  }
}

/** Is a normalized status a failure that should make the run NOT ok? */
function isFailure(status: DbtNodeStatus): boolean {
  return status === "fail" || status === "error";
}

/** A trailing short hex segment dbt appends to test unique_ids (a uniqueness hash). */
const TEST_HASH_RE = /^[0-9a-f]{6,12}$/;

/**
 * Derive resource type + name from a unique_id.
 *   model:  "model.proj.stg_x"                         → stg_x
 *   seed:   "seed.proj.raw_x"                           → raw_x
 *   test:   "test.proj.unique_stg_x_id.60e0ed7bb1"     → unique_stg_x_id
 * dbt appends a uniqueness hash to TEST unique_ids; strip it so the name is the
 * stable, human-readable test name.
 */
function parseUniqueId(uniqueId: string): { resourceType: string; name: string } {
  const parts = uniqueId.split(".");
  const resourceType = parts[0] ?? "unknown";
  let nameParts = parts.slice(2);
  if (
    (resourceType === "test" || resourceType === "unit_test") &&
    nameParts.length > 1 &&
    TEST_HASH_RE.test(nameParts[nameParts.length - 1]!)
  ) {
    nameParts = nameParts.slice(0, -1);
  }
  const name = nameParts.length ? nameParts.join(".") : (parts[parts.length - 1] ?? uniqueId);
  return { resourceType, name };
}

export interface ParseInput {
  /** The subcommand that produced these results. */
  command: DbtCommand;
  /** Parsed `run_results.json` object (or its raw text). */
  runResults: unknown;
  /** Optional parsed `manifest.json` object (or its raw text) for test detail. */
  manifest?: unknown;
  /** Process exit code, threaded through to the result. */
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
}

/**
 * Build a `unique_id → manifest node` index from a parsed manifest object.
 * Returns an empty map when the manifest is absent/unparseable.
 */
function indexManifest(manifest: unknown): Map<string, RawManifestNode> {
  const out = new Map<string, RawManifestNode>();
  const obj = asObject(manifest);
  const nodes = (obj.nodes ?? {}) as Record<string, RawManifestNode>;
  for (const [uid, node] of Object.entries(nodes)) {
    if (node && typeof node === "object") out.set(uid, node);
  }
  return out;
}

/**
 * Parse run_results (+ optional manifest) into the typed result.
 */
export function parseRunResults(input: ParseInput): DbtRunResult {
  const runObj = asObject(input.runResults);
  const rawResults = Array.isArray(runObj.results)
    ? (runObj.results as RawRunResult[])
    : [];
  const manifestIndex = indexManifest(input.manifest);

  const nodes: DbtNodeResult[] = [];
  const tests: DbtTestResult[] = [];

  for (const r of rawResults) {
    const uniqueId = r.unique_id ?? "";
    if (!uniqueId) continue;
    const { resourceType, name } = parseUniqueId(uniqueId);
    const status = normalizeStatus(r.status);
    const message =
      r.message != null && String(r.message).trim()
        ? String(r.message)
        : status === "fail" && typeof r.failures === "number" && r.failures > 0
          ? `${r.failures} failing row(s)`
          : undefined;

    if (resourceType === "test" || resourceType === "unit_test") {
      const mNode = manifestIndex.get(uniqueId);
      // The manifest's `name` is the clean, hash-free test name — prefer it.
      const testName = mNode?.name && mNode.name.trim() ? mNode.name : name;
      const kind = classifyDbtTest(testName, mNode?.test_metadata?.name ?? undefined);
      const column = extractTestColumn(testName, mNode?.column_name ?? undefined);
      tests.push({
        name: testName,
        status,
        kind,
        ...(column ? { column } : {}),
        ...(message ? { message } : {}),
      });
    } else {
      nodes.push({
        name,
        resourceType,
        status,
        ...(message ? { message } : {}),
      });
    }
  }

  const failed = [
    ...nodes.filter((n) => isFailure(n.status)).map((n) => n.name),
    ...tests.filter((t) => isFailure(t.status)).map((t) => t.name),
  ];

  const exitCode = input.exitCode ?? null;
  const ok = failed.length === 0 && (exitCode === null || exitCode === 0);

  return {
    ok,
    command: input.command,
    exitCode,
    skipped: false,
    nodes,
    tests,
    failed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    ...(ok ? {} : { reason: failed.length ? `${failed.length} node(s)/test(s) failed` : `dbt exited ${exitCode}` }),
  };
}

/** Construct a `skipped (offline)` result without touching dbt. */
export function skippedResult(command: DbtCommand, reason: string): DbtRunResult {
  return {
    ok: true,
    command,
    exitCode: null,
    skipped: true,
    reason,
    nodes: [],
    tests: [],
    failed: [],
    stdout: "",
    stderr: "",
  };
}
