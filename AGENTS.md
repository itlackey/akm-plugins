## Logging Standard

- Plugin runtime code in this repo must never write directly to `console.*`, `process.stdout`, or `process.stderr`.
- OpenCode runtime paths must log through `client.app.log` and degrade unexpected failures into structured results where possible.
- Claude runtime paths must use plugin-local logging/state and fail closed without printing raw diagnostics.
- Add basic error trapping around hooks, tool handlers, SDK calls, and subprocess boundaries so errors are logged instead of escaping silently.
- Exception: dedicated CLI entrypoints and fake CLI shims in eval tooling may write to stdout/stderr only when stream output is the behavior being emulated or tested.

## Extended Searching

You have access to a searchable library of skills, commands, agents, knowledge,
instructions, lessons, workflows, scripts, memories, tasks, sessions, facts, env
configs, and secrets via the `akm` CLI (v0.9.14+).

> The plugin exposes only search, show, curate, feedback, and remember. For other AKM verbs, inspect `akm --help` or `akm <command> --help` before invoking the CLI directly.

**Finding assets:**

Use `akm curate` (primary) for task-oriented discovery — it applies LLM reranking, returns relevance scores, and filters cross-domain noise. Use `akm search` only when you already know an asset exists and need its exact ref.

The curator automatically boosts assets that match the current cwd's project anchor, so an explicit project name in the query is no longer required for ranking. Including it still helps the reranker frame intent — keep concrete task descriptions over abstract ones:
```sh
akm curate "<task>"   # PRIMARY: LLM-reranked, scored; auto-project-boost enabled by default
# Good: akm curate "akm CLI improve command performance analysis" (explicit framing)
# Bad:  akm curate "improve performance analysis"  # too generic — less for the reranker to bite into
```

Fall back to `akm search` only for known-ref lookups:
```sh
akm search "<known name>"              # Only when akm show returned "not found" and you need the exact ref
akm search "<query>" --type script     # Filter by type (agent, command, env, fact, instruction, knowledge, lesson, memory, script, secret, session, skill, task, workflow)
akm search "<query>" --from <source>   # Filter by source: local (default), registry, or all ("--source" was renamed to "--from" in 0.9)
akm search "<query>" --from <name>     # scope to a single configured source name (e.g., --from akm-stash)
akm search "<query>" --include-proposed  # Merge proposed-quality drafts into hits (default search hides them)
```

Project-context ranking is automatic — assets matching the current cwd get a small ranking boost, and usage signals are scoped per-project (no cross-project pollution). Pass `--no-project-context` to disable the boost and the scoped-utility signal for one search, or `--no-track-usage` for a read-only search that does not influence future ranking.
Each hit includes a `ref` you use to retrieve the full asset, plus optional `quality?` (`curated`/`generated`/`proposed`/unknown) and `warnings?` fields.

**Using assets:**
```sh
akm show <ref>                    # Get full asset details
```

What you get back depends on the asset type:
- **script** — A `run` command you can execute directly
- **skill** — Instructions to follow (read the full content)
- **command** — A prompt template with placeholders to fill in
- **agent** — A system prompt with model and tool hints
- **knowledge** — A reference doc. Append `#<heading-slug>` to select one section, e.g. `akm show knowledge/guide.md#auth`; an unmatched fragment lists the available slugs
- **lesson** — A durable learning with required `description` and `when_to_use` frontmatter, normally produced through `akm improve <ref>` and accepted via `akm proposal accept`
- **instruction** — Standing guidance an agent should follow for a domain or repo
- **fact** — A single atomic assertion. A new bundle ships a `facts/conventions/...` set describing the bundle's own asset conventions
- **session** — A captured agent session, the raw material `akm proposal extract` mines for durable insights
- **workflow** — A stateful multi-step procedure driven by `akm workflow run|status|resume`
- **env** — A `.env`-style configuration store. **Only key names surface** — values never appear in JSON, logs, or search indexes. Use `akm env run <ref> -- $SHELL` to load into a shell (never `eval`/`source` raw values).
- **secret** — One standalone sensitive value per file (an API token, a PEM key, a TLS cert). Values never surface

Always search the bundle first when you need a capability. Prefer existing
assets over writing new code.

## Logging and Error Handling Requirements

These requirements apply to all code in this repo, especially plugin runtime code.

