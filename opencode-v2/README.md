# akm-opencode-v2

OpenCode **2.x** plugin for [AKM](https://github.com/itlackey/akm). It registers the five public AKM tools, brings relevant AKM context into the model request automatically, records feedback and learning proposals from what you tell the model, and hands finished turns to AKM's session extraction.

Using OpenCode 1.x? Install [`akm-opencode`](../opencode/README.md) instead. Install only the plugin that matches your OpenCode major: each is built against its host's plugin API and neither works in the other.

| | `akm-opencode` | `akm-opencode-v2` |
| --- | --- | --- |
| OpenCode | 1.x (tested 1.18.34) | 2.x (built against 2.1.4; loaded against 2.0.26 and 2.1.4) |
| Plugin API | `@opencode-ai/plugin` 1.x | `@opencode/plugin` 2.1.4 (Effect entrypoint) |
| `akm-cli` | exact, in `package.json` | exact, in `package.json` (the same one) |
| Config key | `"plugin": ["akm-opencode"]` | `"plugins": ["akm-opencode-v2@next"]` |

This package depends on neither `opencode-ai` nor `@opencode/cli`. Installing it never installs or replaces your `opencode` binary.

## Installation

Add the plugin to your OpenCode 2 configuration (the `plugins` array in `opencode.json`, or run `opencode plugin add akm-opencode-v2@next`):

```json
{
  "plugins": ["akm-opencode-v2@next"]
}
```

Use `@next` (the prerelease channel) or an exact version such as `akm-opencode-v2@0.10.261002-beta`, not the bare name. OpenCode 2 resolves a bare name to `*`, which excludes prereleases, and every published `akm-opencode-v2` version is a prerelease, so `akm-opencode-v2` alone fails with `No matching version found for akm-opencode-v2@*`.

The `akm-cli` pinned in `package.json` is installed with the plugin and is the `akm` it runs (set `AKM_OPENCODE_CLI` to an absolute path to use another executable). `@opencode/plugin` and `effect` are peer dependencies: OpenCode supplies its own copies at load time, so they are external to the published bundle.

## Tools

The same five tools, with the same descriptions and argument schemas, as the V1 plugin (both read them from [`opencode-shared/tools.ts`](../opencode-shared/tools.ts)): `akm_search`, `akm_show`, `akm_curate`, `akm_feedback`, `akm_remember`. Every tool runs the public `akm` CLI (`akm search|show|curate ... --format json`, `akm feedback`, `akm remember`); nothing imports `akm-cli` internals. A failure comes back to the model as `{"ok":false,"error":...}` and is logged; it is never thrown out of the tool.

## Hook mapping

How each V1 responsibility maps onto the OpenCode 2 plugin API (built against 2.1.4), as implemented:

| V1 responsibility | V2 native mechanism | Behavior |
| --- | --- | --- |
| Prompt recall (`chat.message`) | `session.hook("prompt")` | Applies the shared recall policy to the prompt text. When it warrants recall, calls `curate` **in-process** through `akm-cli/api` (no `akm` process) and waits up to `AKM_RECALL_WAIT_MS` (default 3000) for it, so the recall usually reaches **this** turn's request. A slower curation keeps running and is used on the next request. The same recall query is not run twice in a session. |
| System context (`experimental.chat.system.transform`) | `session.hook("context")` | Appends, in this order and within the 4000-character context budget: the project's rules and most-used assets (loaded when the session starts, or at its first request if the plugin did not see it start, and again when a compaction ends); the recalled block (with its provenance banner: recalled material is reference data, not instructions); the standing AKM rules; the active workflows and pending-proposal note; to the request's last system part. Runs on every request, so compaction and retries keep the context. |
| Auto-feedback (`chat.message` + `tool.execute.after`) | `tool.hook("execute.after")` notes the refs each tool touched; `session.hook("prompt")` reads the user's next message | Same policy as V1 (shared in [`opencode-shared/feedback.ts`](../opencode-shared/feedback.ts)). "Thanks, that worked" credits the last three distinct refs the session touched with `akm feedback --positive`; an explicit correction ("that was wrong") blames the last one with `--negative`, and a softer negative needs a second one within two minutes. A mixed message ("thanks, but it didn't work") credits nothing. A failed akm call never counts as a touched ref, and `memories/`, `env/`, `secrets/` and `lessons/` refs never receive automatic feedback. A tool outcome alone is never feedback. `AKM_AUTO_FEEDBACK=0` turns off the positive path (as in V1, the negative path is not gated by it). |
| Learning proposals (`chat.message`) | `session.hook("prompt")` | Same detection, thresholds and consent as V1 (shared in [`opencode-shared/learning.ts`](../opencode-shared/learning.ts) and `claude/shared/learning-signals.ts`): an explicit "remember ...", a guardrail, a preference or a correction, or a workflow the user keeps repeating, becomes a **proposal** in AKM's review queue (`akm proposal new`, detached). The plugin never writes a memory and never accepts, rejects or drains a proposal: accepting needs the user's explicit approval. Identical proposals are deduplicated, and the min confidence is `AKM_LEARNING_PROPOSAL_MIN_CONFIDENCE` (default 0.75). `AKM_AUTO_SKILL_PROPOSALS=0` switches the recurring-workflow source off. Learning as a whole is switched with `akm setup --learning on|off`, on this host and for all bundles (see [V1](../opencode/README.md#automatic-learning-proposals)). |
| Pending-proposal nag | `session.hook("context")` | While proposals await review (`akm proposal list --status pending`, cached for a minute) the context says how many and that mutating actions need explicit user approval. |
| Write gate (`tool.execute.before`) | `tool.hook("execute.before")` | See "Write gate" below. |
| `shell.env` | `shell.hook("create.before")` | See "Shell environment" below. |
| Tool post-processing | `tool.hook("execute.after")` | Notes touched refs (above), logs the outcome of the plugin's own tools. |
| Session lifecycle (`event`) | `event.subscribe()`, one subscription closed with the plugin scope | `session.created`: prepares the active-workflow summary, project-anchored curation and the project's rules and most-used assets. `session.compaction.ended`: reloads those rules and assets (duplicate events within 10 seconds load once). Subagent child sessions load none. `session.execution.succeeded` (end of a turn, the analogue of V1's `session.idle`): interval-gated session extraction. `session.deleted`: aborts that session's in-flight recall and `akm` calls and drops its state (feedback refs, gate bookkeeping, pending count). Events for other projects' locations are ignored. |
| Five tools | `tool.transform` with JSON Schema inputs | Registered on load; re-registered on tool reload. |
| `client.app.log` | Effect logging (`Effect.logWithLevel`) from the plugin's own fiber context | The Promise plugin API has no logger, so this is an Effect plugin: diagnostics reach OpenCode's logger (its log file; `--print-logs` mirrors it to stderr), redacted with the shared redactor. The plugin never writes to the console. |

Session extraction runs `akm proposal extract --sessions opencode --session-id <id>`, detached, at most once per 10 minutes per session. It requires an LLM engine configured in AKM; without one AKM answers `LLM_NOT_CONFIGURED` and the plugin logs that as a warning (with AKM's code and hint) rather than failing silently.

Unloading the plugin closes its scope: the event subscription ends, hooks and tools are unregistered by the host, in-flight `akm` calls are cancelled and session state is dropped. The plugin writes no temporary files, so there is nothing to clean up on disk.

### In-process recall

Automatic recall (the `prompt` hook and the session-start curation) calls `curate(query, { limit, type, format })` from `akm-cli/api` instead of starting `akm`. The result is the text the CLI prints, so rendering, the relevance floor and the context budget are unchanged. The call cannot be cancelled, so a timeout (`plugins.curateTimeoutSeconds`, default 8 s), a session delete or an unload stops *waiting* for it and any late result is dropped. A failure, a timeout, or an `akm-cli` that does not provide `akm-cli/api` degrades to no recall for that turn and is logged (`AKM recall failed`, with the API's error and `code`); the plugin keeps working. The tools, feedback, `akm remember`, the write gate's identity search, hints, workflow summary and extraction still use the CLI.

### Write gate

The gate ports the V1 policy ([`opencode-shared/write-gate.ts`](../opencode-shared/write-gate.ts)) onto `tool.hook("execute.before")`: when a file the session **read** declares a format (`apiVersion`, `$schema`, a yaml-language-server pragma, an XML default namespace) that the bundle documents, and the session has not opened that asset, the first `edit`/`write` to the file is recorded as it would have been blocked. As in V1 the gate only records (ledger reason `observe`) and never blocks a call; there is no setting. Every watched call writes exactly one `write_gate` event with a named reason.

Differences from V1: the tools are `edit {path, oldString, newString}`, `write {path, content}` and, on `gpt-*` models, `patch {patchText}` (V1: `filePath` and `apply_patch`). As in V1 the gate cannot resolve a file from a patch envelope, so `patch` is a typed skip with one warning. A `read` result carries the file's raw text as structured `output.content`, which the gate scans directly instead of V1's numbered `<content>` rendering.

### Projects

Every `akm` call runs in the session's directory (in-process recall passes it as `cwd`), so akm resolves the user's project from the `projects` entry in its own config. `akm_remember` passes no `--run` or other scope flags. A host can override the project for a session by setting the string `metadata.akm.project` on it, or on the nearest ancestor session that sets one (up to eight levels): the plugin then passes `--project <name>` on that session's `search`, `curate` and `remember` calls, on its recall, on the write gate's search, and on `proposal extract` and `proposal new`. Nothing else is read from session metadata. This needs an `akm-cli` release that includes akm's projects support.

### Shell environment

`shell.hook("create.before")` is V2's native equivalent of V1's `shell.env`: the host passes the full environment it is about to spawn a shell with and the plugin mutates it. Every shell the agent starts gets `AKM_PLUGIN_VERSION` and, when known, `AKM_BUNDLE_DIR` (from `AKM_BUNDLE_DIR` or `akm doctor info`, asked once and cached). Verified against the 2.0.26 binary: a model-issued `shell` call sees the variables. This also applies to terminals the host creates through the same path.

Differences from V1 in general: V1 awaits some hooks synchronously; V2's helpers are asynchronous (pending count, bundle dir, negative feedback). `opencode run` hands the prompt to the hook as a JSON string literal; the plugin unwraps it exactly as V1 does so start-anchored signals still match. V2 has no equivalent of V1's bundle-missing warning, nor of V1's "AKM user feedback recorded" log line per message.

## Read-only mode

For restricted sessions, set the plugin option `readonly` (a per-plugin OpenCode option, not an akm setting; only the boolean `true` counts, anything else is warned about once and ignored):

```jsonc
{ "plugins": [{ "package": "akm-opencode-v2", "options": { "readonly": true } }] }
```

Only `akm_curate`, `akm_search`, `akm_show` and `akm_feedback` are registered. Prompt and session-start recall and the injected context still work (including the "Need more AKM context?" hint), with hints that do not mention `akm_remember`; the injected rules text names the `akm_search` and `akm_show` tools instead of CLI commands. Everything that records is off: session extraction, learning proposals and signals, the pending-proposal and active-workflow notes, the write gate, automatic feedback, the shell environment, and the plugin's event ledger. Usage akm itself records for the read tools, and explicit `akm_feedback` calls, are unchanged.

The plugin does not deny `bash` or file edits. Do that with OpenCode's own `permission` config.

## Settings

The settings are the `plugins` section of akm's own `config.json` (`AKM_CONFIG_DIR`, else `$XDG_CONFIG_HOME/akm`, else `~/.config/akm`), read when the plugin starts, the same keys and rules as [`akm-opencode`](../opencode/README.md#settings): `autoFeedback`, `indexOnSessionEnd` (unused here), `curateLimit`, `curateTimeoutSeconds`, `pendingProposalTimeoutSeconds` and `redact.pii` / `redact.highEntropy`, with learning on akm's `improve.enabled`. A wrong value is ignored with a warning in the host's log; redaction fails closed. The rest are constants: the prompt hook waits up to 3 seconds for curation before the request proceeds without it, a prompt needs 16 characters, injected text is capped at 4000 characters (the rules and most-used assets lead, ahead of the recalled block; they take what the guidance, the note blocks and the recalled block leave; a rule is shown whole or left out, and a note says how many were left out; the most-used list names at most 10 assets and says when it was cut or left out to fit), a tool call may take 60 seconds, extraction runs at most once per 10 minutes per session.

| Variable | Purpose |
| --- | --- |
| `AKM_CONFIG_DIR` | Where akm's `config.json` is (akm's own location variable). |
| `AKM_OPENCODE_CLI` | Absolute path to an `akm` executable to run instead of the `akm-cli` dependency. |
| `AKM_BUNDLE_DIR` | Bundle location exported to shells and used to validate refs; otherwise asked from `akm doctor info`. |

## Compatibility and updating

Both plugins pin the same `akm-cli` and use only its public CLI, against the same AKM databases. Update order: install or upgrade `akm-cli` first (or let the plugin's dependency do it), then the plugin matching your OpenCode major. To update `akm-opencode-v2`, run `opencode plugin check`, then `opencode plugin update`, then restart OpenCode. A tag spec such as `@next` is never re-resolved on restart, so a restart alone does not update it; `plugin update` installs the new build into a new cache folder and leaves the old folders behind; and `plugin list` / `plugin check` print "No plugins found" until the service has loaded its plugins after a restart. A new `akm-opencode-v2` release never changes `akm-opencode`'s default export or `latest` tag, and vice versa. Moving from OpenCode 1 to 2 means replacing `akm-opencode` with `akm-opencode-v2` in the new host's configuration; AKM data is untouched.

### Verification receipt

Round 1, with recall still going through the CLI: verified against the real binary `@opencode/cli@2.0.26` (`opencode serve`, sandboxed `HOME`/`XDG_*`) with the tarball produced by `npm pack` installed by `npm install`, a local OpenAI-compatible mock standing in for the model (no credentials or paid inference), and a stub `akm` that logs its argv:

- the built plugin loads and reports `status: active`; a load failure is logged by the host (`failed to load plugin`), not disguised as success;
- creating a session delivers `session.created`, and the plugin runs `akm workflow list --active` and a project-anchored `akm curate`;
- a user prompt runs `akm curate <prompt>` through the `prompt` hook, and the model request that follows carries the recalled block with its provenance banner and the standing AKM rules in its system message;
- the five tools are offered to the model as direct tool calls, and a model-issued `akm_search` call executes `akm search nginx --detail full --format json` and returns its output as the tool result;
- when the turn ends, `akm proposal extract --sessions opencode --session-id <the real session id>` runs, and its `LLM_NOT_CONFIGURED` failure is logged with AKM's code and hint;
- a failing `akm` call is logged through OpenCode's logger and the plugin prints nothing to stdout/stderr.

Round 2 (same binary, built `dist/` loaded through a re-exporting plugin directory, mock model, stub `akm`): the shell hook exports `AKM_BUNDLE_DIR` and `AKM_PLUGIN_VERSION` to a model-issued `shell` call; `edit` before an opened asset is blocked in `enforce` and the model receives the gate message; a prompt of "Remember that ..." runs `akm proposal new` and logs `AKM learning proposal submitted`; `akm_show` followed by "thanks, that worked" runs `akm feedback knowledge/inkwell --positive`; the pending count is requested. **In-process recall cannot be exercised for real yet** because no published `akm-cli` provides `akm-cli/api`: against the real binary the plugin logged `AKM recall failed` and carried on, and recall through the API is covered by tests against a fake that follows the contract.

A subagent's child session (`session.created` with a `parentID`) is part of its parent's work and its prompt is model-written, so the plugin runs no session-start curation, recall, learning signals or extraction for it; the parent's extraction covers it.

Not verified against the real binary: a real model's use of the tools, compaction and retry behaviour, `session.deleted` cleanup, and installing the package from the npm registry (it is not published; the plugin was loaded from a directory that re-exports the installed `dist/`). `tests/opencode-v2-plugin.test.ts` covers these paths with a fake host context and a fake `akm`.

## Locking down destructive commands

Same as V1: the plugin does not gate `akm` commands, and agents should get explicit user approval before `proposal accept|reject|revert`, `sync --push`, `remove`, env/secret writes, `akm import --type task` / `akm run <task-ref>`, `upgrade`, `update --all` or `config set`. See [opencode/README.md](../opencode/README.md#locking-down-destructive-commands).

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode 2 plugins](https://opencode.ai/v2/docs/build/plugins/migrate-v1)

### Project include defaults

With a core version supporting `--include`, `metadata.akm.project` selects the configured project's `include` just as it selects `from`, `filters` and `prefer`. The core resolves these defaults for session-start curation, prompt recall, bootstrap searches and explicit tools; the plugin never reads per-session retrieval metadata. For example, a project's `"include": { "quality": "proposed", "type": ["session"] }` restores those default exclusions while preserving the query, filters and source boundaries.

Both OpenCode versions' `akm_search` and `akm_curate` tools accept `include: ["quality=proposed", "type=session"]`; explicit selectors replace the project's entire include value. An empty tool list inherits project defaults. Clearing includes uses project config `{}` or the core API `include: {}`. The plugin's pinned core dependency is unchanged; check the runtime core's help for `--include` before using explicit selectors.
