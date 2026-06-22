import * as path from "node:path";
import { pathExists, writeText } from "../../utils/fs.js";
import { promises as fs } from "node:fs";
import type {
  AdapterInstallOptions,
  InstallResult,
  RenderedFile,
  RuntimeAdapter,
  RuntimeFeature,
} from "./types.js";
import { OSWALD_COMMANDS, type CommandSpec } from "../commands.js";

/**
 * Shared base for adapters. Concrete adapters supply id/metadata, a feature
 * set, detection, and the render functions; this base provides the generic
 * install/uninstall IO that honors `force` and reports written/skipped paths.
 */
export abstract class BaseAdapter implements RuntimeAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly description: string;

  /** Capabilities this adapter honestly supports. */
  protected abstract readonly features: ReadonlySet<RuntimeFeature>;

  abstract detect(root?: string): Promise<boolean> | boolean;

  abstract renderCommands(options: AdapterInstallOptions): RenderedFile[];

  supportsFeature(feature: RuntimeFeature): boolean {
    return this.features.has(feature);
  }

  /** Default: no agents. Override if the runtime supports them. */
  renderAgents(_options: AdapterInstallOptions): RenderedFile[] {
    return [];
  }

  /** Default: no hooks. Override if the runtime supports them. */
  renderHooks(_options: AdapterInstallOptions): RenderedFile[] {
    return [];
  }

  /** Default: no docs. Override to emit setup / HOW-TO docs. */
  renderDocs(_options: AdapterInstallOptions): RenderedFile[] {
    return [];
  }

  /** All files this adapter would write, in a stable order. */
  protected allRendered(options: AdapterInstallOptions): RenderedFile[] {
    return [
      ...this.renderCommands(options),
      ...this.renderAgents(options),
      ...this.renderHooks(options),
      ...this.renderDocs(options),
    ];
  }

  async install(options: AdapterInstallOptions): Promise<InstallResult> {
    const written: string[] = [];
    const skipped: string[] = [];
    for (const file of this.allRendered(options)) {
      const abs = path.resolve(options.root, file.path);
      if (!options.force && (await pathExists(abs))) {
        skipped.push(abs);
        continue;
      }
      await writeText(abs, file.content);
      written.push(abs);
    }
    return { runtime: this.id, written, skipped };
  }

  async uninstall(options: AdapterInstallOptions): Promise<InstallResult> {
    const written: string[] = [];
    const skipped: string[] = [];
    for (const file of this.allRendered(options)) {
      const abs = path.resolve(options.root, file.path);
      if (await pathExists(abs)) {
        await fs.rm(abs, { force: true });
        written.push(abs);
      } else {
        skipped.push(abs);
      }
    }
    return { runtime: this.id, written, skipped };
  }
}

/** Base directory (relative to root) where an adapter writes its assets. */
export function runtimeDir(artifactDir: string, id: string): string {
  return path.join(artifactDir, "runtime", id);
}

/**
 * Render a generic command-prompt markdown body for one command. Reused by the
 * generic adapter and by runtimes whose "command" is just a prompt file.
 */
export function renderCommandPromptBody(
  cmd: CommandSpec,
  projectName: string | undefined,
): string {
  const lines: string[] = [
    `# oswald ${cmd.name}`,
    "",
    cmd.summary,
    "",
    "## What this does",
    "",
    cmd.details,
    "",
    "## How to invoke",
    "",
    "```bash",
    cmd.invoke,
    "```",
    "",
    "If `oswald` is not on your PATH, use `npx oswald …` or " +
      "`node dist/cli/index.js …` from the project root.",
    "",
  ];
  if (projectName) {
    lines.push(`> Project: ${projectName}`, "");
  }
  return lines.join("\n");
}

/** The canonical command list (re-export for convenience). */
export { OSWALD_COMMANDS };
