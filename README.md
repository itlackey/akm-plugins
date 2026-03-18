# Agent-i-Kit Plugins

Platform-specific plugins for the [Agent-i-Kit](https://github.com/itlackey/agentikit) CLI. Both packages wrap the `akm` CLI to **search**, **show**, **dispatch agents**, and **execute commands** from a stash directory.

## OpenCode

OpenCode plugin that registers tools that call the akm CLI.

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["akm-opencode"]
}
```

Provides fifteen tools:
- `akm_search` — search the stash, the registry, or both
- `akm_registry_search` — search configured registries for installable kits and optional asset hits
- `akm_show` — show a stash asset by ref
- `akm_index` — build/rebuild the search index
- `akm_agent` — dispatch stash `agent:*` resources into OpenCode sessions
- `akm_cmd` — execute stash `command:*` templates through OpenCode SDK sessions
- `akm_add` — install kits from npm, GitHub, git URLs, or local directories
- `akm_list` — list installed registry kits
- `akm_remove` — remove an installed registry kit
- `akm_update` — update one or all installed registry kits
- `akm_clone` — clone an asset into the working stash or another destination
- `akm_config` — get, set, unset, list, or inspect akm configuration paths
- `akm_run` — execute a stash script via the `run` field
- `akm_sources` — list all resolved stash search paths
- `akm_upgrade` — check for or install akm CLI updates


### Claude Code

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

### All Other Agents

For Codex, Co-Pilot, Cursor, QwenCLI, and any system that uses AGENTS.md or instruction files, you can simply drop in the [AGENTS.md](./AGENTS.md) or copy the content into the appropriate location for your platform.

## Stash model

The stash directory is resolved automatically via a three-tier fallback: `AKM_STASH_DIR` env var (optional override) → `stashDir` in `config.json` → platform default. Set it persistently with:

```sh
akm config set stashDir /abs/path/to/your-stash
```

Expected layout:

```
stash/
├── scripts/    # executable scripts (.sh, .ts, .js, .ps1, .cmd, .bat, .py, .rb, .go, .pl, .php, .lua, .r, .swift, .kt)
├── skills/     # skill directories containing SKILL.md
├── commands/   # markdown files
├── agents/     # markdown files
└── knowledge/  # markdown files
```

Assets are resolved from three source types: **working** (local stash), **search paths** (additional dirs via `searchPaths` config), and **installed** (registry kits via `akm add`).

## Configuration

Config is stored at `~/.config/akm/config.json` (XDG standard). Use `akm config list` to view, `akm config set <key> <value>` to update.

## Prerequisites

For OpenCode, the plugin installs `akm-cli@latest` with `bun install -g` when the plugin loads. It then prefers the Bun-installed binary and falls back to an existing `akm` on PATH when needed. It does not run the standalone shell installers automatically.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1

# Or via Bun
bun install -g akm-cli@latest
```

## Docs

- **Agentikit CLI**: [github.com/itlackey/agentikit](https://github.com/itlackey/agentikit)
- **OpenCode**: [Plugins](https://opencode.ai/docs/plugins/) · [Custom tools](https://opencode.ai/docs/custom-tools/)
- **Claude Code**: [Plugins](https://code.claude.com/docs/en/plugins) · [Skills](https://code.claude.com/docs/en/skills)
