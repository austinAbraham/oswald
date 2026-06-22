# Oswald runtime adapters

Oswald is runtime-agnostic. The same CLI and pipeline run anywhere; a **runtime
adapter** teaches a specific agent runtime how to drive Oswald by generating
command-prompt files (and, where supported, slash commands, agent definitions,
hooks, and an MCP setup HOW-TO).

Adapters are **generated assets, not forks** — running `oswald init --runtime
<id>` writes templates under `.oswald/runtime/<id>/`. Oswald never changes its
core behavior per runtime, and **never writes secrets**: MCP/API credentials are
documented as a HOW-TO pointing at each runtime's official docs, and you supply
the keys through the runtime's own configuration.

## Install

```bash
oswald init --runtime <generic|claude-code|codex|gemini-cli|cursor|windsurf>
# default runtime is "generic"
# --force        overwrite existing files
# --artifact-dir override the .oswald artifact directory
```

Unknown runtime ids fall back to `generic` with a warning.

## Support matrix

| Runtime      | Status         | Detection                          | Slash cmds | Agents | Hooks | MCP | What you get |
|--------------|----------------|-------------------------------------|:----------:|:------:|:-----:|:---:|--------------|
| `generic`    | **Supported**  | always available                    | –          | –      | –     | –   | Command-prompt `.md` per command + index README |
| `claude-code`| **Supported**  | `CLAUDECODE` env / `.claude/` dir   | ✅         | ✅     | ✅    | ✅  | Skills (`.claude/skills/oswald-<cmd>/SKILL.md`), an agent definition, a hooks scaffold, MCP-SETUP HOW-TO; `--install` writes into `.claude/` |
| `codex`      | **Supported**  | `CODEX*` env / `.codex/` dir        | –          | –      | –     | ✅  | Command-prompt `.md` per command + Codex MCP setup doc |
| `gemini-cli` | **Supported**  | `GEMINI_*` env / `.gemini/` dir     | –          | –      | –     | ✅  | Command-prompt `.md` per command + Gemini CLI MCP setup doc |
| `cursor`     | **Scaffolded** | `CURSOR*` env / `.cursor/` dir      | –          | –      | –     | ✅* | Detection + command docs + README noting scaffolded support |
| `windsurf`   | **Scaffolded** | `WINDSURF*` env / `.windsurf|.codeium/` dir | –  | –      | –     | ✅* | Detection + command docs + README noting scaffolded support |

Legend: ✅ supported by the adapter today · – not provided by this adapter ·
✅* the runtime supports MCP, but Oswald does **not** auto-configure it — see the
generated README.

The "Slash cmds / Agents / Hooks / MCP" columns are exactly what each adapter's
`supportsFeature()` reports, so the matrix and the code never drift.

## Per-runtime detail

### Generic CLI (`generic`) — Supported
The always-available fallback. Writes a command-prompt markdown file for each of
the 15 Oswald commands under `.oswald/runtime/generic/commands/<command>.md`,
plus a `README.md` index. Each file explains what the command does and how to
invoke the CLI (`oswald <command>`, or `npx oswald …` / `node dist/cli/index.js
…` when the binary is not on PATH). Works in any shell or runtime.

### Claude Code (`claude-code`) — Supported
Generates modern Claude Code **skills** — a directory per command with YAML
frontmatter (`name`, `description`, `disable-model-invocation: true` to keep them
user-invoked only) at `skills/oswald-<command>/SKILL.md` — plus an
`agents/oswald-analyst.md` agent definition, a `hooks/README.md` scaffold, and
`MCP-SETUP.md` referencing <https://code.claude.com/docs/en/mcp>. No secrets are
written.

By default skills/agents are staged under `.oswald/runtime/claude-code/`. To make
the commands actually appear in Claude Code, run with `--install`:

```bash
oswald init --runtime claude-code --install
```

This writes the skills to `.claude/skills/oswald-<command>/SKILL.md` and the agent
to `.claude/agents/oswald-analyst.md` directly. Restart Claude Code so the new
skills and agent load, then invoke them as `/oswald-intake`, `/oswald-context`,
etc. Reference docs (`hooks/README.md`, `MCP-SETUP.md`) always stay staged under
`.oswald/runtime/claude-code/` since Claude Code does not auto-load them.

### OpenAI Codex (`codex`) — Supported
Writes portable command-prompt files plus `MCP-SETUP.md` referencing
<https://developers.openai.com/codex/mcp>. Declares MCP support only — it does
**not** assume any Claude-specific features (no slash commands, agents, or hooks).

### Gemini CLI (`gemini-cli`) — Supported
Writes command-prompt files plus `MCP-SETUP.md` referencing the Gemini CLI MCP
docs. Declares MCP support only; no Claude-style agents or hooks.

### Cursor (`cursor`) — Scaffolded
Best-effort detection plus generated command docs and a `README.md` that is
honest that support is scaffolded. Cursor supports MCP, but Oswald does not
auto-configure it — follow Cursor's docs and supply credentials yourself. Use
Oswald today by running the CLI commands directly.

### Windsurf (`windsurf`) — Scaffolded
Same posture as Cursor: detection + command docs + a scaffolded-support README.
Configure Windsurf's MCP integration yourself; Oswald writes no secrets.

## Generated layout

```
.oswald/runtime/<id>/
  commands/<command>.md             # one per Oswald command (generic/codex/gemini/scaffold)
  skills/oswald-<cmd>/SKILL.md      # claude-code skills (staged; --install → .claude/skills/)
  agents/oswald-analyst.md          # claude-code only (staged; --install → .claude/agents/)
  hooks/…                           # claude-code only (always staged)
  MCP-SETUP.md                      # claude-code/codex/gemini-cli (always staged)
  README.md                         # generic + scaffold index/notes
```

With `--install`, claude-code skills and agents are written into `.claude/`
instead of the staged paths above:

```
.claude/
  skills/oswald-<cmd>/SKILL.md   # one per Oswald command
  agents/oswald-analyst.md       # the oswald-analyst subagent
```

## Adding a new adapter

Implement the `RuntimeAdapter` interface (`src/runtimes/adapters/types.ts`) —
extending `BaseAdapter` gives you the shared install/uninstall IO for free — then
register it in `src/runtimes/adapters/registry.ts`. Declare `supportsFeature()`
honestly and keep all credential handling out of generated files.
