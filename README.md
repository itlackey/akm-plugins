# Agentikit Plugins

Platform-specific plugins for the [Agentikit](https://github.com/itlackey/agentikit) CLI. Both packages are thin wrappers that call the `akm` CLI to **search** and **show** extension assets from a stash directory.

## Packages

### agentikit-claude

Claude Code plugin providing a skill and slash commands.

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

Provides three tools:
- `agentikit_search` — search the stash
- `agentikit_show` — show a stash asset by ref
- `agentikit_index` — build/rebuild the search index

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
