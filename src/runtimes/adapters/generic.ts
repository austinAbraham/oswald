import * as path from "node:path";
import { BaseAdapter, renderCommandPromptBody, runtimeDir } from "./base.js";
import { OSWALD_COMMANDS } from "../commands.js";
import type {
  AdapterInstallOptions,
  RenderedFile,
  RuntimeFeature,
} from "./types.js";

/**
 * Generic CLI adapter — the always-available fallback.
 *
 * It writes a command-prompt markdown file for each of the 15 Oswald commands
 * under `<artifactDir>/runtime/generic/commands/<command>.md`, plus an index
 * README. These describe what each command does and how to invoke the Oswald
 * CLI directly. No runtime-specific assumptions; works anywhere a shell does.
 */
export class GenericAdapter extends BaseAdapter {
  readonly id = "generic";
  readonly displayName = "Generic CLI";
  readonly description =
    "Plain command-prompt files describing each Oswald command and how to run the CLI. Works in any runtime.";

  // The generic adapter assumes no native integration features.
  protected readonly features: ReadonlySet<RuntimeFeature> = new Set();

  /** Always available. */
  detect(): boolean {
    return true;
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
      content: this.renderIndex(options),
    });

    return files;
  }

  private renderIndex(options: AdapterInstallOptions): string {
    const lines: string[] = [
      "# Oswald commands (generic runtime)",
      "",
      "These prompt files describe how to drive Oswald from any agent or shell.",
      "Run the underlying CLI with `oswald <command>` (or `npx oswald …`).",
      "",
    ];
    if (options.projectName) {
      lines.push(`Project: ${options.projectName}`, "");
    }
    const groups: Array<["operator" | "pipeline" | "maintenance", string]> = [
      ["operator", "Operator / setup"],
      ["pipeline", "Pipeline (workflow order)"],
      ["maintenance", "Maintenance & navigation"],
    ];
    for (const [group, heading] of groups) {
      lines.push(`## ${heading}`, "");
      for (const cmd of OSWALD_COMMANDS.filter((c) => c.group === group)) {
        lines.push(`- [\`${cmd.name}\`](./commands/${cmd.name}.md) — ${cmd.summary}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
}
