import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildRegistry,
  runtimeIds,
  getAdapter,
  resolveAdapter,
  detectAdapter,
  GENERIC_RUNTIME_ID,
} from "../../../src/runtimes/adapters/registry.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtime adapter registry", () => {
  it("registers all six adapters by id", () => {
    const ids = runtimeIds();
    expect(ids).toEqual(
      expect.arrayContaining([
        "generic",
        "claude-code",
        "codex",
        "gemini-cli",
        "cursor",
        "windsurf",
      ]),
    );
    expect(ids).toHaveLength(6);
  });

  it("getAdapter returns the adapter for a known id and undefined otherwise", () => {
    expect(getAdapter("generic")?.id).toBe("generic");
    expect(getAdapter("claude-code")?.id).toBe("claude-code");
    expect(getAdapter("nope")).toBeUndefined();
  });

  it("each adapter exposes id/displayName/description and honest features", () => {
    const registry = buildRegistry();

    // Generic: no native integration features.
    const generic = registry.get("generic")!;
    expect(generic.supportsFeature("slash-commands")).toBe(false);
    expect(generic.supportsFeature("mcp")).toBe(false);

    // Claude Code: the full feature set.
    const cc = registry.get("claude-code")!;
    expect(cc.supportsFeature("slash-commands")).toBe(true);
    expect(cc.supportsFeature("agents")).toBe(true);
    expect(cc.supportsFeature("hooks")).toBe(true);
    expect(cc.supportsFeature("mcp")).toBe(true);

    // Codex / Gemini: mcp only, no Claude features.
    for (const id of ["codex", "gemini-cli"]) {
      const a = registry.get(id)!;
      expect(a.supportsFeature("mcp")).toBe(true);
      expect(a.supportsFeature("slash-commands")).toBe(false);
      expect(a.supportsFeature("agents")).toBe(false);
      expect(a.supportsFeature("hooks")).toBe(false);
    }

    // Scaffolds: mcp declared, no agents/hooks.
    for (const id of ["cursor", "windsurf"]) {
      const a = registry.get(id)!;
      expect(a.supportsFeature("mcp")).toBe(true);
      expect(a.supportsFeature("agents")).toBe(false);
      expect(a.displayName.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveAdapter", () => {
  it("resolves a known id without fallback", () => {
    const r = resolveAdapter("claude-code");
    expect(r.adapter.id).toBe("claude-code");
    expect(r.fellBack).toBe(false);
    expect(r.requested).toBe("claude-code");
  });

  it("falls back to generic for unknown ids", () => {
    const r = resolveAdapter("totally-unknown");
    expect(r.adapter.id).toBe(GENERIC_RUNTIME_ID);
    expect(r.fellBack).toBe(true);
    expect(r.requested).toBe("totally-unknown");
  });

  it("falls back to generic for empty/nullish ids", () => {
    expect(resolveAdapter(undefined).adapter.id).toBe(GENERIC_RUNTIME_ID);
    expect(resolveAdapter(null).adapter.id).toBe(GENERIC_RUNTIME_ID);
    expect(resolveAdapter("").adapter.id).toBe(GENERIC_RUNTIME_ID);
    expect(resolveAdapter("  ").adapter.id).toBe(GENERIC_RUNTIME_ID);
  });
});

describe("detectAdapter", () => {
  it("falls back to generic when nothing is detected", async () => {
    // Ensure no runtime env markers leak in from the host.
    for (const v of [
      "CLAUDECODE",
      "CLAUDE_CODE",
      "CODEX",
      "CODEX_HOME",
      "GEMINI_CLI",
      "GEMINI_API_KEY",
      "CURSOR",
      "CURSOR_TRACE_ID",
      "WINDSURF",
      "WINDSURF_SESSION",
    ]) {
      vi.stubEnv(v, "");
    }
    const adapter = await detectAdapter("/nonexistent-oswald-root");
    expect(adapter.id).toBe(GENERIC_RUNTIME_ID);
  });

  it("detects claude-code from the CLAUDECODE env var", async () => {
    vi.stubEnv("CLAUDECODE", "1");
    const adapter = await detectAdapter("/nonexistent-oswald-root");
    expect(adapter.id).toBe("claude-code");
  });
});
