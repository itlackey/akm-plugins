# akm-opencode

OpenCode plugin for the [AKM](https://github.com/itlackey/akm) CLI (v0.8.0+). Registers tools that let your AI agent **search**, **show**, and **manage** stash assets — skills, commands, agents, knowledge, memories, lessons, scripts, workflows, vaults, and wikis — **operate the v0.8.0 proposal queue** and **improve assets** through dedicated tools, plus **agentic hooks** that auto-load relevant assets into each turn, record feedback when assets are used (skipping proposed-quality drafts), and harvest session memories so the stash improves with every session.

## Installation

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["akm-opencode"]
}
```

## Tools

The plugin exposes **19 high-value tools**. Long-tail verbs (`add`, `save`, `import`, `clone`, `update`, `remove`, `list`-sources, `registry-search`, `index`-reindex, `config`, `upgrade`, `tasks`, ad-hoc `run`, raw `agent`) are reachable via `akm_help` plus the raw `akm` CLI through the `bash` tool.

| Tool | Description |
|------|-------------|
| `akm_info` | Show `akm info` output together with the installed `akm-opencode` plugin version and install location |
| `akm_search` | Search the local stash, the registry, or both. Type filter accepts `skill`, `command`, `agent`, `knowledge`, `lesson`, `memory`, `script`, `workflow`, `vault`, `wiki`, `any`; proposed hits can be included explicitly |
| `akm_show` | Show a stash asset by its ref |
| `akm_agent` | Dispatch a stash `agent:*` into OpenCode using the stash prompt and metadata |
| `akm_cmd` | Execute a stash `command:*` template in OpenCode via SDK session prompting |
| `akm_remember` | Record a memory in the default stash |
| `akm_feedback` | Record positive or negative feedback for a stash asset (skipped automatically for `memory:`, `vault:`, `lesson:`, and proposed-quality refs) |
| `akm_curate` | Curate the stash for a task or topic and return ranked matches the agent can use |
| `akm_evolve` | Dispatch the AKM curator subagent into a child session, capture the report as a memory, and seed the curator-context cache so it survives compaction |
| `akm_parent_messages` | Summarize the parent OpenCode session so dispatched stash subagents can inherit upstream context |
| `akm_session_messages` | Summarize a specific OpenCode session (arbitrary IDs restricted to `akm-curator`) |
| `akm_vault` | Vault `list` / `show` (key names) / `create` / `set` / `unset` / `load` (opaque shell-eval text). **Values never surface** through `list`/`show`; `load` output is meant for `eval` and must not be displayed back |
| `akm_wiki` | Manage wikis (`create`, `register`, `list`, `show`, `pages`, `search`, `stash`, `lint`, `ingest`, `remove`) |
| `akm_workflow` | Drive workflow runs (`start`, `next`, `complete`, `status`, `list`, `create`, `template`, `resume`) |
| `akm_proposal` | Operate the v0.8.0 proposal queue (`list` / `show` / `diff` / `accept` / `reject`). Always confirm with the user before `accept`/`reject` — those operations require explicit approval |
| `akm_improve` | Generate improvement proposals for an existing ref, a whole asset type, or the current stash scope; output lands in the proposal queue only |
| `akm_propose` | Generate a new-asset proposal via the configured agent CLI; the result is `quality:"proposed"` until accepted |
| `akm_init` | Initialize AKM's working stash directory and persist `stashDir` in config. This is the agent-safe initialization path; interactive `akm setup` is human-facing |
| `akm_help` | Discover the right `akm` CLI invocation for non-first-class verbs. Returns a curated quick-reference table plus live `akm <subcommand> --help` output |

## Compound-engineering hooks

The plugin subscribes to OpenCode lifecycle events so AKM participates in the
session loop instead of waiting to be called. Every hook is non-blocking and
fails silently when a compatible `akm` is not resolvable — the TUI is never affected.

| Event | What happens |
| --- | --- |
| **`session.created`** (event hook) | Sets the AKM default agent in `~/.config/akm/config.json` to `opencode` when missing, warms the stash index in the background, caches `akm hints` plus active workflow status, and runs a scoped `akm curate --run <sessionID>` so fresh sessions start with relevant stash context. |
| **`chat.message`** | Records user feedback/memory intent and appends a short reminder to use `akm_search` / `akm_curate` when more stash context is needed. It does not auto-run AKM CLI lookups on every message. |
| **`experimental.chat.system.transform`** | Appends cached hints, active workflow state, pending proposal summaries, the last curator report, and the current prompt's curated context to the model's system prompt. Hints and workflow state are re-injected after transcript compaction. |
| **`tool.execute.before`** (`akm_*` tools) | Blocks destructive or sensitive operations on the plugin's own typed tools (`akm_vault show`, `akm_proposal accept`, etc.) until `confirm:true` is provided. This contract is per-tool, not a generic shell-command gate. |
| **`tool.execute.after`** (`akm_*` tools) | Logs asset usage, accumulates refs into the session buffer, records `akm feedback <ref> --positive` / `--negative` asynchronously with per-call dedupe, checkpoints memories every `AKM_MEMORY_CHECKPOINT_EVERY` successful asset-touching tool calls, and scans child-agent free text for additional refs. |
| **`experimental.session.compacting`** | Pushes hints, curated context, active workflows, and the last curator report into the compaction prompt so they survive transcript shrinking. |
| **`shell.env`** | Exposes `AKM_PROJECT`, `AKM_PLUGIN_VERSION`, and the resolved `AKM_STASH_DIR` to shell tools so raw shell checks and plain `akm` invocations see the same stash path as the plugin. |
| **`stop`** / **`session.idle`** / **`session.compacted`** / **`session.deleted`** | Flushes the per-session buffer into a `memory:opencode-session-YYYYMMDD-<sid>` memory so every meaningful session contributes durable context for future searches. The persisted memory now includes compact event/candidate summaries plus explicit file paths to the full-detail plugin state and OpenCode host logs so `akm improve` can inspect deeper evidence when needed. Requires at least two observations before persisting. When `AKM_INDEX_ON_SESSION_END=1`, the hook follows a successful flush with `akm index` so upstream inference/graph passes run immediately. |

### Locking down destructive commands

Earlier versions of this plugin shipped `permission.ask` and
`command.execute.before` hooks that tokenized each raw `akm` CLI invocation
and **denied** a hard-coded list of risky subcommands (vault writes,
`save --push`, `accept` / `reject` / `revert`, `tasks add` / `tasks run`,
`upgrade`, `update --all`, etc.) until the user re-approved them inline.
That gate has been removed in 0.8.0. The tokenized matcher was brittle — it
produced false positives on commit messages, heredoc bodies, and other
prose that happened to contain `akm <verb>` substrings — and gating
destructive shell calls is fundamentally the host platform's job, not a
plugin's.

OpenCode does not currently expose a first-class declarative permission
DSL equivalent to Claude Code's `permissions.ask` / `permissions.deny`.
For the verbs that historically tripped the plugin's gate, lock things
down at the OS level instead:

- **Run `akm` under a wrapper script** that prompts (or denies) on the
  destructive subcommands you care about. Put the wrapper earlier on
  `PATH` than the real `akm`. For example:

  ```sh
  #!/usr/bin/env bash
  # ~/bin/akm — wraps the real akm to confirm destructive verbs
  case "$1 $2 $3" in
    "vault set "*|"vault unset "*|"vault load "*|"vault create "*|\
    "save --push"*|"remove "*|"accept "*|"reject "*|"revert "*|\
    "tasks add "*|"tasks remove "*|"tasks enable "*|"tasks disable "*|\
    "tasks run "*|"upgrade"*|"update --all"*|"config set "*)
      read -rp "Run 'akm $*' ? [y/N] " ans
      [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted"; exit 1; } ;;
  esac
  exec /usr/local/bin/akm-real "$@"
  ```

- **Use OS-level access controls** (`sudo`, `chmod`, mount restrictions,
  AppArmor / SELinux profiles) when running OpenCode in shared or
  sandboxed environments.
- **Vault writes still bypass the chat turn entirely.** Use the typed
  `akm_vault` tool only for read paths (`list`, `show` of key names,
  `load` for shell-eval pipelines). To create vaults or set/unset values,
  run `akm vault …` directly in the shell so secret values never pass
  through the chat turn.

The plugin's typed `akm_*` tools (`akm_vault show`, `akm_proposal accept`,
etc.) still apply their per-tool `confirm:true` contracts at
`tool.execute.before`. Only the raw-shell tokenized gate has been removed.

### Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_AUTO_CURATE` | `1` | Set to `0` to disable automatic `akm curate` on user messages. Session start no longer auto-curates. |
| `AKM_AUTO_FEEDBACK` | `1` | Set to `0` to disable automatic `akm feedback` on tool success/failure. |
| `AKM_AUTO_HINTS` | `1` | Set to `0` to skip injecting `akm hints` at session start. |
| `AKM_AUTO_MEMORY` | `1` | Set to `0` to disable automatic session-summary memories. |
| `AKM_INDEX_ON_SESSION_END` | `0` | Set to `1` to run `akm index` after a session-end memory is captured. |
| `AKM_CURATE_LIMIT` | `5` | Max curated results injected into context per prompt. |
| `AKM_CURATE_MIN_CHARS` | `16` | Minimum prompt length before curation runs. |
| `AKM_CURATE_TIMEOUT` | `8` | Wall-clock seconds for `akm` invocations inside hooks. |
| `AKM_CONTEXT_BUDGET_CHARS` | `4000` | Max total characters injected into system/compaction context for a single turn. |
| `AKM_CURATOR_CONTEXT_MAX_CHARS` | `4000` | Max cached curator-report characters re-injected into system/compaction context; the full report is still persisted as memory. |
| `AKM_MEMORY_CHECKPOINT_EVERY` | `8` | Number of successful asset-touching tool calls between mid-session checkpoint memories. |
| `AKM_RETROSPECTIVE_FEEDBACK_PATTERN` | `\b(thanks|perfect|worked)\b` | Case-insensitive regex used for lightweight positive retrospective feedback on the most recent refs. |
| `AKM_RETROSPECTIVE_NEGATIVE_PATTERN` | `\b(wrong|failed|broken|didn't work|did not work|bad)\b` | Case-insensitive regex used for negative retrospective feedback signals. |
| `AKM_SCOPE_KEYS` | `user,agent,run,channel` | Comma-separated list of scope fields to attach on every `akm_remember`, `akm_curate`, and `akm_feedback` call. Remove a key to opt out of that dimension. |
| `AKM_PENDING_PROPOSAL_TIMEOUT` | `2` | Seconds allowed for lightweight pending-proposal count checks during context injection. |

### Curator agent

`akm_evolve` dispatches the native `akm-curator` OpenCode subagent when it is
available, falling back to `general` with the same curator prompt when needed.
The curator reviews recent AKM activity (OpenCode app logs, session-summary
memories, parent-session context, live stash), produces a prioritized action
list, and persists its latest report as `memory:akm-curator-YYYYMMDD-<sid>` so
future curator runs can build on it.

## AKM v1 workflows

The plugin injects a concise AKM workflow instruction pack into context so agents:

- search or curate before writing from scratch;
- show an asset before relying on it;
- record feedback after the result is known;
- treat `lesson:*` as first-class durable assets;
- treat proposed-quality assets as uncurated until accepted;
- use `akm_help` to route `proposal`, `improve`, `propose`, and `tasks` CLI workflows;
- require explicit user approval before proposal acceptance/rejection, push saves, source removal, CLI upgrades, update-all, or vault value access.

The package also ships OpenCode command docs for common workflows:

- `/akm-review-proposals`
- `/akm-improve-asset`
- `/akm-propose-asset`
- `/akm-evolve-session`
- `/akm-workflow-status`

### Registry discovery

Search registries with `akm_search` using `source: "registry"` or `source: "both"`. Registry hits include `id`, `installRef`, and `action` fields. Use `installRef` when feeding a result into `akm add` (run via `akm_help` topic="add" or directly through bash); registry-specific IDs are not installable refs.

## Agent Dispatch

Use `akm_agent` after retrieving an agent ref from `akm_search`.

Inputs:
- `ref` (optional): stash ref like `agent:coach.md`
- `query` (optional): resolve best matching stash agent when `ref` is omitted
- `task_prompt` (required): user task to run
- `dispatch_agent` (optional): OpenCode agent name, or a `provider/model` override like `openai/gpt-5.3-codex` (defaults to `general`)
- `as_subtask` (optional): create child session (defaults to `true`)

At least one of `ref` or `query` is required.

Behavior:
- Loads the stash agent via `akm show`
- Uses stash `prompt` verbatim as OpenCode `system`
- Treats `dispatch_agent` values in `provider/model` form as model overrides and keeps a valid OpenCode agent in the `agent` field
- Applies stash `modelHint` when in `provider/model` format
- Applies stash `toolPolicy` when it maps to boolean tool flags

## Command Execution

Use `akm_cmd` to execute stash command templates through the OpenCode SDK.

Inputs:
- `ref` (optional): stash ref like `command:review.md`
- `query` (optional): resolve best matching stash command when `ref` is omitted
- `arguments` (optional): raw command arguments for `$ARGUMENTS`, `$1`, `$2`, etc.
- `dispatch_agent` (optional): OpenCode agent name, or a `provider/model` override like `openai/gpt-5.3-codex` (defaults to current agent)
- `as_subtask` (optional): create child session (defaults to `false`)

At least one of `ref` or `query` is required.

## Prerequisites

When the plugin loads, it resolves the bundled `akm-cli` dependency installed with the plugin and requires an `akm` version that satisfies `^0.8.0`. It prefers that bundled binary first, falls back to an existing `akm` on PATH only when it also satisfies the same range, and otherwise returns a structured error telling you to reinstall or update the plugin so OpenCode/Bun installs the dependency. It does not run global installers from plugin runtime.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/akm/main/install.ps1 -OutFile install.ps1; ./install.ps1
```

Reinstall or update the plugin to let OpenCode/Bun install the bundled `akm-cli`
dependency automatically.

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
├── lessons/    # first-class durable learnings (lesson:<name>) — often produced by akm improve, accepted via akm accept
├── workflows/  # multi-step procedures (workflow:<name>)
├── vaults/     # .env secret stores (vault:<name>) — values never surface through structured output
├── wikis/      # per-wiki directories <name>/{schema,index,log}.md + raw/ + pages
└── .akm/proposals/  # v0.8.0 proposal queue — drafts that never leak into search or commits
```

## Vaults

`akm_vault` is the one tool in this plugin with a hard contract on output. The
AKM CLI itself guarantees vault values never appear in JSON, the search index,
`.stash.json`, or any structured output channel. This plugin mirrors that:

- `action: "list"` / `"show"` return key names and comments only.
- `action: "set"` / `"unset"` never echo the value.
- `action: "load"` wraps `akm vault load` and returns the raw shell text
  as-is. Treat it as opaque and hand it straight to a shell via
  `eval "$(…)"` — do not log it, do not pass it through another tool, and do
  not let the agent inspect it.

Automatic feedback recording (`tool.execute.after`) skips `vault:*` refs so
that usage signals can't leak which vault was touched.

Assets are resolved from three source types: **working** (local stash), **search paths** (additional dirs via `searchPaths` config), and **installed** (registry kits via `akm add` — see `akm_help` topic="add").

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
