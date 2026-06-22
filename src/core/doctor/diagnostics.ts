/**
 * Doctor diagnostics — capability/health aggregation for `oswald doctor`.
 *
 * Aggregates: runtime detection (best-effort), config validity, artifact-dir
 * status, per-provider health, policy mode, and a recommended next step. Pure
 * data in / data out so it can be unit-tested without touching argv or the
 * process exit code.
 */
import * as path from "node:path";
import {
  DEFAULT_CONFIG_FILENAME,
  loadConfig,
  ConfigError,
  type OswaldConfig,
} from "../config/index.js";
import { readState, StateError } from "../state/index.js";
import {
  recommendNextCommand,
  isWorkflowState,
  type WorkflowState,
} from "../workflow/index.js";
import { pathExists } from "../../utils/fs.js";
import type { HealthReport, ToolProvider } from "../../tools/providers/types.js";

export type DiagnosticStatus = "ok" | "warn" | "fail";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  detail: string;
}

export interface ProviderDiagnostic {
  name: string;
  kind: string;
  health: HealthReport;
  capabilityCount: number;
}

export interface DoctorReport {
  checks: DiagnosticCheck[];
  providers: ProviderDiagnostic[];
  /** "default-deny" always, with the gated/prohibited action lists. */
  policyMode: {
    mode: "default-deny";
    requireApprovalFor: string[];
    prohibit: string[];
    maskSensitiveValues: boolean;
    maxResultRows: number;
  } | null;
  recommendedNext: string | null;
  /** Overall: ok if no fail-status checks. */
  ok: boolean;
}

export interface DoctorOptions {
  cwd: string;
  /** Providers to health-check. */
  providers?: ToolProvider[];
}

/** Best-effort runtime detection. Never throws. */
export function detectRuntime(): DiagnosticCheck {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = Number.isFinite(major) && major >= 22;
  return {
    name: "runtime",
    status: ok ? "ok" : "fail",
    detail: `node ${process.versions.node}${ok ? "" : " (need >= 22)"}`,
  };
}

async function checkConfig(
  root: string,
): Promise<{ check: DiagnosticCheck; config: OswaldConfig | null }> {
  const configPath = path.resolve(root, DEFAULT_CONFIG_FILENAME);
  if (!(await pathExists(configPath))) {
    return {
      check: {
        name: "config",
        status: "ok",
        detail: `none found; using built-in defaults (${DEFAULT_CONFIG_FILENAME} optional)`,
      },
      config: null,
    };
  }
  try {
    const config = await loadConfig(configPath);
    return {
      check: {
        name: "config",
        status: "ok",
        detail: `valid; project '${config.project.name}', ${Object.keys(config.mcp_servers).length} mcp server(s)`,
      },
      config,
    };
  } catch (err) {
    return {
      check: {
        name: "config",
        status: "fail",
        detail: err instanceof ConfigError ? err.message : String(err),
      },
      config: null,
    };
  }
}

async function checkArtifactDir(
  root: string,
  config: OswaldConfig | null,
): Promise<DiagnosticCheck> {
  const dir = path.resolve(root, config?.paths.artifact_dir ?? ".oswald");
  const exists = await pathExists(dir);
  return {
    name: "artifact_dir",
    status: exists ? "ok" : "warn",
    detail: exists ? `present at ${dir}` : `missing (${dir}); run 'oswald init'`,
  };
}

async function checkState(
  root: string,
): Promise<{ check: DiagnosticCheck; next: string | null }> {
  try {
    const state = await readState(root);
    const phase = state.status.phase;
    const next =
      typeof phase === "string" && isWorkflowState(phase)
        ? recommendNextCommand(phase as WorkflowState)
        : null;
    return {
      check: {
        name: "state",
        status: "ok",
        detail: `phase '${phase}', last command '${state.status.last_command ?? "—"}'`,
      },
      next,
    };
  } catch (err) {
    return {
      check: {
        name: "state",
        status: "warn",
        detail:
          err instanceof StateError
            ? "not initialized — run 'oswald init'"
            : String(err),
      },
      next: "init",
    };
  }
}

/** Build the full doctor report. */
export async function runDiagnostics(options: DoctorOptions): Promise<DoctorReport> {
  const root = path.resolve(options.cwd);
  const checks: DiagnosticCheck[] = [];

  checks.push(detectRuntime());

  const { check: configCheck, config } = await checkConfig(root);
  checks.push(configCheck);

  checks.push(await checkArtifactDir(root, config));

  const { check: stateCheck, next } = await checkState(root);
  checks.push(stateCheck);

  const providers: ProviderDiagnostic[] = [];
  for (const p of options.providers ?? []) {
    let health: HealthReport;
    try {
      health = await p.health();
    } catch (err) {
      health = { state: "unavailable", detail: String(err) };
    }
    providers.push({
      name: p.name,
      kind: p.kind,
      health,
      capabilityCount: p.capabilities().length,
    });
  }

  const policyMode = config
    ? ({
        mode: "default-deny" as const,
        requireApprovalFor: config.policies.require_approval_for,
        prohibit: config.policies.prohibit,
        maskSensitiveValues: config.policies.privacy.mask_sensitive_values,
        maxResultRows: config.policies.warehouse.max_result_rows,
      })
    : ({
        mode: "default-deny" as const,
        requireApprovalFor: ["warehouse_write", "pr_open", "ticket_update"],
        prohibit: ["direct_push_to_protected_branch"],
        maskSensitiveValues: true,
        maxResultRows: 10000,
      });

  const ok = !checks.some((c) => c.status === "fail");

  return { checks, providers, policyMode, recommendedNext: next, ok };
}
