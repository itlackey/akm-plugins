# akm-opencode-v2

OpenCode **2.x** plugin for [AKM](https://github.com/itlackey/akm) `0.10.26101001-alpha`. It registers the five public AKM tools, brings relevant AKM context into the model request automatically, records feedback and learning proposals from what you tell the model, and hands finished turns to AKM's session extraction.

Using OpenCode 1.x? Install [`akm-opencode`](../opencode/README.md) instead. Install only the plugin that matches your OpenCode major: each is built against its host's plugin API and neither works in the other.

| | `akm-opencode` | `akm-opencode-v2` |
| --- | --- | --- |
| OpenCode | 1.x (tested 1.18.34) | 2.x (built and loaded against 2.0.26) |
| Plugin API | `@opencode-ai/plugin` 1.x | `@opencode/plugin` 2.0.26 (Effect entrypoint) |
| `akm-cli` | `0.10.26101001-alpha`, exact | `0.10.26101001-alpha`, exact |
| Config key | `"plugin": ["akm-opencode"]` | `"plugins": ["akm-opencode-v2"]` |

This package depends on neither `opencode-ai` nor `@opencode/cli`. Installing it never installs or replaces your `opencode` binary.

## Installation

Add the plugin to your OpenCode 2 configuration (the `plugins` array in `opencode.json`, or run `opencode plugin add akm-opencode-v2`):

```json
{
  "plugins": ["akm-opencode-v2"]
}
```

`akm-cli@0.10.26101001-alpha` is installed with the plugin and is the `akm` it runs (set `AKM_OPENCODE_CLI` to an absolute path to use another executable). `@opencode/plugin` and `effect` are peer dependencies: OpenCode supplies its own copies at load time, so they are external to the published bundle.

## Tools

The same five tools, with the same descriptions and argument schemas, as the V1 plugin (both read them from [`opencode-shared/tools.ts`](../opencode-shared/tools.ts)): `akm_search`, `akm_show`, `akm_curate`, `akm_feedback`, `akm_remember`. Every tool runs the public `akm` CLI (`akm search|show|curate ... --format json`, `akm feedback`, `akm remember`); nothing imports `akm-cli` internals. A failure comes back to the model as `{"ok":false,"error":...}` and is logged; it is never thrown out of the tool.

## Hook mapping

How each V1 responsibility maps onto the OpenCode 2.0.26 plugin API, as implemented:

| V1 responsibility | V2 native mechanism | Behavior |
| --- | --- | --- |
| Prompt recall (`chat.message`) | `session.hook("prompt")` | Applies the shared recall policy to the prompt text. When it warrants recall, calls `curate` **in-process** through `akm-cli/api` (no `akm` process) and waits up to `AKM_RECALL_WAIT_MS` (default 3000) for it, so the recall usually reaches **this** turn's request. A slower curation keeps running and is used on the next request. The same recall query is not run twice in a session. |
| System context (`experimental.chat.system.transform`) | `session.hook("context")` | Appends the recalled block (with its provenance banner: recalled material is reference data, not instructions) and the standing AKM rules, within `AKM_CONTEXT_BUDGET_CHARS`, to the request's last system part. Runs on every request, so compaction and retries keep the context. |
| Auto-feedback (`chat.message` + `tool.execute.after`) | `tool.hook("execute.after")` notes the refs each tool touched; `session.hook("prompt")` reads the user's next message | Same policy as V1 (shared in [`opencode-shared/feedback.ts`](../opencode-shared/feedback.ts)). "Thanks, that worked" credits the last three distinct refs the session touched with `akm feedback --positive`; an explicit correction ("that was wrong") blames the last one with `--negative`, and a softer negative needs a second one within two minutes. A mixed message ("thanks, but it didn't work") credits nothing. A failed akm call never counts as a touched ref, and `memories/`, `env/`, `secrets/` and `lessons/` refs never receive automatic feedback. A tool outcome alone is never feedback. `AKM_AUTO_FEEDBACK=0` turns off the positive path (as in V1, the negative path is not gated by it). |
| Learning proposals (`chat.message`) | `session.hook("prompt")` | Same detection, thresholds and consent as V1 (shared in [`opencode-shared/learning.ts`](../opencode-shared/learning.ts) and `claude/shared/learning-signals.ts`): an explicit "remember ...", a guardrail, a preference or a correction, or a workflow the user keeps repeating, becomes a **proposal** in AKM's review queue (`akm proposal new`, detached). The plugin never writes a memory and never accepts, rejects or drains a proposal: accepting needs the user's explicit approval. Identical proposals are deduplicated, and the min confidence is `AKM_LEARNING_PROPOSAL_MIN_CONFIDENCE` (default 0.75). `AKM_AUTO_LEARNING=0` and `AKM_AUTO_SKILL_PROPOSALS=0` switch the two sources off. |
| Pending-proposal nag | `session.hook("context")` | While proposals await review (`akm proposal list --status pending`, cached for a minute) the context says how many and that mutating actions need explicit user approval. |
| Write gate (`tool.execute.before`) | `tool.hook("execute.before")` | See "Write gate" below. |
| `shell.env` | `shell.hook("create.before")` | See "Shell environment" below. |
| Tool post-processing | `tool.hook("execute.after")` | Notes touched refs (above), logs the outcome of the plugin's own tools. |
| Session lifecycle (`event`) | `event.subscribe()`, one subscription closed with the plugin scope | `session.created`: prepares hints, the active-workflow summary and project-anchored curation. `session.execution.succeeded` (end of a turn, the analogue of V1's `session.idle`): interval-gated session extraction. `session.deleted`: aborts that session's in-flight recall and `akm` calls and drops its state (feedback refs, gate bookkeeping, pending count). Events for other projects' locations are ignored. |
| Five tools | `tool.transform` with JSON Schema inputs | Registered on load; re-registered on tool reload. |
| `client.app.log` | Effect logging (`Effect.logWithLevel`) from the plugin's own fiber context | The Promise plugin API has no logger, so this is an Effect plugin: diagnostics reach OpenCode's logger (its log file; `--print-logs` mirrors it to stderr), redacted with the shared redactor. The plugin never writes to the console. |

Session extraction runs `akm proposal extract --type opencode --session-id <id>`, detached, at most once per `AKM_EXTRACT_MIN_INTERVAL_MS` per session. It requires an LLM engine configured in AKM; without one AKM answers `LLM_NOT_CONFIGURED` and the plugin logs that as a warning (with AKM's code and hint) rather than failing silently. `AKM_AUTO_MEMORY=0` turns extraction off.

Unloading the plugin closes its scope: the event subscription ends, hooks and tools are unregistered by the host, in-flight `akm` calls are cancelled and session state is dropped. The plugin writes no temporary files, so there is nothing to clean up on disk.

### In-process recall

Automatic recall (the `prompt` hook and the session-start curation) calls `curate(query, { limit, type, format })` from `akm-cli/api` instead of starting `akm`. The result is the text the CLI prints, so rendering, the relevance floor and the context budget are unchanged. The call cannot be cancelled, so a timeout (`AKM_CURATE_TIMEOUT`, default 8 s), a session delete or an unload stops *waiting* for it and any late result is dropped. A failure, a timeout, or an `akm-cli` that does not provide `akm-cli/api` degrades to no recall for that turn and is logged (`AKM recall failed`, with the API's error and `code`); the plugin keeps working. The tools, feedback, `akm remember`, the write gate's identity search, hints, workflow summary and extraction still use the CLI.

### Write gate

OpenCode 2.0.26 **does** have a native pre-tool hook that can block: `tool.hook("execute.before")` runs before every tool, may mutate `input`, and a failure with a `Tool.Error` becomes the tool's error result, which the model reads. (Verified against the 2.0.26 binary: an error tagged `_tag: "Tool.Error"` reaches the model with its message intact; an untagged error is reported as a declined call, so the plugin builds the tagged error itself because `@opencode/schema` cannot be imported from a plugin.) The gate is therefore ported with the V1 policy ([`opencode-shared/write-gate.ts`](../opencode-shared/write-gate.ts)): when a file the session **read** declares a format (`apiVersion`, `$schema`, a yaml-language-server pragma, an XML default namespace) that the bundle documents, and the session has not opened that asset, the first `edit`/`write` to the file is blocked once with a message naming the asset; repeating it proceeds. Same as V1, the default mode is `observe` (ledger only, nothing blocked); `AKM_WRITE_GATE=enforce` blocks and `off` disables it, and every watched call writes exactly one `write_gate` event with a named reason.

Differences from V1: the tools are `edit {path, oldString, newString}`, `write {path, content}` and, on `gpt-*` models, `patch {patchText}` (V1: `filePath` and `apply_patch`). As in V1 the gate cannot resolve a file from a patch envelope, so `patch` is a typed skip with one warning. A `read` result carries the file's raw text as structured `output.content`, which the gate scans directly instead of V1's numbered `<content>` rendering.

### Shell environment

`shell.hook("create.before")` is V2's native equivalent of V1's `shell.env`: the host passes the full environment it is about to spawn a shell with and the plugin mutates it. Every shell the agent starts gets `AKM_PROJECT` (the project root), `AKM_PLUGIN_VERSION` and, when known, `AKM_BUNDLE_DIR` (from `AKM_BUNDLE_DIR` or `akm info`, asked once and cached). Verified against the 2.0.26 binary: a model-issued `shell` call sees the variables. This also applies to terminals the host creates through the same path.

Differences from V1 in general: V1 awaits some hooks synchronously; V2's helpers are asynchronous (pending count, bundle dir, negative feedback). `opencode run` hands the prompt to the hook as a JSON string literal; the plugin unwraps it exactly as V1 does so start-anchored signals still match. V2 has no equivalent of V1's bundle-missing warning in the hints, nor of V1's "AKM user feedback recorded" log line per message.

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
| `AKM_AUTO_FEEDBACK` / `AKM_AUTO_LEARNING` / `AKM_AUTO_SKILL_PROPOSALS` / `AKM_LEARNING_PROPOSAL_MIN_CONFIDENCE` / `AKM_LEARNING_PROPOSAL_TIMEOUT_MS` | `1` / `1` / `1` / `0.75` / `600000` | Auto-feedback and learning proposals, as in V1. |
| `AKM_WRITE_GATE` | `observe` | `off`, `observe` or `enforce`. |
| `AKM_BUNDLE_DIR` | unset | Bundle location exported to shells and used to validate refs; otherwise asked from `akm info`. |
| `AKM_PENDING_PROPOSAL_TIMEOUT` | `2` | Seconds allowed for the pending-proposal count. |
| `AKM_EXTRACT_MIN_INTERVAL_MS` | `600000` | Minimum gap between extractions for one session. |
| `AKM_SCOPE_KEYS` | `user,agent,run,channel` | Which scope flags `akm_remember` forwards. |

## Compatibility and updating

Both plugins pin the same `akm-cli` and use only its public CLI, against the same AKM databases. Update order: install or upgrade `akm-cli` first (or let the plugin's dependency do it), then the plugin matching your OpenCode major. A new `akm-opencode-v2` release never changes `akm-opencode`'s default export or `latest` tag, and vice versa. Moving from OpenCode 1 to 2 means replacing `akm-opencode` with `akm-opencode-v2` in the new host's configuration; AKM data is untouched.

### Verification receipt

Round 1, with recall still going through the CLI: verified against the real binary `@opencode/cli@2.0.26` (`opencode serve`, sandboxed `HOME`/`XDG_*`) with the tarball produced by `npm pack` installed by `npm install`, a local OpenAI-compatible mock standing in for the model (no credentials or paid inference), and a stub `akm` that logs its argv:

- the built plugin loads and reports `status: active`; a load failure is logged by the host (`failed to load plugin`), not disguised as success;
- creating a session delivers `session.created`, and the plugin runs `akm hints`, `akm workflow list --active` and a project-anchored `akm curate`;
- a user prompt runs `akm curate <prompt>` through the `prompt` hook, and the model request that follows carries the recalled block with its provenance banner, the hints and the standing AKM rules in its system message;
- the five tools are offered to the model as direct tool calls, and a model-issued `akm_search` call executes `akm search nginx --detail full --format json` and returns its output as the tool result;
- when the turn ends, `akm proposal extract --type opencode --session-id <the real session id>` runs, and its `LLM_NOT_CONFIGURED` failure is logged with AKM's code and hint;
- a failing `akm` call is logged through OpenCode's logger and the plugin prints nothing to stdout/stderr.

Round 2 (same binary, built `dist/` loaded through a re-exporting plugin directory, mock model, stub `akm`): the shell hook exports `AKM_PROJECT`, `AKM_BUNDLE_DIR` and `AKM_PLUGIN_VERSION` to a model-issued `shell` call; `edit` before an opened asset is blocked in `enforce` and the model receives the gate message; a prompt of "Remember that ..." runs `akm proposal new` and logs `AKM learning proposal submitted`; `akm_show` followed by "thanks, that worked" runs `akm feedback knowledge/inkwell --positive`; the pending count is requested. **In-process recall cannot be exercised for real yet** because no published `akm-cli` provides `akm-cli/api`: against the real binary the plugin logged `AKM recall failed` and carried on, and recall through the API is covered by tests against a fake that follows the contract.

Not verified against the real binary: a real model's use of the tools, compaction and retry behaviour, subagent sessions, `session.deleted` cleanup, and installing the package from the npm registry (it is not published; the plugin was loaded from a directory that re-exports the installed `dist/`). `tests/opencode-v2-plugin.test.ts` covers these paths with a fake host context and a fake `akm`.

## Locking down destructive commands

Same as V1: the plugin does not gate `akm` commands, and agents should get explicit user approval before `proposal accept|reject|revert`, `sync --push`, `remove`, env/secret writes, `task add|run`, `upgrade`, `update --all` or `config set`. See [opencode/README.md](../opencode/README.md#locking-down-destructive-commands).

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode 2 plugins](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
