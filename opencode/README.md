# akm-opencode

OpenCode plugin for [AKM](https://github.com/itlackey/akm) `^0.9.0`. It exposes exactly five public tools and uses lifecycle hooks to bring relevant AKM context into a session.

## Installation

Add the plugin to `opencode.json`:

```json
{
  "plugin": ["akm-opencode"]
}
```

## Tools

| Tool | Description |
| --- | --- |
| `akm_search` | Search configured bundles or registries. `source` accepts `local`, `registry`, `all`, or a configured bundle name. |
| `akm_show` | Show a concept by `[bundle//]conceptId[#fragment]`. A fragment selects a Markdown section. |
| `akm_curate` | Return ranked concepts for a task or topic. |
| `akm_feedback` | Record positive or negative feedback for a concept. |
| `akm_remember` | Save durable knowledge as a searchable memory. |

`akm_search`, `akm_show`, and `akm_curate` call the bundled AKM read APIs in process. `akm_feedback` and `akm_remember` use the compatible AKM CLI because they mutate AKM state. Failures return structured results and are logged through OpenCode app logging.

Use the `ref` returned by search or curate directly with show or feedback. Concept IDs look like `skills/code-review`, `memories/release-retro`, or `team-playbook//knowledge/deploy#Rollback`.

## Lifecycle Hooks

The plugin subscribes to OpenCode lifecycle events. Hook failures are logged through OpenCode app logging and do not interrupt the TUI.

| Event | Behavior |
| --- | --- |
| `session.created` | Resolves AKM, warms local data in the background, and prepares hints, an active-workflow summary, and curated context for the session. |
| `session.updated` | Backfills hints and the workflow summary for a session the plugin has not prepared yet. It does not re-run session-created work. |
| `chat.message` | Records feedback or memory intent and can schedule non-blocking curation for a substantive prompt. The curate is fire-and-forget: its result is injected on a later turn rather than delaying this one. |
| `experimental.chat.system.transform` | Injects the AKM guidance and cached curated context into the system prompt. The host rebuilds the system prompt on every request, so these blocks are re-injected each turn — including after a compaction — rather than once per session. |
| `tool.execute.before` | The format-declaration write gate (`AKM_WRITE_GATE`, `observe` by default). Blocks the first `edit`/`write` to an existing file that declares a format your stash documents and hands the model the ref to read. Once per file per session, released unconditionally on the retry. |
| `tool.execute.after` | Tracks concepts used by AKM tools, records deduplicated feedback, and checkpoints session observations. It also records what a file the session `read` declares about its own format, which is what the write gate above keys on. `write` is deliberately not a source: a file the session created is not one it needs the stash to explain. The create itself is recorded on the write's `tool.execute.before` pass, so a later read-back of that file cannot re-arm the gate. |
| `shell.env` | Exposes `AKM_PROJECT`, `AKM_PLUGIN_VERSION`, and the resolved `AKM_BUNDLE_DIR` to shell tools. |
| `session.idle` | Runs interval-gated memory extraction (`AKM_AUTO_MEMORY=0` disables it). Fires after every turn, so it is rate-limited. |
| `session.compacted` | Records a post-compaction event. |
| `session.deleted` | Refreshes the local AKM index, warns once if the write gate saw write-path tool calls but never acted on any, then drops all per-session state and the temporary curation file. |

The session observation buffer that retrospective feedback reads from survives every non-terminal event: it is bounded by `AKM_SESSION_BUFFER_MAX_ENTRIES` and dropped only on `session.deleted`. Discarding it at `session.idle` would empty it between turns, so "thanks, that worked" would credit nothing in exactly the sessions that used the most assets.

Automatic feedback skips references that AKM reports as ineligible, and a *successful* `akm_show` / `akm_search` / `akm_curate` submits nothing — inspecting a concept is not evidence that it helped, so on OpenCode the positive signal comes from a retrospective confirmation instead. Failures of those same tools still count as negative signal. Same rule as the Claude plugin, which applies it to the `akm` subcommand of a Bash invocation.

## Locking down destructive commands

The plugin does not gate destructive `akm` commands. The `permission.ask` / `command.execute.before` hook that tokenized each Bash invocation and blocked a hard-coded list of risky `akm` subcommands was removed in 0.8.0: tokenized matching produced false positives on commit messages, heredoc bodies, and any other prose containing an `akm <verb>` substring.

OpenCode has no first-class permission DSL today, so enforce it outside the plugin — wrap `akm` in a confirmation script earlier on `PATH`, or use OS-level access controls.

Independently of any such control, agents should treat these verbs as requiring explicit user approval: `proposal accept`, `proposal reject`, `proposal revert`, `sync --push`, `remove`, env/secret writes, `task add` / `task run`, `upgrade`, `update --all`, `config set`.

## Environment

Every kill switch below is opt-out and reads the same way: only the literal `0` disables it. Any other value — including `false` — leaves the feature on.

### Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_BUNDLE_DIR` | unset | Absolute path to the AKM bundle root. When unset the plugin discovers it once per process by running `akm info`. The resolved value is re-exported to shell tools through the `shell.env` hook. |
| `AKM_LOCAL_BUILD_CLI` | unset | Absolute path to a locally built AKM CLI entry point. |
| `AKM_OPENCODE_IGNORE_BUNDLED_CLI` | unset (off) | Set to `1` to drop the bundled AKM CLI from resolution so only an `akm` on `PATH` is considered. Used by the eval harness; also an escape hatch when the bundled dependency is broken. |
| `AKM_AUTO_CURATE` | `1` | Set to `0` to disable automatic prompt curation. |
| `AKM_AUTO_FEEDBACK` | `1` | Set to `0` to disable automatic outcome feedback. |
| `AKM_AUTO_HINTS` | `1` | Set to `0` to skip the per-session `akm hints` call. The missing-bundle warning is deliberately not gated on this: it explains why the stash is empty in the first place. |
| `AKM_AUTO_MEMORY` | `1` | Set to `0` to disable automatic memory harvesting — the interval-gated `akm proposal extract` on `session.idle`, which is the whole of that harvest here. The Claude plugin honours the same variable for its `SessionEnd` extract, so one setting covers both harnesses. |
| `AKM_INDEX_ON_SESSION_END` | `1` | Set to `0` to skip the `akm index` refresh. It runs only on `session.deleted` — never on `session.idle`, which fires after every turn. |
| `AKM_WRITE_GATE` | `observe` | The format-declaration write gate (#99). When a file the session **read** declares a format your stash documents — an `apiVersion:` namespace, a `yaml-language-server` pragma, a `$schema` key, an XML root namespace — and that asset has not been opened this session, the FIRST `edit`/`write` to that file is blocked once and the model is told which ref to read. It ships in `observe`: everything runs and the would-fire count lands in the ledger, but nothing is blocked. Set `enforce` to block, or `off`/`0` to disable it entirely. An unrecognized value is a configuration error — it logs one error per process and the gate refuses to run rather than guessing a default. It never fires on a file this session created: the create is recorded when it happens — a `write` to a path this session has not read, or an `edit` with an empty `oldString` — and that path stays insulated for the rest of the session, so reading back the model's own output does not re-arm it (ledger reason `session-created`). It self-disables when the AKM CLI does not resolve, and it is inert on `apply_patch` (which carries no file path) — that case logs one warning per process rather than failing quietly. |

### Scope

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_SCOPE_KEYS` | `user,agent,run,channel` | Which scope dimensions `akm_remember` forwards to the AKM CLI as flags. It does **not** gate what the plugin records locally — lifecycle events in `events.jsonl` always carry every dimension that has a value. |
| `AKM_USER_ID` | unset | Value for the `user` dimension. |
| `AKM_CHANNEL` | unset | Value for the `channel` dimension. |
| `AKM_REPO` | unset | Repository label recorded on lifecycle events. |
| `AKM_BRANCH` | unset | Branch label recorded on lifecycle events. |

The `agent`, `run`, and `project` dimensions come from OpenCode itself (the active agent, the session ID, and the worktree), so they have no environment variable. `AKM_PROJECT` is *written* by the `shell.env` hook for shell tools to read; the plugin never reads it.

### Tuning

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_CURATE_LIMIT` | `5` | Maximum curated results injected per prompt. |
| `AKM_CURATE_MIN_CHARS` | `16` | Minimum prompt length for automatic curation. |
| `AKM_CURATE_TIMEOUT` | `8` | Timeout in seconds for AKM calls made by hooks. |
| `AKM_CONTEXT_BUDGET_CHARS` | `4000` | Maximum length of the AKM text injected into the system prompt on one turn. Past it the block is truncated with a marker. |
| `AKM_PENDING_PROPOSAL_TIMEOUT` | `2` | Timeout in seconds for the pending-proposal count. Floored at 0.5s. |
| `AKM_SESSION_BUFFER_MAX_ENTRIES` | `200` | Per-session cap on buffered observations. Oldest entries are dropped first. |
| `AKM_EXTRACT_MIN_INTERVAL_MS` | `600000` | Minimum gap between `akm proposal extract` runs for one session. `session.idle` fires after every turn, so without this gate extraction would flood. |
| `AKM_PLUGIN_MAX_LOG_BYTES` | `1048576` | Size cap for each append-only state file under `$XDG_STATE_HOME/akm-opencode`. Past the cap the newest half is retained. |
| `AKM_AUTO_FEEDBACK_MIN_CONFIDENCE` | `0.6` | Minimum classifier confidence before automatic feedback is actually submitted. Raise it to submit less. |
| `AKM_RETROSPECTIVE_FEEDBACK_PATTERN` | `\b(thanks\|perfect\|worked)\b` | Case-insensitive regex for "that worked" messages. Retune it for other languages or project jargon. An invalid regex falls back to the default rather than failing the hook. |
| `AKM_RETROSPECTIVE_NEGATIVE_PATTERN` | `\b(wrong\|failed\|broken\|didn't work\|did not work\|bad)\b` | Case-insensitive regex that vetoes retrospective credit, so a mixed message ("thanks, but it did not work") is skipped rather than misread as praise. Same fallback behavior. |

### Redaction

These three are read once, when the plugin module is imported, so they must be set in the environment **before** OpenCode starts. Both matchers are off by default because both over-redact on ordinary logs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_REDACT_HIGH_ENTROPY` | unset (off) | Set to `1` to redact long base64/hex-shaped strings that look like secrets. |
| `AKM_REDACT_ENTROPY_MIN_LEN` | `32` | Minimum length for the high-entropy matcher. Values below `32` are clamped to `32`. No effect unless `AKM_REDACT_HIGH_ENTROPY=1`. |
| `AKM_REDACT_PII` | unset (off) | Set to `1` to redact credit-card-shaped digit runs, US SSNs, and phone numbers. |

## Usage

1. Start with `akm_curate` for task-oriented discovery.
2. Use `akm_search` when you know the concept name and need its exact ID.
3. Fetch the full concept with `akm_show` before relying on it.
4. Record the outcome with `akm_feedback`.
5. Use `akm_remember` for durable knowledge that should be available to future sessions.

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode custom tools](https://opencode.ai/docs/custom-tools/)
