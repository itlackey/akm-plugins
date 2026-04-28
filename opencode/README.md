# akm-opencode

OpenCode plugin for the [AKM](https://github.com/itlackey/akm) CLI (v0.6.1+). Registers tools that let your AI agent **search**, **show**, and **manage** stash assets — skills, commands, agents, knowledge, memories, scripts, workflows, vaults, and wikis — plus **agentic hooks** that auto-load relevant assets into each turn, record feedback when assets are used, and harvest session memories so the stash improves with every session.

## Installation

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["akm-opencode"]
}
```

## Tools

The plugin exposes a trimmed surface of **14 high-value tools**. Long-tail verbs (`add`, `save`, `import`, `clone`, `update`, `remove`, `list`-sources, `registry-search`, `index`-reindex, `config`, `upgrade`, ad-hoc `run`, `proposal`, `distill`, `reflect`, `propose`) are reachable via `akm_help` plus the raw `akm` CLI through the `bash` tool.

| Tool | Description |
|------|-------------|
| `akm_search` | Search the local stash, the registry, or both. Type filter accepts `skill`, `command`, `agent`, `knowledge`, `lesson`, `memory`, `script`, `workflow`, `vault`, `wiki`, `any`; proposed hits can be included explicitly |
| `akm_show` | Show a stash asset by its ref |
| `akm_agent` | Dispatch a stash `agent:*` into OpenCode using the stash prompt and metadata |
| `akm_cmd` | Execute a stash `command:*` template in OpenCode via SDK session prompting |
| `akm_remember` | Record a memory in the default stash |
| `akm_feedback` | Record positive or negative feedback for a stash asset (skipped automatically for `memory:` and `vault:` refs) |
| `akm_curate` | Curate the stash for a task or topic and return ranked matches the agent can use |
| `akm_evolve` | Dispatch the AKM curator subagent into a child session, capture the report as a memory, and seed the curator-context cache so it survives compaction |
| `akm_parent_messages` | Summarize the parent OpenCode session so dispatched stash subagents can inherit upstream context |
| `akm_session_messages` | Summarize a specific OpenCode session (arbitrary IDs restricted to `akm-curator`) |
| `akm_vault` | Vault `list` / `show` (key names) / `create` / `set` / `unset` / `load` (opaque shell-eval text). **Values never surface** through `list`/`show`; `load` output is meant for `eval` and must not be displayed back |
| `akm_wiki` | Manage wikis (`create`, `register`, `list`, `show`, `pages`, `search`, `stash`, `lint`, `ingest`, `remove`) |
| `akm_workflow` | Drive workflow runs (`start`, `next`, `complete`, `status`, `list`, `create`, `template`, `resume`) |
| `akm_help` | Discover the right `akm` CLI invocation for non-first-class verbs. Returns a curated quick-reference table plus live `akm <subcommand> --help` output |

## Compound-engineering hooks

The plugin subscribes to OpenCode lifecycle events so AKM participates in the
session loop instead of waiting to be called. Every hook is non-blocking and
fails silently when `akm` is not on PATH — the TUI is never affected.

| Event | What happens |
| --- | --- |
| **`session.created`** (event hook) | Warms the stash index in the background, caches `akm hints` plus active workflow status, and runs a scoped `akm curate --run <sessionID>` so fresh sessions see relevant stash context before the first user message. |
| **`chat.message`** | Runs `akm curate "<prompt>" --run <sessionID>` on each user message (prompts shorter than `AKM_CURATE_MIN_CHARS` are skipped). The top matches are stored for injection. Memory intents (prompts mentioning "remember" / "memory") are tracked in the session buffer. |
| **`experimental.chat.system.transform`** | Appends cached hints, active workflow state, pending proposal summaries, the last curator report, and the current prompt's curated context to the model's system prompt. Hints and workflow state are re-injected after transcript compaction. |
| **`tool.execute.before`** (`akm_*` tools) | Blocks destructive or sensitive operations until `confirm:true` is provided. |
| **`permission.ask`** / **`command.execute.before`** | Detects risky raw `akm` CLI commands executed through shell/commands and denies them until the user explicitly approves the exact operation. |
| **`tool.execute.after`** (`akm_*` tools) | Logs asset usage, accumulates refs into the session buffer, records `akm feedback <ref> --positive` / `--negative` asynchronously with per-call dedupe, checkpoints memories every `AKM_MEMORY_CHECKPOINT_EVERY` successful asset-touching tool calls, and scans child-agent free text for additional refs. |
| **`experimental.session.compacting`** | Pushes hints, curated context, active workflows, and the last curator report into the compaction prompt so they survive transcript shrinking. |
| **`shell.env`** | Exposes `AKM_STASH_DIR`, `AKM_PROJECT`, and `AKM_PLUGIN_VERSION` to shell tools so plain `akm` calls inherit the right context. |
| **`stop`** / **`session.idle`** / **`session.compacted`** / **`session.deleted`** | Flushes the per-session buffer into a `memory:opencode-session-YYYYMMDD-<sid>` memory so every meaningful session contributes durable context for future searches. Requires at least two observations before persisting. When `AKM_INDEX_ON_SESSION_END=1`, the hook follows a successful flush with `akm index` so upstream inference/graph passes run immediately. |

### Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_AUTO_CURATE` | `1` | Set to `0` to disable automatic `akm curate` on user messages. |
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
- use `akm_help` to route `proposal`, `distill`, `reflect`, and `propose` CLI workflows;
- require explicit user approval before proposal acceptance/rejection, push saves, source removal, CLI upgrades, update-all, or vault value access.

The package also ships OpenCode command docs for common workflows:

- `/akm-review-proposals`
- `/akm-distill-lesson`
- `/akm-reflect-on-failure`
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

When the plugin loads, it checks the installed `akm` version first and only runs `bun install -g akm-cli@latest` when `akm` is missing or older than the latest stable npm release. Newer pre-releases and local builds are left in place. It then prefers the Bun-installed binary and falls back to an existing `akm` on PATH when needed. It does not run the standalone shell installers automatically.

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
