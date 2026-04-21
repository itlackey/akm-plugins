# agentikit-claude

Claude Code plugin for the [Agentikit](https://github.com/itlackey/agentikit) CLI. Provides a skill that teaches Claude to **search**, **show**, **discover registry kits**, **dispatch agents**, and **execute commands** from stash directories and registries.

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
- **Claude hooks** — SessionStart ensures the latest `akm-cli@latest` is available, and Claude hook events record user/system feedback plus memory-related usage in local state logs

The skill teaches Claude to:

- **Search & show** assets via `akm search` and `akm show`
- **Search the registry** for installable kits via `akm search --source registry` and install them with `akm add`
- **Dispatch stash agents** dynamically — Claude fetches an agent's markdown definition (prompt, toolPolicy, modelHint) and spawns a subagent on the fly with those instructions embedded
- **Execute stash commands** — Claude resolves a command template, renders `$ARGUMENTS`/`$1`/`$2` placeholders, and executes the result
- **Run scripts** — Claude fetches a script via `akm show`, extracts the `run` field, and executes it directly

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

### Registry discovery

Ask Claude to find installable kits from the community registry:

```
Find an agentikit kit for code review and install the best match
```

Claude will search with `akm search ... --source registry`, inspect the returned `id` and `action` fields, and then use `akm add` when you ask it to install a result.

### Limitations vs OpenCode plugin

- **modelHint** is advisory only — Claude Code does not support per-subagent model selection
- **toolPolicy** is embedded as natural-language guidance in the subagent prompt, not enforced at the runtime level

## Prerequisites

On session start, the plugin tries to install or refresh `akm-cli@latest` with Bun first and npm as a fallback so Claude uses the latest available AKM release when possible. If `akm` is already on PATH, the plugin reuses it. The standalone installers remain available when you want to preinstall manually.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1

# Or via Bun / npm
bun install -g akm-cli@latest
npm install -g akm-cli@latest
```

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

## Hooks

The Claude plugin registers these hooks:

- **SessionStart** — installs or refreshes `akm-cli@latest` and records the resolved CLI path in a local session log
- **UserPromptSubmit** — records user feedback prompts and memory-related intent in local state logs when relevant
- **PostToolUse** / **PostToolUseFailure** — records system feedback for `akm` Bash invocations and tracks memory refs used by those commands

## Docs

- [Agentikit CLI](https://github.com/itlackey/agentikit)
- [Claude Code Plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
