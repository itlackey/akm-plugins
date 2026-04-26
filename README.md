# AKM Plugins

Platform-specific plugins for the [AKM](https://github.com/itlackey/akm) CLI (v0.5.0+). Both packages wrap the `akm` CLI to **search**, **show**, **dispatch agents**, **execute commands**, **drive workflows**, **manage wikis**, and **access vaults** from a stash directory.

## OpenCode

OpenCode plugin that registers tools that call the akm CLI.

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["akm-opencode"]
}
```

Provides a trimmed surface of fourteen tools (down from twenty-six in 0.5.x — shipped in commit `9f9620f`). Verbs that are no longer first-class tools (`save`, `import`, `clone`, `update`, `remove`, `list`-sources, `registry-search`, `reindex`, `config`, `upgrade`, `run`, vault writes) are now discoverable through the new `akm_help` tool, which surfaces a curated quick-reference and falls back to live `akm --help` so agents can compose the right CLI invocation and run it via shell:
- `akm_search` — search the stash, the registry, or both (including `workflow`, `vault`, and `wiki` types)
- `akm_show` — show a stash asset by ref
- `akm_agent` — dispatch stash `agent:*` resources into OpenCode sessions
- `akm_workflow` — drive workflow runs (`start`, `next`, `complete`, `status`, `list`, `create`, `template`, `resume`)
- `akm_remember` — record a memory in the default stash
- `akm_cmd` — execute stash `command:*` templates through OpenCode SDK sessions
- `akm_vault` — vault `list`, `show` (key names), and `load` (shell-eval snippet for value injection). `show`/`list` never echo values; writes (`set`, `unset`, `create`) go through raw `akm vault …`
- `akm_curate` — curate stash assets for a task or topic
- `akm_evolve` — dispatch the AKM curator subagent (review session activity, propose stash improvements, persist the report as a memory)
- `akm_wiki` — manage wikis (`create`, `register`, `list`, `show`, `pages`, `search`, `stash`, `lint`, `ingest`, `remove`)
- `akm_feedback` — record positive or negative feedback for a stash asset
- `akm_session_messages` — summarize a specific OpenCode session (restricted for arbitrary session IDs)
- `akm_parent_messages` — summarize the parent OpenCode session for dispatched stash subagents
- `akm_help` — quick-reference table for non-first-class `akm` verbs, with live `akm --help` fallback

The OpenCode plugin also hooks `chat.message`, `tool.execute.before`, `tool.execute.after`, `experimental.session.compacting`, and `shell.env` to gate destructive actions, preserve context through compaction, and record user/system feedback and memory usage in OpenCode app logs when relevant.


### Claude Code

Claude Code plugin providing a skill for stash asset management, dynamic agent dispatch, and command execution.

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

Provides:
- **AKM Skill** — Claude automatically uses the akm CLI when you ask about stash assets
- **Trimmed slash-command surface (12 verbs)** — `/akm-search`, `/akm-show`, `/akm-agent`, `/akm-cmd`, `/akm-curate`, `/akm-remember`, `/akm-feedback`, `/akm-evolve`, `/akm-wiki`, `/akm-workflow`, `/akm-vault` (`list`/`show`/`load`), and `/akm-help`
- **`/akm-help` discovery flow** — for verbs no longer first-class (save, import, clone, update, remove, list-sources, registry-search, reindex, config, upgrade, run-script, vault writes), `/akm-help <task>` surfaces a curated quick-reference and falls back to live `akm --help` so Claude can compose the right `akm` invocation and run it via Bash
- **Dynamic agent dispatch** — Claude fetches agent definitions from the stash and spawns subagents on the fly with the agent's prompt, tool constraints, and task
- **Command execution** — Claude resolves command templates, renders argument placeholders (`$ARGUMENTS`, `$1`, `$2`), and executes the result
- **Claude hooks** — the plugin refreshes `akm-cli@latest` on session start and records relevant user/system feedback and memory usage events in local state logs

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
├── knowledge/  # markdown files
├── memories/   # markdown memory files (akm remember)
├── workflows/  # multi-step procedures (workflow:<name>)
├── vaults/     # .env secret stores (vault:<name>) — values never surface through structured output
└── wikis/      # per-wiki directories <name>/{schema,index,log}.md + raw/ + pages
```

Assets are resolved from three source types: **working** (local stash), **search paths** (additional dirs via `searchPaths` config), and **installed** (registry kits via `akm add`).

## Configuration

Config is stored at `~/.config/akm/config.json` (XDG standard). Use `akm config list` to view, `akm config set <key> <value>` to update.

## Prerequisites

For OpenCode, the plugin checks the installed `akm` version first and only runs `bun install -g akm-cli@latest` when `akm` is missing or older than the latest stable npm release. Newer pre-releases and local builds are left in place. The plugin then prefers the Bun-installed binary and falls back to an existing `akm` on PATH when needed. It does not run the standalone shell installers automatically.

For Claude Code, the plugin uses a `SessionStart` hook to refresh `akm-cli@latest` with Bun first and npm as a fallback, then records hook-driven feedback and memory activity in local state logs during relevant prompt and Bash events.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/akm/main/install.ps1 -OutFile install.ps1; ./install.ps1

# Or via Bun
bun install -g akm-cli@latest
```

## Docs

- **AKM CLI**: [github.com/itlackey/akm](https://github.com/itlackey/akm)
- **OpenCode**: [Plugins](https://opencode.ai/docs/plugins/) · [Custom tools](https://opencode.ai/docs/custom-tools/)
- **Claude Code**: [Plugins](https://code.claude.com/docs/en/plugins) · [Skills](https://code.claude.com/docs/en/skills)
