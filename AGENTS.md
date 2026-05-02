## Extended Searching

You have access to a searchable library of tools, skills, commands, agents,
knowledge, lessons, workflows, vaults, and wikis via the `akm` CLI (v0.7.0+).

> For any AKM verb that isn't a first-class tool/slash-command, agents should call `akm_help` (OpenCode) or `/akm-help` (Claude Code) to discover the right `akm` CLI invocation before reaching for raw flags.

**Finding assets:**
```sh
akm search "<query>"              # Search by keyword
akm search "<query>" --type script  # Filter by type (script, skill, command, agent, knowledge, memory, lesson, workflow, vault, wiki)
akm search "<query>" --source <source>  # Filter by source (e.g., "stash", "registry", "both"; "local" is a legacy alias for "stash")
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
- **lesson** — A durable learning with required `description` and `when_to_use` frontmatter, normally produced by `akm distill <ref>` and accepted via `akm proposal accept`
- **wiki** — A page inside a wiki (`wiki:<name>/<page>`) with frontmatter, xrefs, and cited raw sources
- **workflow** — A stateful multi-step procedure driven by `akm workflow start|next|complete|resume`
- **vault** — A `.env`-style secret store. **Only key names surface** — values never appear in JSON, logs, or search indexes. Use `eval "$(akm vault load vault:<name>)"` to load into a shell.

Always search the stash first when you need a capability. Prefer existing
assets over writing new code.

**New in v0.7.0:**
- `akm proposal list|show|diff|accept|reject` — operate the durable proposal queue. Always confirm with the user before `accept`/`reject`.
- `akm reflect [ref] [--task "..."]` — generate a reflection proposal via the configured agent CLI.
- `akm propose <type> <name> --task "..."` — generate a new-asset proposal via the configured agent CLI.
- `akm distill <ref>` — distill repeated evidence into a `lesson` proposal (gated by `llm.features.feedback_distillation`).
- `akm setup` — auto-detect installed agent CLIs and persist `agent.default`. Required once per machine for reflect/propose.
- `akm search ... --include-proposed` — merge `quality:"proposed"` drafts into hits.

**New in v0.5.0:**
- `akm wiki create|register|list|show|pages|search|stash|lint|ingest|remove` — manage multi-wiki knowledge bases
- `akm vault create|list|show|set|unset|load` — manage secret stores (values never echoed)
- `akm workflow start|next|complete|status|list|create|resume|template` — drive stateful runs
- `akm save [-m "msg"]` — commit (and push, when writable) a git-backed stash
- `akm import <file|-> [--name <slug>]` — promote a file into the indexed stash
- `akm help migrate <version>` — release notes / migration guidance

Use `akm -h` for more options and details on searching and using assets.
