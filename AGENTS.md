## Logging Standard

- Plugin runtime code in this repo must never write directly to `console.*`, `process.stdout`, or `process.stderr`.
- OpenCode runtime paths must log through `client.app.log` and degrade unexpected failures into structured results where possible.
- Claude runtime paths must use plugin-local logging/state and fail closed without printing raw diagnostics.
- Add basic error trapping around hooks, tool handlers, SDK calls, and subprocess boundaries so errors are logged instead of escaping silently.
- Exception: dedicated CLI entrypoints and fake CLI shims in eval tooling may write to stdout/stderr only when stream output is the behavior being emulated or tested.

## Extended Searching

You have access to a searchable library of tools, skills, commands, agents,
knowledge, lessons, workflows, vaults, and wikis via the `akm` CLI (v0.7.0+).

> For any AKM verb that isn't a first-class tool/slash-command, agents should call `akm_help` (OpenCode) or `/akm-help` (Claude Code) to discover the right `akm` CLI invocation before reaching for raw flags.

**Finding assets:**

Use `akm curate` (primary) for task-oriented discovery — it applies LLM reranking, returns relevance scores, and filters cross-domain noise. Use `akm search` only when you already know an asset exists and need its exact ref.

Always include the current project name or domain in curate queries:
```sh
akm curate "<task including project name>"   # PRIMARY: LLM-reranked, scored, project-filtered
# Good: akm curate "akm CLI improve command performance analysis"
# Bad:  akm curate "improve performance analysis"  # missing project context — noisy results
```

Fall back to `akm search` only for known-ref lookups:
```sh
akm search "<known name>"              # Only when akm show returned "not found" and you need the exact ref
akm search "<query>" --type script     # Filter by type (script, skill, command, agent, knowledge, memory, lesson, workflow, vault, wiki)
akm search "<query>" --source <source> # Filter by source (e.g., "stash", "registry", "both"; "local" is a legacy alias for "stash")
akm search "<query>" --include-proposed  # Merge proposed-quality drafts into hits (default search hides them)
```
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
- **knowledge** — A reference doc (use `toc` or `section "..."` as positional args, e.g. `akm show knowledge:guide toc`)
- **lesson** — A durable learning with required `description` and `when_to_use` frontmatter, normally produced through `akm improve <ref>` and accepted via `akm accept`
- **wiki** — A page inside a wiki (`wiki:<name>/<page>`) with frontmatter, xrefs, and cited raw sources
- **workflow** — A stateful multi-step procedure driven by `akm workflow start|next|complete|resume`
- **vault** — A `.env`-style secret store. **Only key names surface** — values never appear in JSON, logs, or search indexes. Use `eval "$(akm vault load vault:<name>)"` to load into a shell.

Always search the stash first when you need a capability. Prefer existing
assets over writing new code.

## Logging and Error Handling Requirements

These requirements apply to all code in this repo, especially plugin runtime code.

- Never write directly to `console.*`, `process.stdout`, or `process.stderr` from plugin runtime code.
- For OpenCode plugin runtime code, route diagnostics through OpenCode app logging (`client.app.log`) and degrade failures into structured results whenever possible.
- For Claude plugin runtime code, use the plugin's local state/logging mechanism and fail closed without printing raw diagnostics to the console.
- Add basic error trapping around lifecycle hooks, tool handlers, SDK calls, subprocess wrappers, and other integration boundaries so unexpected failures are logged and do not escape silently.
- Tests should assert logged failures and structured error results instead of normalizing direct console output from plugin paths.
- Narrow exception: dedicated CLI entrypoints or fake CLI shims used only to emulate a terminal contract may write to stdout/stderr when that stream output is the behavior under test. Keep those cases isolated from plugin runtime code and document them clearly.

**New in v0.8.0:**
- `akm proposals` / `akm show proposal <id>` / `akm diff proposal <id>` / `akm accept <id>` / `akm reject <id> --reason "..."` — operate the durable proposal queue. Always confirm with the user before `accept`/`reject`.
- `akm improve [ref|type] [--task "..."]` — generate improvement proposals via the configured agent CLI.
- `akm propose <type> <name> (--task "..." | --file <path>)` — generate a new-asset proposal via the configured agent CLI.
- `akm tasks <subcommand> ...` — manage scheduled task assets through the OS scheduler.
- `akm setup` — interactive first-run configuration wizard for humans. Agents should not invoke it directly; use `akm init` for agent-safe stash initialization.
- `akm search ... --include-proposed` — merge `quality:"proposed"` drafts into hits.

**New in v0.5.0:**
- `akm wiki create|register|list|show|pages|search|stash|lint|ingest|remove` — manage multi-wiki knowledge bases
- `akm vault create|list|show|set|unset|load` — manage secret stores (values never echoed)
- `akm workflow start|next|complete|status|list|create|resume|template` — drive stateful runs
- `akm save [-m "msg"]` — commit (and push, when writable) a git-backed stash
- `akm import <file|-> [--name <slug>]` — promote a file into the indexed stash
- `akm help migrate <version>` — release notes / migration guidance

Use `akm -h` for more options and details on searching and using assets.
