import * as path from "node:path";
import { promises as fs } from "node:fs";
import { BaseAdapter, renderCommandPromptBody, runtimeDir } from "./base.js";
import { OSWALD_COMMANDS } from "../commands.js";
import type {
  AdapterInstallOptions,
  RenderedFile,
  RuntimeFeature,
} from "./types.js";

const MCP_DOCS_URL =
  "https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md";

/**
 * Gemini CLI adapter.
 *
 * Writes command-prompt files plus a setup doc that references the Gemini CLI
 * MCP documentation. Gemini CLI supports MCP servers; it does not provide
 * Claude-style agent/hook files, so only `mcp` is declared. Gemini CLI does
 * support custom commands, but Oswald ships portable command-prompt files
 * rather than a Gemini-specific command format, so `slash-commands` is left off.
 */
export class GeminiCliAdapter extends BaseAdapter {
  readonly id = "gemini-cli";
  readonly displayName = "Gemini CLI";
  readonly description =
    "Command-prompt files + a Gemini CLI MCP setup doc. MCP supported; no Claude-style agents / hooks.";

  protected readonly features: ReadonlySet<RuntimeFeature> = new Set<RuntimeFeature>(
    ["mcp"],
  );

  /** Detect via GEMINI env vars or a .gemini/ project dir. */
  async detect(root?: string): Promise<boolean> {
    if (process.env.GEMINI_CLI || process.env.GEMINI_API_KEY) return true;
    if (root) {
      try {
        await fs.access(path.join(root, ".gemini"));
        return true;
      } catch {
        /* fall through */
      }
    }
    return false;
  }

  renderCommands(options: AdapterInstallOptions): RenderedFile[] {
    const cmdDir = path.join(runtimeDir(options.artifactDir, this.id), "commands");
    return OSWALD_COMMANDS.map((cmd) => ({
      path: path.join(cmdDir, `${cmd.name}.md`),
      content: renderCommandPromptBody(cmd, options.projectName),
    }));
  }

  override renderDocs(options: AdapterInstallOptions): RenderedFile[] {
    const base = runtimeDir(options.artifactDir, this.id);
    return [
      {
        path: path.join(base, "MCP-SETUP.md"),
        content: [
          "# Gemini CLI + Oswald MCP setup",
          "",
          "Oswald is MCP-native. Configure the MCP servers Gemini CLI should use",
          "(warehouse, ticketing, repo) per the official Gemini CLI MCP docs. Oswald",
          "never stores secrets; you supply credentials through Gemini CLI's config.",
          "",
          `Reference: ${MCP_DOCS_URL}`,
          "",
          "## Steps",
          "",
          "1. Configure MCP servers in Gemini CLI (typically via its settings.json).",
          "2. Provide credentials via Gemini CLI config / environment — never in",
          "   Oswald-generated files.",
          "3. Run `oswald doctor`, then `oswald intake <ticket-id>`.",
          "",
          "## Note",
          "",
          "Drive Oswald by running the CLI commands described in `commands/`.",
          "",
        ].join("\n"),
      },
    ];
  }
}
