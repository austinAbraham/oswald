import * as path from "node:path";
import { promises as fs } from "node:fs";
import { BaseAdapter, renderCommandPromptBody, runtimeDir } from "./base.js";
import { OSWALD_COMMANDS } from "../commands.js";
import type {
  AdapterInstallOptions,
  RenderedFile,
  RuntimeFeature,
} from "./types.js";

/** Config for a scaffold-level adapter (Cursor / Windsurf). */
export interface ScaffoldAdapterConfig {
  id: string;
  displayName: string;
  description: string;
  /** Env vars whose presence indicates this runtime. */
  envVars: string[];
  /** Project-dir markers (e.g. ".cursor") whose presence indicates this runtime. */
  dirMarkers: string[];
  /** URL for the runtime's MCP / setup docs, referenced in the README. */
  docsUrl: string;
  /** Features honestly supported by the runtime (used for the README note). */
  features: RuntimeFeature[];
}

/**
 * Scaffold adapter for runtimes whose Oswald support is intentionally partial.
 *
 * It does the FUNCTIONAL parts that are safe and portable — detection (where
 * feasible) and generated command-prompt files — and writes a README that is
 * HONEST that integration beyond the CLI is scaffolded, not complete.
 */
export class ScaffoldAdapter extends BaseAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  protected readonly features: ReadonlySet<RuntimeFeature>;
  private readonly cfg: ScaffoldAdapterConfig;

  constructor(cfg: ScaffoldAdapterConfig) {
    super();
    this.cfg = cfg;
    this.id = cfg.id;
    this.displayName = cfg.displayName;
    this.description = cfg.description;
    this.features = new Set(cfg.features);
  }

  async detect(root?: string): Promise<boolean> {
    for (const v of this.cfg.envVars) {
      if (process.env[v]) return true;
    }
    if (root) {
      for (const marker of this.cfg.dirMarkers) {
        try {
          await fs.access(path.join(root, marker));
          return true;
        } catch {
          /* keep trying */
        }
      }
    }
    return false;
  }

  renderCommands(options: AdapterInstallOptions): RenderedFile[] {
    const base = runtimeDir(options.artifactDir, this.id);
    const cmdDir = path.join(base, "commands");
    const files: RenderedFile[] = OSWALD_COMMANDS.map((cmd) => ({
      path: path.join(cmdDir, `${cmd.name}.md`),
      content: renderCommandPromptBody(cmd, options.projectName),
    }));
    files.push({
      path: path.join(base, "README.md"),
      content: this.renderReadme(),
    });
    return files;
  }

  private renderReadme(): string {
    const supported =
      this.features.size > 0
        ? [...this.features].map((f) => `\`${f}\``).join(", ")
        : "none beyond the CLI";
    return [
      `# Oswald + ${this.displayName} (SCAFFOLDED)`,
      "",
      `Support for ${this.displayName} is **scaffolded**, not complete.`,
      "",
      "## What works now",
      "",
      "- Best-effort detection of the runtime.",
      "- Generated command-prompt files (in `commands/`) describing each Oswald",
      "  command and how to invoke the CLI.",
      "",
      "## What is scaffolded / not yet wired",
      "",
      `- Native integration (${supported}) is NOT auto-configured by Oswald.`,
      `- Configure MCP servers and any runtime-native command palette yourself,`,
      `  following the runtime's docs: ${this.cfg.docsUrl}`,
      "- Oswald never writes secrets; you supply credentials via the runtime.",
      "",
      "## Use today",
      "",
      "Drive Oswald by running the CLI commands in `commands/` directly",
      "(`oswald <command>` / `npx oswald …`).",
      "",
    ].join("\n");
  }
}

/** Cursor scaffold adapter. */
export function createCursorAdapter(): ScaffoldAdapter {
  return new ScaffoldAdapter({
    id: "cursor",
    displayName: "Cursor",
    description:
      "Scaffold: detection + generated command docs + a README that support is scaffolded. MCP supported by Cursor (configure yourself).",
    envVars: ["CURSOR_TRACE_ID", "CURSOR"],
    dirMarkers: [".cursor"],
    docsUrl: "https://docs.cursor.com/context/model-context-protocol",
    features: ["mcp"],
  });
}

/** Windsurf scaffold adapter. */
export function createWindsurfAdapter(): ScaffoldAdapter {
  return new ScaffoldAdapter({
    id: "windsurf",
    displayName: "Windsurf",
    description:
      "Scaffold: detection + generated command docs + a README that support is scaffolded. MCP supported by Windsurf (configure yourself).",
    envVars: ["WINDSURF", "WINDSURF_SESSION"],
    dirMarkers: [".windsurf", ".codeium"],
    docsUrl: "https://docs.windsurf.com/windsurf/cascade/mcp",
    features: ["mcp"],
  });
}
