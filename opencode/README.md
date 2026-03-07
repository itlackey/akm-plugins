# agentikit-opencode

OpenCode plugin for the [Agentikit](https://github.com/itlackey/agentikit) CLI. Registers tools that let your AI agent **search**, **open**, and **run** extension assets from a stash directory.

## Installation

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["agentikit-opencode"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `agentikit_search` | Search the stash for tools, skills, commands, agents, and knowledge |
| `agentikit_open` | Open a stash asset by its ref |
| `agentikit_run` | Run a tool by its ref |
| `agentikit_index` | Build or rebuild the search index |

## Prerequisites

The `agentikit` CLI must be installed and available on PATH. Install it from the [agentikit repo](https://github.com/itlackey/agentikit).

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1
```

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

## Docs

- [Agentikit CLI](https://github.com/itlackey/agentikit)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
