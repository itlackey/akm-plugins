# akm-claude

Claude Code plugin for [AKM](https://github.com/itlackey/akm) `^0.9.8`. It provides an AKM skill, five slash commands, and lifecycle hooks that curate context and learn from concept usage.

The AKM skill also supports delegating work to an AKM agent through Claude's
existing Bash tool. It invokes `akm agent` directly; it does not use MCP,
generated Claude agent definitions, or hooks that intercept Claude's native
`Agent` tool. See `skills/akm/SKILL.md` for the dispatch contract.

## Installation

```sh
/plugin marketplace add itlackey/akm-plugins
/plugin install akm
```

Or use the Claude CLI:

```sh
claude plugin marketplace add itlackey/akm-plugins
claude plugin install akm@akm-plugins
```

The hooks require Bun 1.0 or newer on `PATH`. AKM must also be installed, available on `PATH`, and satisfy `^0.9.8`; the session-start hook reports a degraded status when either dependency is unavailable and does not install software automatically.

## Slash Commands

| Command | Description |
| --- | --- |
| `/akm-search [query] [flags]` | Search configured bundles or registries; omit the query to browse. |
| `/akm-show <ref>` | Show a concept by concept-ID reference. |
| `/akm-curate <task>` | Curate ranked concepts and pack selected local assets' full content into one 8,000-token response. |
| `/akm-feedback <ref> <+\|-> [note]` | Record positive or negative feedback. Negative feedback requires a note. |
| `/akm-remember [name]` | Distill durable knowledge from the conversation into a memory. |

AKM references use `[bundle//]conceptId[#fragment]`, for example `skills/code-review`, `memories/release-retro`, or `team-playbook//knowledge/deploy#Rollback`. Search flags use current source names: `--from local`, `--from registry`, `--from all`, or `--from <bundle-name>`.

## Lifecycle Hooks

Hooks are non-blocking and keep local, redacted state for feedback and memory capture.

| Event | Behavior |
| --- | --- |
| `SessionStart` | Verifies Bun and AKM availability, warms AKM data, and injects the AKM discovery guidance plus hints, pending proposals, active workflows, and curated context when available. Surfaces a missing bundle or a failed previous extraction to both the model and the user. |
| `UserPromptSubmit` | Curates substantive prompts and supplies the result as additional context. It also records explicit memory intent and captures retrospective feedback ("that worked") for concepts the session recently touched. |
| `UserPromptExpansion` | Records use of the five AKM slash commands. |
| `PostToolUse` / `PostToolUseFailure` | Records tool observations and submits deduplicated positive or negative feedback for eligible concepts. |
| `PostToolBatch` | Adds a compact batch observation to local session state. |
| `SubagentStart` | Injects concise AKM context for the subagent. |
| `TaskCreated` / `TaskCompleted` | Records task lifecycle summaries for later memory extraction. |
| `PostCompact` | Preserves a compacted-session observation for later recall. |
| `SessionEnd` | Refreshes the local AKM index and starts non-blocking session extraction. |

The plugin registers no `PreToolUse` hooks: nothing it does needs to run before a tool, and the `PostToolUse` pass records strictly more about the same call.

Hook processing never prints secret values. Automatic feedback skips references that AKM reports as ineligible, and a *successful* read-only `akm show` / `search` / `curate` submits nothing — inspecting a concept is not evidence that it helped. Failures of those same verbs still count as negative signal. The OpenCode plugin applies the same rule to its `akm_show` / `akm_search` / `akm_curate` tools, so the same action lands the same way on either harness.

## Locking down destructive commands

The plugin does not gate destructive `akm` commands, and no hook inspects a Bash invocation to decide whether to block it. That gate was removed in 0.8.0: tokenized matching produced false positives on commit messages, heredoc bodies, and any other prose containing an `akm <verb>` substring, and deciding which shell calls to allow is the host platform's job, not a plugin's.

Use Claude Code's own permission rules in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": ["Bash(akm proposal accept *)", "Bash(akm sync --push *)"],
    "deny": ["Bash(akm remove *)", "Bash(akm config set *)"]
  }
}
```

Independently of any permission rule, the AKM skill instructs the agent to get explicit user approval before invoking a destructive verb — `proposal accept`, `proposal reject`, `proposal revert`, `sync --push`, `remove`, env/secret writes, `task add` / `task run`, `upgrade`, `update --all`, `config set`.

## Environment

Every kill switch below is opt-out and reads the same way: only the literal `0` disables it. Any other value — including `false` — leaves the feature on.

The four most useful settings are also exposed in Claude Code's `/plugin` configuration dialog: **AKM bundle directory**, **Record feedback automatically**, **Curated results per prompt**, and **Refresh the AKM index when a session ends**. They are aliases for `AKM_BUNDLE_DIR`, `AKM_AUTO_FEEDBACK`, `AKM_CURATE_LIMIT`, and `AKM_INDEX_ON_SESSION_END`. An environment variable you set yourself always wins over the dialog, so exporting one of these pins it regardless of what the UI shows.

### Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_BUNDLE_DIR` | unset | Absolute path to the AKM bundle root. Set this. When it is unset the hooks discover the bundle by spawning `akm info`, which adds a subprocess to every file-tool hook that sees a concept-like token; setting it removes that spawn entirely. The session-start hook tells you to set it when no bundle is configured. |
| `AKM_LOCAL_BUILD_CLI` | unset | Absolute path to a locally built AKM CLI entry point. |
| `AKM_PACKAGE_REF` | `akm-cli@^0.9.8` | Package specification shown when AKM is unavailable. It is never installed automatically. |
| `AKM_PLUGIN_STATE_DIR` | `$XDG_STATE_HOME/akm-claude` | Local plugin state directory. |
| `AKM_AUTO_CURATE` | `1` | Set to `0` to disable prompt curation (`UserPromptSubmit`) and the session-start curate call. Feedback logging, memory-intent logging, and retrospective feedback keep working. |
| `AKM_AUTO_FEEDBACK` | `1` | Set to `0` to disable automatic feedback, including retrospective ("that worked") capture. |
| `AKM_AUTO_HINTS` | `1` | Set to `0` to skip the session-start `akm hints` call. |
| `AKM_AUTO_MEMORY` | `1` | Set to `0` to disable automatic memory harvesting. The `SessionEnd` `akm proposal extract` spawn is the whole of that harvest here, and the OpenCode plugin honours the same variable for its own single extract, so one setting covers both harnesses. |
| `AKM_INDEX_ON_SESSION_END` | `1` | Set to `0` to skip the `akm index` refresh at session end. Useful on CI runners and low-power machines; the periodic `akm improve` pass remains the backstop. |

