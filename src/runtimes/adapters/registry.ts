import { GenericAdapter } from "./generic.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { GeminiCliAdapter } from "./gemini-cli.js";
import { createCursorAdapter, createWindsurfAdapter } from "./scaffold.js";
import type { RuntimeAdapter } from "./types.js";

/** The id of the always-available fallback adapter. */
export const GENERIC_RUNTIME_ID = "generic";

/**
 * Build the registry of all known runtime adapters. A fresh map is returned per
 * call so adapters never share mutable state across processes/tests.
 */
export function buildRegistry(): Map<string, RuntimeAdapter> {
  const adapters: RuntimeAdapter[] = [
    new GenericAdapter(),
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new GeminiCliAdapter(),
    createCursorAdapter(),
    createWindsurfAdapter(),
  ];
  const map = new Map<string, RuntimeAdapter>();
  for (const a of adapters) {
    map.set(a.id, a);
  }
  return map;
}

/** All adapter ids, generic first. */
export function runtimeIds(): string[] {
  return [...buildRegistry().keys()];
}

/** Get an adapter by id, or undefined if unknown. */
export function getAdapter(id: string): RuntimeAdapter | undefined {
  return buildRegistry().get(id);
}

/**
 * Resolve the adapter to use for a requested id. Unknown/empty ids fall back to
 * the generic adapter. Returns the resolved adapter and whether a fallback
 * happened (so callers can warn).
 */
export function resolveAdapter(id?: string | null): {
  adapter: RuntimeAdapter;
  requested: string;
  fellBack: boolean;
} {
  const registry = buildRegistry();
  const requested = (id ?? "").trim() || GENERIC_RUNTIME_ID;
  const found = registry.get(requested);
  if (found) {
    return { adapter: found, requested, fellBack: false };
  }
  return {
    adapter: registry.get(GENERIC_RUNTIME_ID)!,
    requested,
    fellBack: true,
  };
}

/**
 * Best-effort auto-detection: probe every non-generic adapter's `detect()` and
 * return the first that matches, else the generic adapter. Detection is
 * side-effect free; on any error an adapter is treated as not-detected.
 */
export async function detectAdapter(root?: string): Promise<RuntimeAdapter> {
  const registry = buildRegistry();
  for (const [id, adapter] of registry) {
    if (id === GENERIC_RUNTIME_ID) continue;
    try {
      if (await adapter.detect(root)) return adapter;
    } catch {
      /* treat detection failure as not-detected */
    }
  }
  return registry.get(GENERIC_RUNTIME_ID)!;
}
