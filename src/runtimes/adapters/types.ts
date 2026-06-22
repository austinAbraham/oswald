/**
 * Runtime adapter contract.
 *
 * An adapter teaches a specific agent runtime (Claude Code, Codex, Gemini CLI,
 * Cursor, Windsurf, or the generic CLI fallback) how to drive Oswald. Adapters
 * are GENERATED ASSETS, not forks: `install()` writes command-prompt files and
 * setup docs into the project's artifact dir; nothing about Oswald's core
 * behavior changes per runtime.
 *
 * Design rules:
 *  - Adapters never write secrets. MCP/API configuration is documented as a
 *    HOW-TO that points at the runtime's official docs; the user supplies keys.
 *  - Adapters declare their capabilities HONESTLY via `supportsFeature()`.
 *  - `detect()` is best-effort and side-effect free.
 *  - All file writes go under `<root>/<artifactDir>/runtime/<id>/` unless the
 *    runtime has a conventional location AND the user opts in via install opts.
 */

/** Capabilities a runtime may (or may not) support. */
export type RuntimeFeature =
  /** Native slash-command palette (e.g. Claude Code `/command`). */
  | "slash-commands"
  /** Sub-agent / agent-definition files. */
  | "agents"
  /** Lifecycle hooks (pre/post tool, etc.). */
  | "hooks"
  /** Model Context Protocol server configuration. */
  | "mcp";

/** Options passed to install/uninstall/render. */
export interface AdapterInstallOptions {
  /** Project root (absolute). */
  root: string;
  /** Artifact dir relative to root, e.g. ".oswald". */
  artifactDir: string;
  /** Overwrite existing files when true. Default: false (skip + report). */
  force?: boolean;
  /** Project name, used in generated headers. */
  projectName?: string;
}

/** A single file an adapter would write, as a (relative path, content) pair. */
export interface RenderedFile {
  /**
   * Path relative to the project ROOT (not the artifact dir). Adapters that
   * target the artifact dir return paths like ".oswald/runtime/<id>/...".
   */
  path: string;
  /** Full UTF-8 file contents. */
  content: string;
}

/** Result of an install/uninstall operation. */
export interface InstallResult {
  /** Adapter id that ran. */
  runtime: string;
  /** Absolute paths written. */
  written: string[];
  /** Absolute paths skipped because they exist and `force` was not set. */
  skipped: string[];
}

/**
 * A runtime adapter. `render*` methods are pure (compute file contents);
 * `install`/`uninstall` perform IO using those rendered files.
 */
export interface RuntimeAdapter {
  /** Stable identifier, e.g. "generic", "claude-code". */
  readonly id: string;
  /** Human-readable name for docs/logs. */
  readonly displayName: string;
  /** One-line description of the adapter's posture. */
  readonly description: string;

  /** Best-effort, side-effect-free detection of this runtime in the environment. */
  detect(root?: string): Promise<boolean> | boolean;

  /** Whether this runtime supports a given capability. Must be honest. */
  supportsFeature(feature: RuntimeFeature): boolean;

  /** Render the per-command prompt files. Pure. */
  renderCommands(options: AdapterInstallOptions): RenderedFile[];

  /**
   * Render agent-definition files. Pure. Returns [] when the runtime does not
   * support agents (or this adapter does not provide any).
   */
  renderAgents(options: AdapterInstallOptions): RenderedFile[];

  /**
   * Render hook-definition files. Pure. Returns [] when unsupported/unprovided.
   */
  renderHooks(options: AdapterInstallOptions): RenderedFile[];

  /**
   * Render any setup / HOW-TO docs (e.g. MCP configuration). Pure. Never
   * contains secrets. Returns [] when there is nothing to document.
   */
  renderDocs(options: AdapterInstallOptions): RenderedFile[];

  /** Write all rendered files to disk, honoring `force`. */
  install(options: AdapterInstallOptions): Promise<InstallResult>;

  /** Remove files this adapter installs (best-effort). */
  uninstall(options: AdapterInstallOptions): Promise<InstallResult>;
}