### Scope

Scope values are attached to the plugin's own lifecycle records in `events.jsonl`. The Claude hooks never invoke `akm remember`, so — unlike the OpenCode plugin — these are not forwarded to AKM as CLI flags.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_SCOPE_KEYS` | `user,agent,run,channel` | Which of the four gated scope dimensions to record. Dropping a key omits it from local lifecycle records. |
| `AKM_USER_ID` | unset | Value for the `user` dimension. Recorded only while `user` is in `AKM_SCOPE_KEYS`. |
| `AKM_AGENT_ID` | unset | Value for the `agent` dimension. Recorded only while `agent` is in `AKM_SCOPE_KEYS`. |
| `AKM_CHANNEL` | unset | Value for the `channel` dimension. Recorded only while `channel` is in `AKM_SCOPE_KEYS`. |
| `AKM_PROJECT` | unset | Project label. Always recorded — `AKM_SCOPE_KEYS` does not gate it. |
| `AKM_REPO` | unset | Repository label. Always recorded. |
| `AKM_BRANCH` | unset | Branch label. Always recorded. |

The `run` dimension is the Claude session ID and has no environment variable; it is gated by `AKM_SCOPE_KEYS` like the other three.

### Tuning

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_CURATE_LIMIT` | `5` | Maximum curated results requested per prompt or session. |
| `AKM_CURATE_TIMEOUT` | `8` | Timeout in seconds for hook AKM calls. The session-start `akm --version` probe uses a fixed, much tighter 3-second cap instead. |
| `AKM_CONTEXT_BUDGET_CHARS` | `4000` | Maximum length of the text a hook injects into the model's context. Curated results are written to a file and the hook injects a pointer to it, so this budget governs the injected pointer text, not the size of the curation file. The user-visible `systemMessage` channel is not subject to it. |
| `AKM_PLUGIN_MAX_LOG_BYTES` | `1048576` | Size cap for each append-only state file. Past the cap the newest half is retained. |
| `AKM_PLUGIN_QUALITY_TTL_MS` | `86400000` | Freshness window for the cached per-concept quality classification. Past it the `akm show` probe re-runs, so a `proposed` asset later promoted to `curated` stops being misclassified. |
| `AKM_AUTO_FEEDBACK_MIN_CONFIDENCE` | `0.6` | Minimum classifier confidence before automatic feedback is actually submitted. Raise it to submit less. |
| `AKM_RETROSPECTIVE_FEEDBACK_PATTERN` | `\b(thanks\|perfect\|worked)\b` | Case-insensitive regex for "that worked" prompts. Retune it for other languages or project jargon. An invalid regex falls back to the default rather than failing the hook. |
| `AKM_RETROSPECTIVE_NEGATIVE_PATTERN` | `\b(wrong\|failed\|broken\|didn't work\|did not work\|bad)\b` | Case-insensitive regex that vetoes retrospective credit, so a mixed message ("thanks, but it did not work") is skipped rather than misread as praise. Same fallback behavior. |

### Redaction

These three are read once, when the hook process imports the redaction module, so they must be set in the environment **before** the hook starts — exporting them mid-session has no effect. Both matchers are off by default because both over-redact on ordinary logs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_REDACT_HIGH_ENTROPY` | unset (off) | Set to `1` to redact long base64/hex-shaped strings that look like secrets. |
| `AKM_REDACT_ENTROPY_MIN_LEN` | `32` | Minimum length for the high-entropy matcher. Values below `32` are clamped to `32`. No effect unless `AKM_REDACT_HIGH_ENTROPY=1`. |
| `AKM_REDACT_PII` | unset (off) | Set to `1` to redact credit-card-shaped digit runs, US SSNs, and phone numbers. |

## Troubleshooting

Hooks never write diagnostics to stderr. The few failures only you can fix — AKM missing, no bundle configured, the last memory extraction failed — travel through the hook protocol's `systemMessage` field, so Claude Code shows them to you at session start. Everything else lands in the state directory (`$XDG_STATE_HOME/akm-claude` by default), owner-only and size-capped:

| File | Contents |
| --- | --- |
| `session.log` | Hook lifecycle: AKM readiness, version mismatches, subprocess failures, session-end extraction attempts. |
| `extract.log` | Output of the detached `akm proposal extract` run at session end. Check here first if durable memories never appear — a fresh install without a configured LLM profile logs `LLM_NOT_CONFIGURED`, which `akm setup` resolves. You should not have to go looking: when the newest run in this file failed, or ran but harvested nothing (e.g. an unreachable LLM engine), the next session start reports it and prints this file's absolute path. |
| `index.log` | Output of the detached `akm index` refresh run at session end. Check here if search results go stale. |
| `feedback.log` / `memory.log` | Automatic feedback decisions and observed concept IDs. |
| `events.jsonl` | Structured, redacted lifecycle events. |

## Recommended Flow

1. Use `/akm-curate` for task-oriented discovery.
2. Use `/akm-search` when you need an exact concept ID.
3. Inspect the selected concept with `/akm-show`.
4. Record the result with `/akm-feedback`.
5. Save durable project knowledge with `/akm-remember`.
6. Delegate specialized work with `akm agent <agent-ref>` when an AKM agent's
   prompt, model, or tool policy is part of the task.
