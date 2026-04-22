# akm-claude

Claude Code plugin for the [AKM](https://github.com/itlackey/akm) CLI. Provides a skill that teaches Claude to **search**, **show**, **discover registry kits**, **dispatch agents**, and **execute commands** from stash directories and registries — plus **agentic hooks** that auto-load relevant assets, record memories, and feed asset-usage feedback back into the stash so it improves with every session.

## Installation

Add the marketplace and install the plugin:

```sh
# Add the AKM marketplace
/plugin marketplace add itlackey/akm-plugins

# Install the plugin
/plugin install akm
```

Or via the Claude CLI:

```sh
claude plugin marketplace add itlackey/akm-plugins
claude plugin install akm@akm-plugins
```

## What's included

- **AKM Skill** — Claude automatically uses the `akm` CLI when you ask about stash assets
- **Agentic hooks** — lifecycle hooks that install `akm`, auto-curate stash matches into every user prompt, auto-record feedback when assets are used, and harvest session memories at stop/compact time
- **Slash commands** — `/akm-curate`, `/akm-remember`, `/akm-feedback`, `/akm-evolve` for explicit control of the compound-engineering loop
- **`akm-curator` agent** — a self-evolution subagent that reviews session logs and proposes stash improvements

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
Find an akm kit for code review and install the best match
```

Claude will search with `akm search ... --source registry`, inspect the returned `id` and `action` fields, and then use `akm add` when you ask it to install a result.

### Limitations vs OpenCode plugin

- **modelHint** is advisory only — Claude Code does not support per-subagent model selection
- **toolPolicy** is embedded as natural-language guidance in the subagent prompt, not enforced at the runtime level

## Prerequisites

On session start, the plugin tries to install or refresh `akm-cli@latest` with Bun first and npm as a fallback so Claude uses the latest available AKM release when possible. If `akm` is already on PATH, the plugin reuses it. The standalone installers remain available when you want to preinstall manually.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/akm/main/install.ps1 -OutFile install.ps1; ./install.ps1

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

The Claude plugin registers these hooks. Each one runs automatically on the
corresponding Claude Code event and is non-blocking — if `akm` is not on PATH
or the CLI call fails, the hook exits silently without affecting the session.

| Event | What happens |
| --- | --- |
| **SessionStart** | Installs/refreshes `akm-cli@latest` (Bun → npm fallback), warms the stash index in the background, and injects `akm hints` into the model context so Claude knows the CLI surface area at turn 0. |
| **UserPromptSubmit** | Runs `akm curate "<prompt>"` and injects the top matches as `additionalContext` so Claude sees relevant stash assets before answering. Short prompts (under `AKM_CURATE_MIN_CHARS` chars, default 16) are skipped. Also records `remember`/`memory` intents to the session buffer. |
| **PostToolUse** (Bash, success) | Logs `akm` Bash invocations, harvests any `type:name` asset refs from command+output, and calls `akm feedback <ref> --positive` so successful usage boosts ranking. |
| **PostToolUseFailure** (Bash) | Same as above but records `--negative` feedback with the failure note. |
| **Stop** / **SubagentStop** | Flushes the per-session buffer into a `memory:claude-session-YYYYMMDD-<sid>` memory so every meaningful session contributes durable context for future searches. |
| **PreCompact** | Same memory capture before Claude Code compacts the transcript, so learnings survive compaction. |

### Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_AUTO_FEEDBACK` | `1` | Set to `0` to disable automatic `akm feedback` on tool success/failure. |
| `AKM_AUTO_MEMORY` | `1` | Set to `0` to disable automatic session-summary memories. |
| `AKM_CURATE_LIMIT` | `5` | Max curated results injected into context per prompt. |
| `AKM_CURATE_MIN_CHARS` | `16` | Minimum prompt length before curation runs. |
| `AKM_CURATE_TIMEOUT` | `8` | Wall-clock seconds for `akm` invocations inside hooks. |
| `AKM_PLUGIN_STATE_DIR` | `$XDG_STATE_HOME/akm-claude` | Where session logs and per-session buffers live. |

### Slash commands

- `/akm-curate <task>` — manually curate stash assets for a topic and load them.
- `/akm-remember [slug]` — distill the current conversation into a durable memory.
- `/akm-feedback <ref> <+|-> [note]` — record explicit feedback on an asset.
- `/akm-evolve [focus]` — dispatch the `akm-curator` agent to review session logs and propose stash improvements (promote hot assets, flag cold ones, draft missing coverage).

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [Claude Code Plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