- Never write directly to `console.*`, `process.stdout`, or `process.stderr` from plugin runtime code.
- For OpenCode plugin runtime code, route diagnostics through OpenCode app logging (`client.app.log`) and degrade failures into structured results whenever possible.
- For Claude plugin runtime code, use the plugin's local state/logging mechanism and fail closed without printing raw diagnostics to the console.
- Add basic error trapping around lifecycle hooks, tool handlers, SDK calls, subprocess wrappers, and other integration boundaries so unexpected failures are logged and do not escape silently.
- Tests should assert logged failures and structured error results instead of normalizing direct console output from plugin paths.
- Narrow exception: dedicated CLI entrypoints or fake CLI shims used only to emulate a terminal contract may write to stdout/stderr when that stream output is the behavior under test. Keep those cases isolated from plugin runtime code and document them clearly.

**Proposal queue, improve, and task verbs:**
- `akm proposal list` / `akm proposal show <id>` / `akm proposal diff <id>` / `akm proposal accept <id>` / `akm proposal reject <id> --reason "..."` — operate the durable proposal queue. `akm proposal diff` accepts UUID, UUID prefix, or asset ref positionally. Always confirm with the user before `accept`/`reject`.
- `akm proposal drain --policy <personal-stash|conservative|manual|path> [--dry-run] [--promote] [--yes] [--max-accepts N] [--max-diff-lines N] [--older-than D] [--judgment] [--strategy <name>]` — **mutating.** Bulk-triage the standing pending backlog by a deterministic policy (promotes/rejects and commits to git; no batch revert). Always `--dry-run` first; only `--promote --yes` after explicit user approval. This and the automatic `processes.triage` improve pre-pass supersede the old manual proposal-queue management agent session.
- `akm improve [ref|type] [--task "..."] [--strategy <name>]` — generate improvement proposals via the configured agent CLI. Improve strategies (`improve.strategies.<name>`) add a `processes.triage` pre-pass (`{ enabled, applyMode: queue|promote, policy, maxAcceptsPerRun, maxDiffLines, rejectEmpty, judgment }`) and end-of-run git `sync` (`{ enabled, push, message }` with `{timestamp}{date}{time}{scope}{refs}{accepted}` tokens; override via `--sync/--no-sync`, `--push/--no-push`).
- `akm proposal new <type> <name> (--task "..." | --file <path>)` — ask the configured agent CLI to author a brand-new asset and queue it as a proposal.
- `akm proposal extract --type <claude|opencode> --session-id <id>` — mine durable insights out of a native session file and queue them as proposals. Requires a configured LLM engine; without one it exits 78 (`LLM_NOT_CONFIGURED`).
- `akm task add|run|explain|history|sync|doctor` — manage scheduled task assets through the OS scheduler.
- `akm setup` — interactive first-run configuration wizard for humans. Agents should not invoke it directly; use `akm bundle create --dir <path> --set-default` for agent-safe bundle initialization.
- `akm search ... --include-proposed` — merge `quality:"proposed"` drafts into hits.

**Store, workflow, and sync verbs:**
- `akm env list|path|export|run|create|remove` / `akm secret list|run|set` — manage configuration/secret stores (values never echoed)
- `akm workflow status|list|create|resume|abandon|run` — drive stateful runs
- `akm sync [-m "msg"]` — commit (and push, when writable; `--no-push` to skip) a git-backed bundle
- `akm import <file|-> [--name <slug>]` — promote a file into the indexed bundle
- `akm help migrate <version>` — release notes / migration guidance

Use `akm -h` for more options and details on searching and using assets.

## Locking down destructive commands

The akm-plugin used to ship a `PreToolUse` (Claude Code) and
`permission.ask` / `command.execute.before` (OpenCode) hook that
tokenized each bash invocation and blocked a hard-coded list of risky
`akm` subcommands. That gate has been removed in 0.8.0 because tokenized
matching produced false positives on commit messages, heredoc bodies,
and other prose containing `akm <verb>` substrings, and because gating
destructive shell calls is properly the host platform's responsibility.

The replacement is documented in the platform-specific READMEs:

- **Claude Code** — use `permissions.ask` / `permissions.deny` in
  `~/.claude/settings.json`. See
  [claude/README.md "Locking down destructive commands"](./claude/README.md#locking-down-destructive-commands).
- **OpenCode** — no first-class permission DSL exists today; wrap
  `akm` in a confirmation script on `PATH`, or use OS-level access
  controls. See
  [opencode/README.md "Locking down destructive commands"](./opencode/README.md#locking-down-destructive-commands).

Agents should still treat destructive verbs (`proposal accept`, `proposal reject`,
`proposal revert`, `sync --push`, `remove`, env/secret writes, `task add` / `task
run`, `upgrade`, `update --all`, `config set`) as requiring explicit
user approval before invocation — that contract is independent of the
platform's permission machinery.
