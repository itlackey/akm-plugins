# akm-opencode

OpenCode plugin for the [AKM](https://github.com/itlackey/akm) CLI (v0.5.0+). Registers tools that let your AI agent **search**, **show**, and **manage** stash assets — skills, commands, agents, knowledge, memories, scripts, workflows, vaults, and wikis — plus **agentic hooks** that auto-load relevant assets into each turn, record feedback when assets are used, and harvest session memories so the stash improves with every session.

## Installation

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["akm-opencode"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `akm_search` | Search the local stash, the registry, or both. Type filter accepts `skill`, `command`, `agent`, `knowledge`, `memory`, `script`, `workflow`, `vault`, `wiki`, `any` |
| `akm_registry_search` | Search configured registries for installable kits and optional asset-level hits |
| `akm_show` | Show a stash asset by its ref |
| `akm_index` | Build or rebuild the search index |
| `akm_agent` | Dispatch a stash `agent:*` into OpenCode using the stash prompt and metadata |
| `akm_cmd` | Execute a stash `command:*` template in OpenCode via SDK session prompting |
| `akm_add` | Install kits or register external sources from npm, GitHub, git URLs, URLs, or local dirs (use `type: "wiki"` to register a wiki; `writable`, `trust`, `max_pages`, `max_depth`, `provider`, `options` also supported) |
| `akm_list` | List configured AKM sources |
| `akm_remove` | Remove a configured AKM source and reindex |
| `akm_update` | Update one managed source or all managed sources |
| `akm_clone` | Clone an asset into the working stash or a custom destination for editing |
| `akm_remember` | Record a memory in the default stash |
| `akm_feedback` | Record positive or negative feedback for a stash asset (skipped automatically for `memory:` and `vault:` refs) |
| `akm_config` | Get, set, unset, list, or inspect akm configuration (including `config path --all`) |
| `akm_run` | Execute a stash script using its `run` field |
| `akm_sources` | Backward-compatible alias that lists configured AKM sources |
| `akm_upgrade` | Check for or install akm CLI updates |
| `akm_curate` | Curate the stash for a task or topic and return ranked matches the agent can use |
| `akm_evolve` | Dispatch the AKM curator agent to review recent session activity and propose stash improvements |
| `akm_save` | Commit (and push, when writable) pending changes in a git-backed stash |
| `akm_import` | Import a file (or stdin content) into the stash as a typed asset |
| `akm_vault` | Manage vaults (`list`, `show`, `create`, `set`, `unset`, `shell_snippet`). **Values never surface** — `show`/`list` return key names only. `shell_snippet` returns opaque `eval` text |
| `akm_wiki` | Manage wikis (`create`, `register`, `list`, `show`, `pages`, `search`, `stash`, `lint`, `ingest`, `remove`) |
| `akm_workflow` | Drive workflow runs (`start`, `next`, `complete`, `status`, `list`, `create`, `template`, `resume`) |

## Compound-engineering hooks

The plugin subscribes to OpenCode lifecycle events so AKM participates in the
session loop instead of waiting to be called. Every hook is non-blocking and
fails silently when `akm` is not on PATH — the TUI is never affected.

| Event | What happens |
| --- | --- |
| **`session.created`** (event hook) | Warms the stash index in the background and caches `akm hints` for the next system transform so the agent knows the CLI surface area at turn 0. |
| **`chat.message`** | Runs `akm curate "<prompt>"` on each user message (prompts shorter than `AKM_CURATE_MIN_CHARS` are skipped). The top matches are stored for injection. Memory intents (prompts mentioning "remember" / "memory") are tracked in the session buffer. |
| **`experimental.chat.system.transform`** | Appends the cached hints (once per session) and the curated context (once per turn) to the model's system prompt so the agent sees relevant stash assets before answering. |
| **`tool.execute.after`** (`akm_*` tools) | Logs asset usage, accumulates refs into the session buffer, and records `akm feedback <ref> --positive` / `--negative` automatically based on whether the tool succeeded or failed. Never recurses into `akm_feedback` and skips `memory:` refs. |
| **`stop`** / **`session.idle`** / **`session.compacted`** / **`session.deleted`** | Flushes the per-session buffer into a `memory:opencode-session-YYYYMMDD-<sid>` memory so every meaningful session contributes durable context for future searches. Requires at least two observations before persisting. |

### Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_AUTO_CURATE` | `1` | Set to `0` to disable automatic `akm curate` on user messages. |
| `AKM_AUTO_FEEDBACK` | `1` | Set to `0` to disable automatic `akm feedback` on tool success/failure. |
| `AKM_AUTO_HINTS` | `1` | Set to `0` to skip injecting `akm hints` at session start. |
| `AKM_AUTO_MEMORY` | `1` | Set to `0` to disable automatic session-summary memories. |
| `AKM_CURATE_LIMIT` | `5` | Max curated results injected into context per prompt. |
| `AKM_CURATE_MIN_CHARS` | `16` | Minimum prompt length before curation runs. |
| `AKM_CURATE_TIMEOUT` | `8` | Wall-clock seconds for `akm` invocations inside hooks. |

### Curator agent

`akm_evolve` dispatches a child OpenCode session running a built-in curator
prompt that reviews recent AKM activity (OpenCode app logs, session-summary
memories, live stash) and produces a prioritized action list: hot assets to
promote, cold ones to investigate, coverage gaps to draft, duplicates to
consolidate. The curator never applies destructive changes without explicit
user approval.

### Registry discovery

Use either:

- `akm_search` with `source: "registry"` or `source: "both"`
- `akm_registry_search` when you only want installable community kits

Registry hits include `id`, `installRef`, and `action` fields. Use `installRef` when passing a result into `akm_add`; registry-specific IDs are not installable refs. Use `assets: true` when you also want asset-level matches from registry v2 indexes.

## Agent Dispatch

Use `akm_agent` after retrieving an agent ref from `akm_search`.

Inputs:
- `ref` (optional): stash ref like `agent:coach.md`
- `query` (optional): resolve best matching stash agent when `ref` is omitted
- `task_prompt` (required): user task to run
- `dispatch_agent` (optional): OpenCode agent name (defaults to `general`)
- `as_subtask` (optional): create child session (defaults to `true`)

At least one of `ref` or `query` is required.

Behavior:
- Loads the stash agent via `akm show`
- Uses stash `prompt` verbatim as OpenCode `system`
- Applies stash `modelHint` when in `provider/model` format
- Applies stash `toolPolicy` when it maps to boolean tool flags

## Command Execution

Use `akm_cmd` to execute stash command templates through the OpenCode SDK.

Inputs:
- `ref` (optional): stash ref like `command:review.md`
- `query` (optional): resolve best matching stash command when `ref` is omitted
- `arguments` (optional): raw command arguments for `$ARGUMENTS`, `$1`, `$2`, etc.
- `dispatch_agent` (optional): OpenCode agent name (defaults to current agent)
- `as_subtask` (optional): create child session (defaults to `false`)

At least one of `ref` or `query` is required.

## Prerequisites

When the plugin loads, it runs `bun install -g akm-cli@latest` so it always picks up the latest published npm package. It then prefers the Bun-installed binary and falls back to an existing `akm` on PATH when needed. It does not run the standalone shell installers automatically.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/akm/main/install.ps1 -OutFile install.ps1; ./install.ps1

# Or via Bun
bun install -g akm-cli@latest
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
├── knowledge/  # markdown files
├── memories/   # markdown memory files (akm remember)
├── workflows/  # multi-step procedures (workflow:<name>)
├── vaults/     # .env secret stores (vault:<name>) — values never surface through structured output
└── wikis/      # per-wiki directories <name>/{schema,index,log}.md + raw/ + pages
```

## Vaults

`akm_vault` is the one tool in this plugin with a hard contract on output. The
AKM CLI itself guarantees vault values never appear in JSON, the search index,
`.stash.json`, or any structured output channel. This plugin mirrors that:

- `action: "list"` / `"show"` return key names and comments only.
- `action: "set"` / `"unset"` never echo the value.
- `action: "shell_snippet"` wraps `akm vault load` and returns the raw shell
  text as-is. Treat it as opaque and hand it straight to a shell via
  `eval "$(…)"` — do not log it, do not pass it through another tool, and do
  not let the agent inspect it.

Automatic feedback recording (`tool.execute.after`) skips `vault:*` refs so
that usage signals can't leak which vault was touched.

Assets are resolved from three source types: **working** (local stash), **search paths** (additional dirs via `searchPaths` config), and **installed** (registry kits via `akm add`).

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
