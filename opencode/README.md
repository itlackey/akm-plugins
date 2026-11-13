# akm-opencode

OpenCode **1.x** plugin for [AKM](https://github.com/itlackey/akm). It exposes exactly five public tools and uses lifecycle hooks to bring relevant AKM context into a session. Every AKM call goes through the public `akm` CLI (`--format json`); the plugin imports nothing from `akm-cli` internals. The `akm-cli` dependency is exact-pinned in `package.json` to the tested release, the same pin as `akm-opencode-v2`.

Using OpenCode 2.x? Install [`akm-opencode-v2`](../opencode-v2/README.md) instead. This package's name, entrypoint and single `AkmPlugin` export are unchanged, and `latest` stays on the OpenCode 1 plugin. Tested against OpenCode 1.18.34.

## Installation

Add the plugin to `opencode.json`:

```json
{
  "plugin": ["akm-opencode"]
}
```

The bare name resolves to the `latest` tag, which is still a stable 0.9 build. For the AKM 0.10 plugin use `"akm-opencode@next"` (the prerelease channel) or an exact version such as `"akm-opencode@0.10.261002-beta"`. To update, run `akm upgrade --channel next`, or close OpenCode and run `opencode plugin akm-opencode@<version> -g -f` with an exact version (a tag spec like `@next` reuses its cache directory and is not refreshed).

## Tools

| Tool | Description |
| --- | --- |
| `akm_search` | Search configured bundles or registries. `source` accepts `local`, `registry`, `all`, or a configured bundle name. |
| `akm_show` | Show a concept by `[bundle//]conceptId[#fragment]`. |
| `akm_curate` | Return ranked concepts for a task or topic. Optional `pack` is a token budget that returns the selected local assets' full content in one response; registry hits are omitted from packed items. |
| `akm_feedback` | Record positive or negative feedback for a concept. |
| `akm_remember` | Save durable knowledge as a searchable memory. |

All five tools run the bundled `akm` CLI as a subprocess (`akm search|show|curate ... --format json`, `akm feedback`, `akm remember`), through the helper shared with `akm-opencode-v2` ([`opencode-shared/akm-cli.ts`](../opencode-shared/akm-cli.ts)). Each call therefore pays the CLI's process start-up, about 0.4-0.5 s on akm-cli 0.9.30 (not re-measured on 0.10); the in-process library calls this replaced took 2-30 ms warm. Failures return structured results and are logged through OpenCode app logging.

Use the `ref` returned by search or curate directly with show or feedback. When `akm_curate.pack` is set, the response already includes packed local content, so a separate show call is only needed for omitted or registry-only hits. Concept IDs look like `skills/code-review`, `memories/release-retro`, or `team-playbook//knowledge/deploy#Rollback`.

Search and show
responses preserve canonical `ref` while exposing `selectedRef`, `parentRef`,
fragment ordinal/count and lines, previous/next refs, separate fragment/parent
estimates, and context truncation metadata.

## Lifecycle Hooks

The plugin subscribes to OpenCode lifecycle events. Hook failures are logged through OpenCode app logging and do not interrupt the TUI.

| Event | Behavior |
| --- | --- |
| `session.created` | Warms local data in the background, and prepares a bundle warning (when needed), curated context, and the project's rules and most-used assets for the session. |
| `session.updated` | Backfills the bundle warning for a session the plugin has not prepared yet. It does not re-run session-created work. |
| `chat.message` | Records feedback/memory intent, captures corrections, guardrails, preferences, explicit memories, and positive feedback, and can schedule non-blocking curation. High-confidence durable signals submit asynchronous AKM proposals; recurring task intent across distinct sessions can submit a skill proposal. Only the text you typed counts; the synthetic parts OpenCode adds (an attached file's contents, the Read call that fetched it) are ignored. |
| `experimental.chat.system.transform` | Injects the project's rules and most-used assets, the AKM guidance and cached curated context into the system prompt. The host rebuilds the system prompt on every request, so these blocks are re-injected each turn — including after a compaction — rather than once per session. A session the plugin first sees here (a resumed one) has its rules and list loaded at that request. |
| `tool.execute.before` | The format-declaration write gate: records, in the ledger, the first `edit`/`write` to an existing file that declares a format your bundle documents. It never blocks ([Write gate](#write-gate)). |
| `tool.execute.after` | Tracks concepts used by AKM tools and checkpoints session observations. It also records what a file the session `read` declares about its own format, which is what the write gate above keys on. `write` is deliberately not a source: a file the session created is not one it needs the bundle to explain. The create itself is recorded on the write's `tool.execute.before` pass, so a later read-back of that file cannot re-arm the gate. |
| `shell.env` | Exposes `AKM_PLUGIN_VERSION` and the resolved `AKM_BUNDLE_DIR` to shell tools. |
| `session.idle` | Runs interval-gated memory extraction. Fires after every turn, so it is rate-limited. |
| `session.compacted` | Records a post-compaction event and reloads the project's rules and most-used assets from akm (duplicate events within 10 seconds load once), so the next request carries the current ones. |
| `session.deleted` | Refreshes the local AKM index, warns once if the write gate saw write-path tool calls but never acted on any, then drops all per-session state and the temporary curation file. |

The session observation buffer that retrospective feedback reads from survives every non-terminal event: it is bounded (200 entries) and dropped only on `session.deleted`. Discarding it at `session.idle` would empty it between turns, so "thanks, that worked" would credit nothing in exactly the sessions that used the most assets.

Automatic feedback skips references that AKM reports as ineligible, and no `akm_*` tool call submits feedback on its own. A *successful* `akm_show` / `akm_search` / `akm_curate` only inspected a concept, which is not evidence that it helped, so on OpenCode the positive signal comes from a retrospective confirmation instead. A *failed* call (an error result, a timeout, an ambiguous ref) is not feedback on the asset either, and is only logged, as a warning that names its ref and the error: its ref is not remembered as used, so a later "thanks, that worked" does not credit it and a later correction does not blame it. Same rules as the Claude plugin, which applies them to the `akm` subcommand of a Bash invocation.

### Automatic learning proposals

The chat hook applies the same shared classifier and proposal contract as the Claude plugin. Redacted, high-confidence memories and behavioral signals are project-scoped and submitted with `akm proposal new` as `memory` or `instruction` proposals. The plugin never writes `AGENTS.md`, `CLAUDE.md`, command files, or rules; AKM's proposal queue owns review and all later state changes. Proposal authoring requires the AKM agent profile configured by `akm setup`; outcomes are recorded through OpenCode app logging and the durable proposal ledger. Learning is switched with `akm setup --learning on|off`, on this host and for all bundles; the plugin follows that switch and skips proposals quietly while `akm doctor info` reports learning off.

Praise is captured as supporting evidence and can credit recently used assets, but it does not create an empty proposal. Repeated task intents are compared across sessions in the same project; the default threshold is three distinct sessions before a cross-platform `skill` proposal is submitted. A durable ledger suppresses exact and near-duplicate submissions across OpenCode restarts.

## Locking down destructive commands

The plugin does not gate destructive `akm` commands. The `permission.ask` / `command.execute.before` hook that tokenized each Bash invocation and blocked a hard-coded list of risky `akm` subcommands was removed in 0.8.0: tokenized matching produced false positives on commit messages, heredoc bodies, and any other prose containing an `akm <verb>` substring.

OpenCode has no first-class permission DSL today, so enforce it outside the plugin — wrap `akm` in a confirmation script earlier on `PATH`, or use OS-level access controls.

Independently of any such control, agents should treat these verbs as requiring explicit user approval: `proposal accept`, `proposal reject`, `proposal revert`, `sync --push`, `remove`, env/secret writes, `akm import --type task` / `akm run <task-ref>`, `upgrade`, `update --all`, `config set`.

## Read-only mode

For restricted sessions, set the plugin option `readonly` (a per-plugin OpenCode option, not an akm setting; only the boolean `true` counts, anything else is warned about once and ignored):

```jsonc
{ "plugin": [["akm-opencode", { "readonly": true }]] }
```

Only `akm_curate`, `akm_search`, `akm_show` and `akm_feedback` are registered. Prompt and session-start recall and the injected context still work (the recalled text is injected inline, with hints that do not mention `akm_remember`, and the rules text names the `akm_search` and `akm_show` tools instead of CLI commands). Everything that records is off: session extraction, learning proposals and signals, the pending-proposal and bundle-missing notes, the "Need more AKM context?" hint, the write gate, automatic feedback, `shell.env`, index-on-session-end, and the plugin's event ledger. Usage akm itself records for the read tools, and explicit `akm_feedback` calls, are unchanged.

The plugin does not deny `bash` or file edits. Do that with OpenCode's own `permission` config.

## Settings

The plugin has no environment variables for its settings. They are the `plugins` section of akm's own `config.json` (`AKM_CONFIG_DIR`, else `$XDG_CONFIG_HOME/akm`, else `~/.config/akm`), which the plugin reads itself when OpenCode builds it; the Claude and Codex plugins read the same file ([the Claude plugin's Settings section](../claude/README.md#settings) lists the keys and how redaction fails closed). Every key is optional:

```jsonc
{
  "plugins": {
    "autoFeedback": true,          // the retrospective ("that worked") confirmation
    "indexOnSessionEnd": true,     // `akm index` on `session.deleted` only, never on `session.idle`
    "curateLimit": 5,              // curated results injected per prompt, 1 to 25
    "curateTimeoutSeconds": 8,     // timeout for AKM calls made by hooks
    "pendingProposalTimeoutSeconds": 2,
    "redact": { "pii": false, "highEntropy": false }
  }
}
```

Learning is akm's own switch, `improve.enabled` (`akm setup --learning on|off`): while it is off, no proposal is authored. A wrong value is ignored with a warning in OpenCode's log, and a retired `AKM_*` setting variable is ignored with a warning that names its key. Redaction fails closed: a wrong `redact` value, an unreadable config file, or a retired `AKM_REDACT_PII` / `AKM_REDACT_HIGH_ENTROPY` variable with no config key leaves that redaction on.

Everything that used to be a variable beyond those is a constant: prompt curation is always on, the context budget is 4000 characters, a prompt needs 16 characters to be curated, a tool call may take 60 seconds, the session buffer holds 200 entries, extraction runs at most once per 10 minutes per session, state files are capped at 1 MiB, and the confidence and recurrence thresholds are fixed.

The variables that remain are not settings:

| Variable | Purpose |
| --- | --- |
| `AKM_CONFIG_DIR` | Where akm's `config.json` is (akm's own location variable). |
| `AKM_BUNDLE_DIR` | Absolute path to the AKM bundle root (akm's own variable). When unset the plugin discovers it once per process by running `akm doctor info`. The resolved value is exported to shell tools. |
| `AKM_OPENCODE_CLI` | Absolute path to an `akm` executable to run instead of the `akm-cli` dependency, exec'd as-is. Set by akm and by the eval harness. |

### Write gate

The format-declaration write gate (#99) watches `edit`/`write` (and is inert on `apply_patch`, which carries no file path: one warning per process). When a file the session **read** declares a format your bundle documents — an `apiVersion:` namespace, a `yaml-language-server` pragma, a `$schema` key, an XML root namespace — and that asset has not been opened this session, the first `edit`/`write` to that file is recorded in the memory-event ledger as it would have been blocked (ledger reason `observe`). The gate only records: it never blocks a call and has no setting. It never records a file this session created: the create is noted when it happens — a `write` to a path this session has not read, or an `edit` with an empty `oldString` — and that path stays insulated for the rest of the session (ledger reason `session-created`).

## Usage

1. Start with `akm_curate` for task-oriented discovery; set `pack` when you want the selected local content immediately.
2. Use `akm_search` when you know the concept name and need its exact ID.
3. Fetch a concept with `akm_show` before relying on it.
4. Record whether the concept helped with `akm_feedback`; a failed akm call is not feedback on the asset.
5. Use `akm_remember` for durable knowledge that should be available to future sessions.

## Docs

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode custom tools](https://opencode.ai/docs/custom-tools/)
