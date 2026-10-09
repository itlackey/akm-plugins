# akm-opencode-v2

OpenCode **2.x** plugin for [AKM](https://github.com/itlackey/akm) `0.9.30`. It registers the five public AKM tools, brings relevant AKM context into the model request automatically, and hands finished turns to AKM's session extraction.

Using OpenCode 1.x? Install [`akm-opencode`](../opencode/README.md) instead. Install only the plugin that matches your OpenCode major: each is built against its host's plugin API and neither works in the other.

| | `akm-opencode` | `akm-opencode-v2` |
| --- | --- | --- |
| OpenCode | 1.x (tested 1.18.34) | 2.x (built and loaded against 2.0.26) |
| Plugin API | `@opencode-ai/plugin` 1.x | `@opencode/plugin` 2.0.26 (Effect entrypoint) |
| `akm-cli` | `0.9.30`, exact | `0.9.30`, exact |
| Config key | `"plugin": ["akm-opencode"]` | `"plugins": ["akm-opencode-v2"]` |

This package depends on neither `opencode-ai` nor `@opencode/cli`. Installing it never installs or replaces your `opencode` binary.

## Installation

Add the plugin to your OpenCode 2 configuration (the `plugins` array in `opencode.json`, or run `opencode plugin add akm-opencode-v2`):

```json
{
  "plugins": ["akm-opencode-v2"]
}
```

`akm-cli@0.9.30` is installed with the plugin and is the `akm` it runs (set `AKM_OPENCODE_CLI` to an absolute path to use another executable). `@opencode/plugin` and `effect` are peer dependencies: OpenCode supplies its own copies at load time, so they are external to the published bundle.

## Tools

The same five tools, with the same descriptions and argument schemas, as the V1 plugin (both read them from [`opencode-shared/tools.ts`](../opencode-shared/tools.ts)): `akm_search`, `akm_show`, `akm_curate`, `akm_feedback`, `akm_remember`. Every tool runs the public `akm` CLI (`akm search|show|curate ... --format json`, `akm feedback`, `akm remember`); nothing imports `akm-cli` internals. A failure comes back to the model as `{"ok":false,"error":...}` and is logged; it is never thrown out of the tool.

## Hook mapping

How each V1 responsibility maps onto the OpenCode 2.0.26 plugin API, as implemented:

| V1 responsibility | V2 native mechanism | Behavior |
| --- | --- | --- |
| Prompt recall (`chat.message`) | `session.hook("prompt")` | Applies the shared recall policy to the prompt text. When it warrants recall, runs `akm curate` and waits up to `AKM_RECALL_WAIT_MS` (default 3000) for it, so the recall usually reaches **this** turn's request. A slower curation keeps running and is used on the next request. The same recall query is not run twice in a session. |
| System context (`experimental.chat.system.transform`) | `session.hook("context")` | Appends the recalled block (with its provenance banner: recalled material is reference data, not instructions) and the standing AKM rules, within `AKM_CONTEXT_BUDGET_CHARS`, to the request's last system part. Runs on every request, so compaction and retries keep the context. |
| Tool pre/post processing | `tool.hook("execute.after")` | Logs the outcome of the plugin's own tools. |
| Session lifecycle (`event`) | `event.subscribe()`, one subscription closed with the plugin scope | `session.created`: prepares hints, the active-workflow summary and project-anchored curation. `session.execution.succeeded` (end of a turn, the analogue of V1's `session.idle`): interval-gated session extraction. `session.deleted`: aborts that session's in-flight `akm` calls and drops its state. Events for other projects' locations are ignored. |
| Five tools | `tool.transform` with JSON Schema inputs | Registered on load; re-registered on tool reload. |
| `client.app.log` | Effect logging (`Effect.logWithLevel`) from the plugin's own fiber context | The Promise plugin API has no logger, so this is an Effect plugin: diagnostics reach OpenCode's logger (its log file; `--print-logs` mirrors it to stderr), redacted with the shared redactor. The plugin never writes to the console. |

Session extraction runs `akm proposal extract --type opencode --session-id <id>`, detached, at most once per `AKM_EXTRACT_MIN_INTERVAL_MS` per session. It requires an LLM engine configured in AKM; without one AKM answers `LLM_NOT_CONFIGURED` and the plugin logs that as a warning (with AKM's code and hint) rather than failing silently. `AKM_AUTO_MEMORY=0` turns extraction off.

Unloading the plugin closes its scope: the event subscription ends, hooks and tools are unregistered by the host, in-flight `akm` calls are cancelled and session state is dropped. The plugin writes no temporary files, so there is nothing to clean up on disk.

### Not in V2 yet

The V1 plugin's experimental behaviors that are not part of the five tools, recall or extraction contract are **not** ported: automatic retrospective feedback ("thanks, that worked"), prompt-signal learning proposals, the format-declaration write gate (`AKM_WRITE_GATE`), the pending-proposal reminder, and the `shell.env` exports. V2 never writes memories, feedback or proposals on its own; use the `akm_feedback` and `akm_remember` tools.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKM_OPENCODE_CLI` | unset | Absolute path to an `akm` executable to run instead of the `akm-cli` dependency. |
| `AKM_AUTO_CURATE` | `1` | `0` disables automatic recall. |
| `AKM_RECALL_WAIT_MS` | `3000` | How long the prompt hook waits for curation before the request proceeds without it. `0` never waits. |
| `AKM_CURATE_LIMIT` / `AKM_CURATE_MIN_CHARS` / `AKM_CURATE_TIMEOUT` / `AKM_CURATE_MIN_SCORE` / `AKM_CURATE_TYPE` | as V1 | Recall tuning, identical to [`akm-opencode`](../opencode/README.md#tuning). |
| `AKM_CONTEXT_BUDGET_CHARS` | `4000` | Maximum injected text per request. |
| `AKM_READ_TOOL_TIMEOUT` | `60` | Seconds allowed for one tool call. |
| `AKM_AUTO_MEMORY` | `1` | `0` disables session extraction. |
| `AKM_EXTRACT_MIN_INTERVAL_MS` | `600000` | Minimum gap between extractions for one session. |
| `AKM_SCOPE_KEYS` | `user,agent,run,channel` | Which scope flags `akm_remember` forwards. |

## Compatibility and updating

Both plugins pin the same `akm-cli` and use only its public CLI, against the same AKM databases. Update order: install or upgrade `akm-cli` first (or let the plugin's dependency do it), then the plugin matching your OpenCode major. A new `akm-opencode-v2` release never changes `akm-opencode`'s default export or `latest` tag, and vice versa. Moving from OpenCode 1 to 2 means replacing `akm-opencode` with `akm-opencode-v2` in the new host's configuration; AKM data is untouched.

### Verification receipt

Verified against the real binary `@opencode/cli@2.0.26` (`opencode serve`, sandboxed `HOME`/`XDG_*`) with the tarball produced by `npm pack` installed by `npm install`, a local OpenAI-compatible mock standing in for the model (no credentials or paid inference), and a stub `akm` that logs its argv:

- the built plugin loads and reports `status: active`; a load failure is logged by the host (`failed to load plugin`), not disguised as success;
- creating a session delivers `session.created`, and the plugin runs `akm hints`, `akm workflow list --active` and a project-anchored `akm curate`;
- a user prompt runs `akm curate <prompt>` through the `prompt` hook, and the model request that follows carries the recalled block with its provenance banner, the hints and the standing AKM rules in its system message;
- the five tools are offered to the model as direct tool calls, and a model-issued `akm_search` call executes `akm search nginx --detail full --format json` and returns its output as the tool result;
- when the turn ends, `akm proposal extract --type opencode --session-id <the real session id>` runs, and its `LLM_NOT_CONFIGURED` failure is logged with AKM's code and hint;
- a failing `akm` call is logged through OpenCode's logger and the plugin prints nothing to stdout/stderr.

Not verified against the real binary: a real model's use of the tools, compaction and retry behaviour, subagent sessions, `session.deleted` cleanup, and installing the package from the npm registry (it is not published; the plugin was loaded from a directory that re-exports the installed `dist/`). `tests/opencode-v2-plugin.test.ts` covers these paths with a fake host context and a fake `akm`.

## Locking down destructive commands

Same as V1: the plugin does not gate `akm` commands, and agents should get explicit user approval before `proposal accept|reject|revert`, `sync --push`, `remove`, env/secret writes, `task add|run`, `upgrade`, `update --all` or `config set`. See [opencode/README.md](../opencode/README.md#locking-down-destructive-commands).

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode 2 plugins](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
