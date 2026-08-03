# akm-opencode

OpenCode plugin for [AKM](https://github.com/itlackey/akm) `^0.9.0-rc.14 || ^0.9.0`. It exposes exactly five public tools and uses lifecycle hooks to bring relevant AKM context into a session.

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
| `session.created` | Resolves AKM, warms local data in the background, and prepares scoped context for the session. |
| `chat.message` | Records feedback or memory intent and can schedule non-blocking curation for a substantive prompt. |
| `experimental.chat.system.transform` | Injects cached AKM guidance and curated context into the system prompt. |
| `tool.execute.after` | Tracks concepts used by AKM tools, records deduplicated feedback, and checkpoints session observations. |
| `shell.env` | Exposes `AKM_PROJECT`, `AKM_PLUGIN_VERSION`, and the resolved `AKM_BUNDLE_DIR` to shell tools. |
| Session idle, compacted, or deleted | Flushes sufficiently meaningful session observations through the memory lifecycle. |

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_LOCAL_BUILD_CLI` | unset | Absolute path to a locally built AKM CLI entry point. |
| `AKM_AUTO_CURATE` | `1` | Set to `0` to disable automatic prompt curation. |
| `AKM_AUTO_FEEDBACK` | `1` | Set to `0` to disable automatic outcome feedback. |
| `AKM_AUTO_MEMORY` | `1` | Set to `0` to disable automatic session memories. |
| `AKM_CURATE_LIMIT` | `5` | Maximum curated results injected per prompt. |
| `AKM_CURATE_MIN_CHARS` | `16` | Minimum prompt length for automatic curation. |
| `AKM_CURATE_TIMEOUT` | `8` | Timeout in seconds for AKM calls made by hooks. |
| `AKM_CONTEXT_BUDGET_CHARS` | `4000` | Maximum AKM context injected into one turn. |
| `AKM_SCOPE_KEYS` | `user,agent,run,channel` | Scope dimensions attached to remember calls and local lifecycle records. |

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
