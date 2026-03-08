# agentikit-claude

Claude Code plugin for the [Agentikit](https://github.com/itlackey/agentikit) CLI. Provides a skill that teaches Claude to **search**, **show**, **dispatch agents**, and **execute commands** from a stash directory.

## Installation

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

## What's included

- **Agentikit Skill** — Claude automatically uses the `akm` CLI when you ask about stash assets

The skill teaches Claude to:

- **Search & show** assets via `akm search` and `akm show`
- **Dispatch stash agents** dynamically — Claude fetches an agent's markdown definition (prompt, toolPolicy, modelHint) and spawns a subagent on the fly with those instructions embedded
- **Execute stash commands** — Claude resolves a command template, renders `$ARGUMENTS`/`$1`/`$2` placeholders, and executes the result

### Dynamic agent dispatch

Ask Claude to dispatch any agent from your stash:

```
Dispatch the coach agent to review src/auth.ts
```

Claude will resolve the agent ref, fetch its prompt and metadata via `akm show`, compose a subagent with the agent's persona, and execute the task autonomously.

### Command execution

Ask Claude to run any command template from your stash:

```
Run the review command on src/main.ts --strict
```

Claude will fetch the command template, render argument placeholders, and execute the result.

### Limitations vs OpenCode plugin

- **modelHint** is advisory only — Claude Code does not support per-subagent model selection
- **toolPolicy** is embedded as natural-language guidance in the subagent prompt, not enforced at the runtime level

## Prerequisites

The `akm` CLI must be installed and available on PATH. Install it from the [agentikit repo](https://github.com/itlackey/agentikit).

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
- [Claude Code Plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
