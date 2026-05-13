# akm-claude

Claude Code plugin for the [AKM](https://github.com/itlackey/akm) CLI (v0.8.0+). Provides a skill that teaches Claude to **search**, **show**, **discover registry kits**, **dispatch agents**, **execute commands**, **drive workflows**, **manage wikis**, **handle vaults safely**, **operate the v0.8.0 proposal queue**, and **improve assets** — plus **agentic hooks** that auto-load relevant assets, record memories, surface pending proposals, and feed asset-usage feedback back into the stash so it improves with every session. `akm setup` remains human-facing and should be run manually when needed.

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
- **Agentic hooks** — lifecycle hooks that install `akm`, set `agent.default` to `claude` in `~/.config/akm/config.json` when it is missing, auto-curate stash matches into every user prompt, auto-record feedback when assets are used (skipping proposed-quality drafts and `lesson:*` refs), surface pending-proposal counts in the SessionStart header, and harvest session memories at stop/compact time
- **Slash commands** — 17 first-class verbs (`/akm-search`, `/akm-show`, `/akm-agent`, `/akm-cmd`, `/akm-curate`, `/akm-remember`, `/akm-feedback`, `/akm-evolve`, `/akm-wiki`, `/akm-workflow`, `/akm-vault`, `/akm-proposal`, `/akm-review-proposals`, `/akm-improve`, `/akm-propose`, `/akm-setup`, `/akm-help`) for explicit control of the compound-engineering loop
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
├── knowledge/  # markdown files
├── memories/   # markdown memory files (akm remember)
├── lessons/    # first-class durable learnings (lesson:<name>) — often produced via akm improve, accepted via akm accept
├── workflows/  # multi-step procedures (workflow:<name>)
├── vaults/     # .env secret stores (vault:<name>) — values never surface through structured output
├── wikis/      # per-wiki directories <name>/{schema,index,log}.md + raw/ + pages
└── .akm/proposals/  # v0.8.0 proposal queue — drafts that never leak into search or commits
```

Assets are resolved from three source types: **working** (local stash), **search paths** (additional dirs via `searchPaths` config), and **installed** (registry kits via `akm add`).

## Hooks

The Claude plugin registers these hooks. Each one runs automatically on the
corresponding Claude Code event and is non-blocking — if `akm` is not on PATH
or the CLI call fails, the hook exits silently without affecting the session.

| Event | What happens |
| --- | --- |
| **SessionStart** | Installs/refreshes `akm-cli@latest` (override via `AKM_PACKAGE_REF`; Bun → npm fallback), sets `agent.default` to `claude` in `~/.config/akm/config.json` when it is missing, surfaces the configured agent CLI plus any pending-proposal count in the injected header, warms the stash index in the background, injects `akm hints`, and runs a scoped `akm curate --run <session_id>` so Claude gets relevant stash context before the first user message. Human users should run `akm setup` manually when interactive setup is needed. |
| **UserPromptSubmit** | Runs `akm curate "<prompt>" --run <session_id>` and injects the top matches as `additionalContext` so Claude sees relevant stash assets before answering. Short prompts (under `AKM_CURATE_MIN_CHARS` chars, default 16) are skipped. Also records `remember`/`memory` intents to the session buffer. |
| **UserPromptExpansion** | Logs expanded `/akm-*` slash-command usage, injects a short reminder when a mutating memory/proposal command is expanded without explicit confirmation language, and takes a fresh proposal-prep checkpoint before `/akm-improve`, `/akm-evolve`, or `/akm-propose` when the local session buffer has unflushed evidence. |
| **PreToolUse** (Bash) | Blocks risky raw AKM shell commands before execution, including proposal acceptance without explicit approval and suspicious `akm remember` payloads that appear to contain secrets. |
| **PostToolUse** (Bash, success) | Logs `akm` Bash invocations, harvests any `type:name` asset refs (including `lesson:*`) from command+output, and calls `akm feedback <ref> --positive` so successful usage boosts ranking. Skips `memory:*`, `vault:*`, `lesson:*`, and any ref the indexer reports as `quality:"proposed"`. |
| **PostToolUseFailure** (Bash) | Same as above but records `--negative` feedback with the failure note. |
| **PostToolBatch** | Records grouped tool-batch observations as structured events and appends a short batch summary to the local session buffer for later checkpoint extraction. |
| **SubagentStart** | Injects concise AKM subagent context, including the detected role, task preview, and any active workflow summary. |
| **Stop** / **SubagentStop** | Flushes the per-session buffer into a `memory:claude-session-YYYYMMDD-<sid>` memory so every meaningful session contributes durable context for future searches. Session memories now include explicit paths to the local state, buffer, event/candidate logs, and optional harness log plus higher-value evidence aggregates so follow-on improve agents can inspect the full artifacts directly. When `AKM_INDEX_ON_SESSION_END=1`, the hook follows that flush with `akm index` so upstream inference/graph passes run immediately. |
| **TaskCreated** / **TaskCompleted** | Records task lifecycle events, appends task summaries to the local session buffer, and lets completed-task summaries feed candidate extraction through the normal checkpoint/session flush path. |
| **PreCompact** | Same memory capture before Claude Code compacts the transcript, with the same optional post-flush `akm index` run when `AKM_INDEX_ON_SESSION_END=1`. |
| **PostCompact** | Records the compacted summary as a structured event and buffers a short post-compaction note for later recall. |
| **SessionEnd** | Reuses the session-final memory capture path so Claude can flush the final checkpoint even when `Stop` is not the last lifecycle event observed. |

### Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_PACKAGE_REF` | `akm-cli@latest` | Override the npm/bun package spec used by SessionStart auto-install (e.g. pin to `akm-cli@0.7.0` in CI). |
| `AKM_AUTO_FEEDBACK` | `1` | Set to `0` to disable automatic `akm feedback` on tool success/failure. |
| `AKM_AUTO_MEMORY` | `1` | Set to `0` to disable automatic session-summary memories. |
| `AKM_INDEX_ON_SESSION_END` | `0` | Set to `1` to run `akm index` after a session-end memory is captured. |
| `AKM_CURATE_LIMIT` | `5` | Max curated results injected into context per prompt. |
| `AKM_CURATE_MIN_CHARS` | `16` | Minimum prompt length before curation runs. |
| `AKM_CURATE_TIMEOUT` | `8` | Wall-clock seconds for `akm` invocations inside hooks. |
| `AKM_CONTEXT_BUDGET_CHARS` | `4000` | Max total characters injected into `additionalContext` for a single hook fire. |
| `AKM_PLUGIN_STATE_DIR` | `$XDG_STATE_HOME/akm-claude` | Where session logs and per-session buffers live. Also holds the `setup.stamp` and `quality-cache.tsv` files. |
| `AKM_SCOPE_KEYS` | `user,agent,run,channel` | Comma-separated list of scope fields to attach on every `akm curate`, `akm feedback`, and `akm remember` CLI call. Remove a key to opt out of that dimension (e.g. `run,channel` to omit user/agent). |
| `AKM_USER_ID` | _(unset)_ | User identifier forwarded as `--user` on scoped calls. Set in your shell environment or Claude Code settings for multi-user deployments. |
| `AKM_AGENT_ID` | _(unset)_ | Agent identifier forwarded as `--agent` on scoped calls. |
| `AKM_CHANNEL` | _(unset)_ | Channel or variant name forwarded as `--channel` on scoped calls (e.g. a PR branch name or pipeline stage). |

### Slash commands

The plugin ships 18 first-class verbs. `/akm-add` and `/akm-save` are not part of the slash-command surface — both `akm add` and `akm save` are reachable via `/akm-help` (see "When to use what" below).

- `/akm-search <query> [flags]` — run `akm search` directly from Claude.
- `/akm-show <ref> [view args]` — inspect a stash asset by ref.
- `/akm-agent <agent-ref-or-query> [task]` — resolve and dispatch a stash agent through the AKM skill flow.
- `/akm-cmd <command-ref-or-query> [args]` — resolve and execute a stash command template through the AKM skill flow.
- `/akm-curate <task>` — manually curate stash assets for a topic and load them.
- `/akm-remember [slug]` — distill the current conversation into a durable memory.
- `/akm-feedback <ref> <+|-> [note]` — record explicit feedback on an asset.
- `/akm-evolve [focus]` — dispatch the `akm-curator` agent to review session logs and propose stash improvements.
- `/akm-wiki <subcommand> [args]` — manage AKM wikis (create, register, list, show, pages, search, stash, lint, ingest, remove).
- `/akm-workflow <subcommand> [args]` — drive workflow runs (start, next, complete, status, list, create, resume, template).
- `/akm-vault <list|show|load> [ref]` — vault read paths: enumerate vaults, show key names, or emit a shell-eval `load` snippet. `show`/`list` never echo values; `load` output is opaque shell text meant for `eval` and is never displayed back in chat.
- `/akm-proposal <list|show|diff|accept|reject> [id] [--reason "..."]` — operate the v0.8.0 proposal queue. Always confirms with the user before `accept`/`reject`.
- `/akm-review-proposals [--limit N]` — list every pending proposal and diff each one in a single pass for review.
- `/akm-improve [type|ref] [--task "..."] [--dry-run]` — generate improvement proposals for the stash, a type, or a specific ref.
- `/akm-propose <type> <name> --task "..."` — generate a new-asset proposal via the configured agent CLI.
- `/akm-setup` — run the interactive `akm setup` wizard. It can configure `agent.default`, which is required for improve/propose.
- `/akm-help [task]` — surface a curated quick-reference for non-first-class `akm` verbs and fall back to live `akm --help`.

### When to use what

- **Prefer the 18 slash commands above** for the verbs they cover — they wire the AKM skill flow, hooks, and feedback loop together for you.
- **For everything else** — `add` (install kits / register sources), `save`, `import`, `clone`, `update`, `remove`, `list` (sources), `registry-search`, `reindex`, `config`, `upgrade`, `run-script`, raw `agent` (one-shot agent shell-out), and vault writes (`create`, `set`, `unset`) — call `/akm-help <task>` first to discover the right `akm` CLI invocation, then run it via Bash.
- **Vault writes still bypass the chat turn entirely.** `/akm-vault` is read-only for displayed output (`list` and `show` of key names; `load` produces shell-eval text that must be piped to `eval` rather than displayed); to create vaults or set/unset values, run `akm vault …` in the shell directly so secret values never pass through the chat turn.

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [Claude Code Plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
