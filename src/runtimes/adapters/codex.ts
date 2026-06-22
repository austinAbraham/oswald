import * as path from "node:path";
import { promises as fs } from "node:fs";
import { BaseAdapter, renderCommandPromptBody, runtimeDir } from "./base.js";
import { OSWALD_COMMANDS } from "../commands.js";
import type {
  AdapterInstallOptions,
  RenderedFile,
  RuntimeFeature,
} from "./types.js";

const MCP_DOCS_URL = "https://developers.openai.com/codex/mcp";

/**
 * OpenAI Codex adapter.
 *
 * Codex does not expose Claude-style slash commands or agent/hook files, so
 * this adapter writes plain command-prompt files plus an MCP setup doc that
 * points at the official Codex MCP docs. It declares only `mcp` support.
 * Does NOT assume any Claude features.
 */
export class CodexAdapter extends BaseAdapter {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex";
  readonly description =
    "Command-prompt files + a Codex MCP setup doc. MCP supported; no native slash commands / agents / hooks.";

  protected readonly features: ReadonlySet<RuntimeFeature> = new Set<RuntimeFeature>(
    ["mcp"],
  );

  /** Detect via CODEX env vars or a .codex/ project dir. */
  async detect(root?: string): Promise<boolean> {
    if (process.env.CODEX || process.env.CODEX_HOME) return true;
    if (root) {
      try {
        await fs.access(path.join(root, ".codex"));
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
          "# Codex + Oswald MCP setup",
          "",
          "Oswald is MCP-native. Configure the MCP servers Codex should use (warehouse,",
          "ticketing, repo) per the official Codex docs. Oswald never stores secrets;",
          "you supply credentials through Codex's own configuration.",
          "",
          `Reference: ${MCP_DOCS_URL}`,
          "",
          "## Steps",
          "",
          "1. Configure MCP servers in Codex per the docs above.",
          "2. Provide credentials via Codex's config / environment — never in",
          "   Oswald-generated files.",
          "3. Run `oswald doctor`, then `oswald intake <ticket-id>`.",
          "",
          "## Note",
          "",
          "Codex has no Claude-style slash commands, agents, or hooks. Drive Oswald by",
          "running the CLI commands described in `commands/`.",
          "",
        ].join("\n"),
      },
    ];
  }
}
