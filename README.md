# Agentikit Plugins

Platform-specific plugins for the [Agentikit](https://github.com/itlackey/agentikit) CLI. Both packages wrap the `akm` CLI to **search**, **show**, **dispatch agents**, and **execute commands** from a stash directory.

## Packages

### agentikit-claude

Claude Code plugin providing a skill for stash asset management, dynamic agent dispatch, and command execution.

Add the marketplace and install the plugin:

```sh
# Add the Agentikit marketplace
/plugin marketplace add itlackey/agentikit-plugins

# Install the plugin
/plugin install agentikit
```

Or via the Claude CLI:

```sh
claude plugin marketplace add itlackey/agentikit-plugins
claude plugin install agentikit@agentikit-plugins
```

Provides:
- **Agentikit Skill** — Claude automatically uses the akm CLI when you ask about stash assets
- **Dynamic agent dispatch** — Claude fetches agent definitions from the stash and spawns subagents on the fly with the agent's prompt, tool constraints, and task
- **Command execution** — Claude resolves command templates, renders argument placeholders (`$ARGUMENTS`, `$1`, `$2`), and executes the result

### agentikit-opencode

OpenCode plugin registering tools that call the akm CLI.

```sh
npm install agentikit-opencode
```

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["agentikit-opencode"]
}
```

Provides four tools:
- `akm_search` — search the stash
- `akm_show` — show a stash asset by ref
- `akm_index` — build/rebuild the search index
- `akm_agent` — dispatch stash `agent:*` resources into OpenCode sessions
- `akm_cmd` — execute stash `command:*` templates through OpenCode SDK sessions

## Stash model

Set a stash path via `AGENTIKIT_STASH_DIR`:

```sh
export AGENTIKIT_STASH_DIR=/abs/path/to/your-stash
```

Expected layout:

```
$AGENTIKIT_STASH_DIR/
├── tools/      # executable scripts (.sh, .ts, .js, .ps1, .cmd, .bat)
├── skills/     # skill directories containing SKILL.md
├── commands/   # markdown files
├── agents/     # markdown files
└── knowledge/  # markdown files
```

## Prerequisites

The `akm` CLI must be installed and available on PATH. Install it from the [agentikit repo](https://github.com/itlackey/agentikit). If not available on PATH, the agent will install it when needed.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1
```

## Docs

- **Agentikit CLI**: [github.com/itlackey/agentikit](https://github.com/itlackey/agentikit)
- **OpenCode**: [Plugins](https://opencode.ai/docs/plugins/) · [Custom tools](https://opencode.ai/docs/custom-tools/)
- **Claude Code**: [Plugins](https://code.claude.com/docs/en/plugins) · [Skills](https://code.claude.com/docs/en/skills)
