# akm-claude

Claude Code plugin for [AKM](https://github.com/itlackey/akm) `^0.9.0-rc.14 || ^0.9.0`. It provides an AKM skill, five slash commands, and lifecycle hooks that curate context and learn from concept usage.

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

The hooks require Bun 1.0 or newer on `PATH`. AKM must also be installed, available on `PATH`, and satisfy `^0.9.0-rc.14 || ^0.9.0`; the session-start hook reports a degraded status when either dependency is unavailable and does not install software automatically.

## Slash Commands

| Command | Description |
| --- | --- |
| `/akm-search [query] [flags]` | Search configured bundles or registries; omit the query to browse. |
| `/akm-show <ref>` | Show a concept by concept-ID reference. |
| `/akm-curate <task>` | Curate ranked concepts for a task or topic. |
| `/akm-feedback <ref> <+|-> [note]` | Record positive or negative feedback. Negative feedback requires a note. |
| `/akm-remember [name]` | Distill durable knowledge from the conversation into a memory. |

AKM references use `[bundle//]conceptId[#fragment]`, for example `skills/code-review`, `memories/release-retro`, or `team-playbook//knowledge/deploy#Rollback`. Search flags use current source names: `--from local`, `--from registry`, `--from all`, or `--from <bundle-name>`.

## Lifecycle Hooks

Hooks are non-blocking and keep local, redacted state for feedback and memory capture.

| Event | Behavior |
| --- | --- |
| `SessionStart` | Verifies Bun and AKM availability, warms AKM data, and injects initial scoped guidance and curated context when available. |
| `UserPromptSubmit` | Curates substantive prompts and supplies the result as additional context. It also records explicit memory intent. |
| `UserPromptExpansion` | Records use of the five AKM slash commands. |
| `PreToolUse` | Observes concept references in non-Bash tool input without blocking. |
| `PostToolUse` / `PostToolUseFailure` | Records tool observations and submits deduplicated positive or negative feedback for eligible concepts. |
| `PostToolBatch` | Adds a compact batch observation to local session state. |
| `SubagentStart` | Injects concise AKM context for the subagent. |
| `TaskCreated` / `TaskCompleted` | Records task lifecycle summaries for later memory extraction. |
| `PostCompact` | Preserves a compacted-session observation for later recall. |
| `SessionEnd` | Refreshes the local AKM index and starts non-blocking session extraction. |

Hook processing never prints secret values. Automatic feedback skips references that AKM reports as ineligible.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_PACKAGE_REF` | `akm-cli@^0.9.0-rc.14` | Package specification shown when AKM is unavailable. It is never installed automatically. |
| `AKM_LOCAL_BUILD_CLI` | unset | Absolute path to a locally built AKM CLI entry point. |
| `AKM_AUTO_FEEDBACK` | `1` | Set to `0` to disable automatic feedback. |
| `AKM_CURATE_LIMIT` | `5` | Maximum curated results injected per prompt. |
| `AKM_CURATE_MIN_CHARS` | `16` | Minimum prompt length for automatic curation. |
| `AKM_CURATE_TIMEOUT` | `8` | Timeout in seconds for hook AKM calls. |
| `AKM_CONTEXT_BUDGET_CHARS` | `4000` | Maximum AKM context injected by a hook. |
| `AKM_PLUGIN_STATE_DIR` | `$XDG_STATE_HOME/akm-claude` | Local plugin state directory. |
| `AKM_SCOPE_KEYS` | `user,agent,run,channel` | Scope dimensions attached to remember calls and local lifecycle records. |

## Recommended Flow

1. Use `/akm-curate` for task-oriented discovery.
2. Use `/akm-search` when you need an exact concept ID.
3. Inspect the selected concept with `/akm-show`.
4. Record the result with `/akm-feedback`.
5. Save durable project knowledge with `/akm-remember`.
