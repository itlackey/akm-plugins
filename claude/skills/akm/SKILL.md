---
name: akm
description: Search, show, dispatch agents, execute commands, run workflows, manage wikis, env configs, and whole-file secrets, route the proposal queue, improve assets, and curate stash assets via the akm CLI. Use when the user wants to find or use tools, skills, commands, agents, knowledge, lessons, tasks, wikis, env assets, secrets, or workflows.
---

# AKM Stash

You have access to the `akm` CLI (AKM, v0.9.0+) to manage extension assets from a stash directory.

## Tool surface vs. CLI

The Claude AKM plugin exposes **22 first-class slash commands** for the high-value verbs:

- `/akm-search` — search the stash or registry
- `/akm-show` — fetch the full payload for a ref
- `/akm-agent` — dispatch a stash agent
- `/akm-cmd` — render and execute a stash command template
- `/akm-curate` — pull the top-N curated assets for a task
- `/akm-remember` — record a memory
- `/akm-feedback` — record positive/negative feedback for a ref
- `/akm-evolve` — dispatch the `akm-curator` agent
- `/akm-wiki` — wiki create/register/list/show/pages/search/stash/lint/ingest/remove
- `/akm-workflow` — start/next/complete/status/list/create/resume/template
- `/akm-env` — env `list` / `path` (file path) / `run` (inject env into child command)
- `/akm-secret` — secret `list` / `path` (absolute file path only; never the bytes)
- `/akm-proposal` — operate the AKM proposal queue (list/show/diff/accept/reject/drain)
- `/akm-review-proposals` — list and diff every pending proposal in one pass
- `/akm-improve` — generate improvement proposals for the stash, a type, or a specific ref
- `/akm-propose` — generate a new-asset proposal via the configured agent CLI
- `/akm-setup` — tell the user to run the interactive `akm setup` wizard manually; agents should not invoke it directly
- `/akm-memory-audit` — inspect recent AKM memory recall, writes, refs, and safety blocks for this Claude session
- `/akm-memory-candidates` — review AKM memory candidates captured from Claude checkpoints and hooks
- `/akm-memory-promote <candidate-id>` — promote a pending AKM memory candidate through the appropriate AKM path
- `/akm-memory-reject <candidate-id>` — reject a pending AKM memory candidate and record why
- `/akm-help` — discover the right raw `akm` invocation for the long tail

For every other verb — `add` (install kits / register sources), `sync`, `import`, `clone`,
`update`, `remove` (uninstall a source), `list` (configured sources), `registry search`,
`index` (reindex), `config`, `upgrade`, `tasks`, ad-hoc `run`, `agent` (raw agent-CLI shell-out),
env writes (`create` / `remove`), secret writes / command injection (`set` / `run` / `remove`), and any flag not exposed by the slash commands above —
**call `/akm-help` first** to discover the right `akm` CLI form, then run it via Bash.

### akm_help quick reference

This table is the curated long-tail reference, embedded verbatim from
`docs/akm-help-registry.md` (the canonical source). The parity test in
`tests/claude-plugin.test.ts` fails when this table drifts from the canonical doc.

| Task | Command | Notes | Keywords |
| --- | --- | --- | --- |
| Review pending proposals and decide whether to accept, reject, or revise them | `akm proposal list --status pending --format json` | Inspect individual entries with `akm proposal show <id>` and `akm proposal diff <id>` (positional id). Accept/reject requires explicit user approval. | proposal, review proposals, pending proposals, accept proposal, reject proposal |
| Bulk-triage the standing pending proposal backlog by policy | `akm proposal drain --policy <personal-stash|conservative|manual> --dry-run` | Mutating: promotes/rejects in bulk and commits to git (no batch revert). Preview with `--dry-run`, then `--promote --yes` after explicit approval. Supersedes the old manual proposal-management agent session; also runs as the `processes.triage` improve pre-pass. | proposal, drain, triage, backlog, bulk accept, bulk reject |
| Improve existing assets or distill repeated evidence into proposals | `akm improve [<type>|<ref>] [--task "..."]` | `improve` replaces the old reflect/distill flow in v0.8.0. Proposed assets are not curated until accepted. | improve, lesson, reflect, distill, drift, failure |
| Manage scheduled task assets via the OS scheduler | `akm tasks <add|list|show|remove|enable|disable|run|history|sync|doctor> ...` | Tasks are first-class in v0.8.0 but remain a long-tail CLI surface in this plugin. | tasks, scheduled task, cron, launchd, schtasks |
| Create a proposed asset for a coverage gap | `akm propose <type> <name> --task "..."` | Drafts a `quality:"proposed"` asset that lands in the proposal queue — never directly curated. | propose, coverage gap, proposed asset |
| Search including proposed-quality assets | `akm search <query> --include-proposed` | Default search hides drafts; this flag merges them into hits. Do not treat proposed assets as curated until accepted. | include-proposed, proposed quality, lesson |
| Manage whole-file secrets outside chat-safe read paths | `akm secret <set|run|remove> ...` | Use `/akm-secret` for `list` / `path`. Never paste secret values into chat; `set` reads from stdin/--from-file/--from-env and `run` injects into a child process only. | secret, docker secret, pem, token, _FILE |
| Install a kit or register an external source (npm, GitHub, git, URL, local dir) | `akm add <package-ref> [--name <n>] [--type wiki] [--writable] [--provider <p>] [--max-pages N] [--max-depth N] [--allow-insecure]` | Confirm with the user before registering a website crawler or passing `--allow-insecure`. | add, install, register, kit, source, github, npm |
| Commit (and optionally push) pending stash changes | `akm sync [<source-name>] [-m <msg>]` | For writable git-backed sources, sync commits and pushes (`--no-push` to skip); review the diff first. | save, commit, push, publish, git, sync |
| Import a file (or stdin) into the stash as a typed asset | `akm import <path|-> [--name <name>] [--force]` | Use `-` and pipe content via stdin to import a string. | import, ingest, upload, stdin |
| Clone an asset from any source for editing | `akm clone <ref> [--name <new>] [--dest <dir>] [--force]` | Type subdirectory is appended automatically; ref may include origin (e.g. `npm:@scope/pkg//script:foo`). | clone, copy, fork, edit |
| Update a managed source (or all of them) | `akm update [<package_ref>|--all] [--force]` |  | update, upgrade kit, refresh, pull |
| Remove a configured source and reindex | `akm remove <id|ref|path|url|name>` | Destructive — confirm intent before running. | remove, uninstall, delete source |
| List configured sources (local dirs, kits, remotes) | `akm list` |  | list, sources, kits, show sources |
| Search the registry only (skip local stash) | `akm registry search <query> [--limit N] [--assets]` | `akm_search` with `source='registry'` covers most cases; this is the explicit form. | registry, search registry, installable, discover kit |
| Build or rebuild the stash search index | `akm index` | Rarely needed — the index refreshes implicitly after writes. | index, reindex, rebuild |
| View or update akm config (get/set/list/unset/path) | `akm config <action> [<key>] [<value>] [--all]` | `akm config path --all` prints config, stash, cache, and index paths. | config, settings, configure, path |
| Check for or install an akm CLI update | `akm upgrade [--check] [--force]` |  | upgrade cli, update cli, self-upgrade |
| Run a stash script end-to-end (resolve → show → run) | ``akm show <script-ref> # then exec the printed `run` command`` | Or `akm --format json -q show <ref>` and pipe `.run` into your shell. | run, execute, script, exec |

### Stash directory resolution

The stash directory is resolved using a three-tier fallback:
1. **Environment variable** — `AKM_STASH_DIR` (optional override)
2. **Config file** — `stashDir` field in `$XDG_CONFIG_HOME/akm/config.json`
3. **Platform default** — OS-specific default location

Set the stash directory persistently with `akm config set stashDir /path/to/stash` (preferred). The `AKM_STASH_DIR` env var is only needed as a temporary override.

The stash directory contains:

- **skills/** — skill directories containing SKILL.md
- **commands/** — markdown template files
- **agents/** — markdown agent definition files
- **knowledge/** — markdown knowledge files
- **memories/** — markdown memory files recorded with `akm remember`
- **lessons/** — markdown lesson files (`lesson:<name>`) with required `description` and `when_to_use` frontmatter; normally produced through `akm improve <ref>` as a proposed-quality proposal and promoted via `akm proposal accept`
- **tasks/** — scheduled task definitions (`task:<name>`) managed by `akm tasks ...`
- **scripts/** — executable scripts (.sh, .ts, .js, .ps1, .cmd, .bat, .py, .rb, .go, .pl, .php, .lua, .r, .swift, .kt)
- **workflows/** — multi-step procedures (`workflow:<name>`) driven by `akm workflow`
- **env/** — `.env` files (`env:<name>`) whose values are managed by `akm env` and **never** surface in JSON, logs, or search indexes
- **secrets/** — whole-file secrets (`secret:<name>`) whose contents never surface in JSON, logs, search indexes, or `akm show`
- **wikis/** — per-wiki directories (`<stashDir>/wikis/<name>/`) containing `schema.md`, `index.md`, `log.md`, `raw/`, and agent-authored pages referenced as `wiki:<name>/<page>`
- **.akm/proposals/** — AKM proposal queue (one directory per proposal). Drafts here never leak into search or commits; promote them with `akm proposal accept <id>`.

### Multi-source resolution

Assets are resolved from multiple sources in priority order:
1. **working** (origin: `local`) — your local stash directory
2. **search paths** — additional directories configured via `searchPaths` in config
3. **installed** — kits installed from the registry via `akm add`

Search paths let you share curated asset collections across projects without copying files. Configure them with `akm config set searchPaths '["/path/a","/path/b"]'`.

### Asset classification

Assets are classified using a multi-signal matcher system that considers file extension, directory placement, parent directory name, and (for markdown files) content signals such as frontmatter fields and body patterns. This means assets can be correctly classified even if placed outside their canonical directory.

### Refs

Refs use the format `[origin//]type:name`. The known types are `skill`, `command`, `agent`, `knowledge`, `memory`, `lesson`, `script`, `task`, `workflow`, `env`, `secret`, and `wiki`. Simple refs like `script:deploy.sh` search all sources. Origin-qualified refs like `npm:@scope/pkg//script:deploy.sh` or `local//script:deploy.sh` target a specific source.

### Quality

`SearchHit.quality` is an open string set with three well-known values:
- `"curated"` — accepted into the stash; included in default search.
- `"generated"` — auto-generated but accepted; included in default search.
- `"proposed"` — drafts in the proposal queue; **excluded from default search** and only surface via `akm search ... --include-proposed` or the proposal-review commands.

Unknown quality values parse-warn-include (they remain searchable). Treat `proposed` assets as candidates only — never feed them through `akm feedback` until they are promoted via `/akm-proposal accept`. The plugin's auto-feedback hook automatically skips proposed-quality refs.

## Commands

### Build the search index

Scan stash directories, auto-generate missing `.stash.json` metadata, and build a semantic search index.

```bash
akm index [--full]
```

Use `--full` to force a full reindex instead of incremental. Run this after adding new extensions to enable semantic search ranking.

### Search the stash or registry

Find assets using a hybrid search pipeline: semantic embeddings + TF-IDF ranking. Falls back to name substring matching when no index exists.

```bash
akm search [query] [--type skill|command|agent|knowledge|memory|lesson|script|task|workflow|env|secret|wiki|any] [--limit N] [--source stash|local|registry|both|<name>] [--include-proposed]
```

Square brackets denote optional arguments; pipe-separated values denote allowed choices for a single flag.

The response includes `hits` (ranked results), plus diagnostic fields: `timing` (totalMs, rankMs, embedMs), `warnings` (string array of non-fatal issues), and `tip` (contextual usage hint).

- Local and installed stash hits include `ref`, which you pass to `akm show`. Hits also include optional `quality?` (`curated` / `generated` / `proposed` / unknown) and `warnings?` (string array of non-fatal issues).
- Registry hits live under a separate `registryHits` key and include `id`, `installRef`, `action` (contains install guidance).
- Use `--source registry` when the user is looking for installable community kits, or `--source both` to search everything at once. Note: `local` remains a backward-compatible alias for `stash`.
- `--source <name>` scopes the search to a single named source (e.g. `--source itlackey/akm-stash`) — useful when narrowing down to one configured kit.
- `--include-proposed` merges `quality:"proposed"` rows into `hits`; without it, drafts in the proposal queue are hidden from default search.

### Show an asset

Retrieve the full content/payload of an asset using its ref from search results.

```bash
akm show <ref>
```

Returns type-specific payloads:
- **skill** → full SKILL.md content
- **command** → markdown template + description
- **agent** → prompt + description, toolPolicy, modelHint
- **knowledge** → full markdown content (use `toc` or `section "..."` as positional args to navigate, e.g. `akm show knowledge:guide toc`)
- **memory** → recorded memory content
- **script** → execution command, setup, cwd, and run

All show responses include these common fields when using `--detail full`:
- `editable` — boolean indicating whether the asset can be modified in place
- `editHint` — actionable guidance when editable is false (omitted when editable)
- `origin` — source origin identifier (null for working stash)
- `action` — suggested next action for the asset

At default detail level, show responses include: `type`, `name`, `origin`, `action`, `description`, plus type-specific content fields (`prompt`, `template`, `run`, `setup`, `cwd`, `content`, `toolPolicy`, `modelHint`, `agent`, `parameters`).

### Configuration

Show or update configuration stored at `~/.config/akm/config.json` (XDG standard).

```bash
akm config list                 # Show current config
akm config get <key>            # Get a config value
akm config set <key> <value>    # Set a config value
akm config unset <key>          # Remove a config value
akm config path                 # Show config file path
akm config path --all           # Show all paths (config, stash, cache, index)
```

Common keys: `stashDir`, `searchPaths`, `output.format`, `output.detail`, `embedding`, `llm`, `registries`.

### Registry Management

Discover and install kits from npm or GitHub registries.

```bash
akm search "deploy" --source registry   # Search installable registry kits
akm registry search "deploy" --assets   # Search registries including asset hits
akm add <package>                        # Install from npm, github, git, or local dir
akm clone <ref>                          # Copy an asset into the working stash for editing
akm list                                 # List installed registry kits
akm remove <id>                          # Remove an installed kit
akm update [id]                          # Update one installed kit
akm update --all                         # Update all installed kits
akm upgrade --check                      # Check whether akm itself has an update
```

Installed kits become searchable alongside local stash assets. Use `--source registry` with search to query only remote registries.

When the user wants to browse community kits:

1. Run `akm search "<query>" --source registry`.
2. Review the returned `hits` and use the `installRef` and `action` fields from registry results.
3. If the user wants to install a result, run `akm add <installRef>`.
4. If the user wants to customize an installed asset, run `akm clone <origin-qualified-ref>` to copy it into the working stash before editing.

## Dependencies

`akm init` will auto-install [ripgrep](https://github.com/BurntSushi/ripgrep) to `stash/bin/` if not already on PATH. Ripgrep is used for fast candidate filtering during search.

## Workflow

1. Initialize: `akm init` (creates stash dirs, installs ripgrep)
2. Build the index: `akm index`
3. Curate assets for your task (primary): `akm curate "<task>"` — LLM-reranked with relevance scores. It automatically boosts assets matching the current project (cwd-anchored), so an explicit project name in the query is no longer required for ranking, though concrete task descriptions still help the reranker.
4. Inspect a result: `akm show <ref>`
5. Search for a known ref (fallback): `akm search "<known name>"` — only when you know something exists and need its exact ref
6. Search the registry when needed: `akm search "deploy" --source registry`
7. Install kits: `akm add <package>` (optional)

Default output format is JSON. When you need the most compact machine-readable output, prefer `--format json --shape agent`.

## Memories and Feedback

Use memories to persist facts that should be searchable later:

```bash
akm remember "Deployment needs VPN access"
akm remember --name release-retro < notes.md
akm show memory:release-retro
akm search "VPN" --type memory --source stash
```

Use feedback to reinforce helpful assets or down-rank stale ones:

```bash
akm feedback skill:code-review --positive
akm feedback command:release --negative --reason "Outdated for the current repo layout"
```

Auto-feedback (recorded by the plugin hooks on Bash tool success/failure) skips
`memory:*`, `env:*`, `secret:*`, `lesson:*`, and any ref the indexer reports as
`quality:"proposed"`. Lessons take feedback through the proposal queue, not via
direct `akm feedback`. Override an automatic signal by running `akm feedback`
explicitly.

## Proposal queue

All proposal-producing commands (`akm improve`, `akm propose`, plus any plugin-emitted proposals) write through one durable queue at
`<stashRoot>/.akm/proposals/`. Drafts there never leak into search or commits;
acceptance runs full validation before routing through the same single write
path used by `akm remember` and `akm import`.

```bash
akm proposal list                       # all pending drafts
akm proposal list --status pending --format json
akm proposal show <id>                  # render the draft
akm proposal diff <id>                  # diff vs. the live ref (id = UUID / prefix / asset ref)
akm proposal accept <id>                # validate, then promote
akm proposal reject <id> --reason "…"   # archive with reason
akm proposal drain --policy <preset> --dry-run   # preview a deterministic bulk triage of the whole backlog
akm proposal drain --policy <preset> --promote --yes  # bulk promote/reject + commit (mutating; no batch revert)
```

`proposal drain` policies: `personal-stash`, `conservative`, `manual`, or a path to a policy file. Other flags: `--max-accepts <N>`, `--max-diff-lines <N>`, `--older-than <D>`, `--judgment` (opt into the llm/agent/sdk judgment tier), `--profile <p>` (read the triage block from an improve profile). `drain` is the underlying engine for the automatic `processes.triage` improve pre-pass.

Use the slash commands rather than the raw CLI:

- `/akm-review-proposals` — list every pending proposal and diff each one.
- `/akm-proposal list|show|diff` — read-only operations.
- `/akm-proposal accept|reject` — **always confirm with the user before running.** Acceptance promotes a draft into curated content; rejection archives it.
- `/akm-proposal drain` — **mutating; always confirm.** Bulk-triages the standing backlog by policy and commits to git. Preview with `--dry-run` first. `drain` + the automatic `processes.triage` pre-pass is the built-in replacement for the old manual proposal-queue management agent session.

Multiple proposals for the same `ref` coexist without filesystem collisions.
The default `quality` for promoted proposals is set by the proposal itself (most
commonly `curated` after acceptance). To search drafts directly, run
`akm search "<query>" --include-proposed`.

## Lessons

`lesson` is a first-class asset type stored under `<stashDir>/lessons/<name>.md`.
Frontmatter is required:

```markdown
---
description: One-line summary of the lesson.
when_to_use: When this insight applies (problem context, signals, etc.).
---

Body in markdown.
```

The canonical improvement path is **`/akm-improve <ref>`** — run it on a memory,
knowledge doc, or session summary that contains repeated evidence. `improve`
can emit lesson-oriented proposals at `quality:"proposed"`, which the user then reviews
via `/akm-proposal accept`. Direct authoring via `akm import` and `akm
remember`-style flows is also supported.

## Improve / Propose

`/akm-improve` and `/akm-propose` shell out to the configured agent CLI
(`defaults.agent` + `profiles.agent.<name>`, typically configured by the user via `akm setup`; the legacy `agent.default` shape is auto-migrated on load) and write **only** to the proposal
queue — they never mutate live stash content. Use them when:

- An asset misbehaved and you want a corrective draft or lesson proposal → `/akm-improve <ref> [--task "..."]`.
- A coverage gap appeared in the conversation and you want a new draft asset → `/akm-propose <type> <name> --task "..."`.

If `defaults.agent` is unset, the plugin should initialize it to the current platform when possible (writing the canonical `defaults.agent` + `profiles.agent.<name>` shape). If further interactive configuration is still needed, ask the user to run `akm setup` manually. Agents should not invoke the interactive setup flow themselves.

## In-tree LLM gates

0.8.0 removed the flat `llm.features.*` namespace. Bounded in-tree LLM call
sites are gated in two new locations:

- **Non-improve gates** live under `index.metadataEnhance.*`,
  `index.stalenessDetection.*`, and `search.curateRerank.*` in
  `~/.config/akm/config.json`. These control indexer enrichment and the
  `akm curate` reranker.
- **Improve-bound gates** live under
  `profiles.improve.<name>.processes.{reflect,distill,consolidate,triage,...}` —
  each process has its own enabled/mode/profile/timeoutMs/allowedTypes
  knobs that the `akm improve` runner consults.
  - **`processes.triage`** is a triage PRE-pass that drains the standing
    pending backlog before the main improve work, using the same engine as
    `akm proposal drain`: `{ enabled, applyMode: queue|promote, policy,
    maxAcceptsPerRun, maxDiffLines, rejectEmpty, judgment: { mode:
    llm|agent|sdk, profile, timeoutMs } }`. It only fires on whole-stash /
    type-scoped runs. This plus `akm proposal drain` supersedes the old
    manual proposal-queue management agent session.
- **End-of-run git auto-sync** lives at `profiles.improve.<name>.sync` =
  `{ enabled, push, message }` — for a git-backed (`.git`) stash, `akm improve`
  commits (and optionally pushes) when the run finishes. `message` supports
  `{token}` templates (`{timestamp}{date}{time}{scope}{refs}{accepted}`). CLI
  flags override the profile: `--sync`/`--no-sync`, `--push`/`--no-push`. A
  sync/push failure is non-fatal (recorded on `result.sync`).

Refer to the canonical configuration reference in akm-core for the full
shape. Don't flip these without the user's explicit consent — they cost
LLM tokens and may emit network traffic.

## Compound engineering loop

This plugin closes the loop between **using** assets and **improving** them so
the stash gets sharper every session. The hooks installed by this plugin handle
the mechanical parts automatically; you're expected to drive the
intent-bearing parts.

| Phase | Automatic (hooks) | Your responsibility |
| --- | --- | --- |
| Session start | `akm` installed/refreshed; `defaults.agent` (+ a matching `profiles.agent.<name>` entry) initialized to the current platform when missing — the legacy `agent.default` slot is auto-migrated on load; pending proposal count surfaced; `akm hints` injected as context; index warmed in the background. | Skim the hints, agent CLI, and any pending-proposal headline so you know what's queued. If further interactive configuration is still needed, ask the user to run `akm setup` manually. |
| Each user prompt | `akm curate "<prompt>"` runs and its top matches are injected into context as `additionalContext`. | Prefer the curated assets over writing new code; fetch full payloads with `akm show <ref>` before using. |
| Each Bash tool call | Asset refs in the command/output are logged. Auto-feedback skips `memory:*` / `env:*` / `secret:*` / `lesson:*` / `quality:"proposed"` refs and records positive/negative feedback for everything else on success/failure. | When the automatic signal is wrong (e.g. the ref was in a discussion, not actually used), correct with an explicit `akm feedback`. |
| Task completion; session end | Completed-task summaries are mined for memory candidates (no direct memory write); `TaskCompleted` and `PostToolBatch` feed the candidate log for `/akm-memory-candidates`. `SessionEnd` runs `akm index` and fires an async, event-driven `akm extract --session-id <sid>` so durable insights reach the proposal queue without waiting for the periodic `akm improve` extract pass. | Review pending candidates with `/akm-memory-candidates` and promote the useful ones via `/akm-memory-promote <id>`; for a full session retrospective, dispatch `/akm-evolve` (the `akm-curator` agent). |

When you discover a pattern worth keeping, **write it back to the stash**
rather than only answering the user. Options:

- `/akm-remember` (or `akm remember --name <slug>`) — short markdown note (reads stdin).
- `/akm-improve [<type>|<ref>] [--task "..."]` — generate corrective or lesson-oriented proposals via the configured agent CLI. It writes only to the proposal queue.
- `/akm-propose <type> <name> --task "..."` — generate a new-asset proposal via the configured agent CLI. It writes only to the proposal queue.
- `akm import <file>` — promote a drafted file into the knowledge index. Run `/akm-help`
  topic="import" if you need a refresher on the flag surface.
- `akm clone <ref>` + edit — fork an existing asset, then rewrite with your
  improvements. Run `/akm-help` topic="clone" for the full flag surface.
- Call the `akm-curator` agent (or run `/akm-evolve`) at the end of a long
  session to consolidate hot assets, flag cold ones, and draft missing
  coverage.

## Wikis

Wikis are first-class knowledge bases under `<stashDir>/wikis/<name>/`. Each wiki has `schema.md` (rulebook), `index.md` (regenerable catalog), `log.md` (append-only, agent-maintained), `raw/` (immutable ingested sources), and agent-authored pages referenced as `wiki:<name>/<page>`. Wiki names must match `[a-z0-9][a-z0-9-]*`.

```bash
akm wiki create <name>                                # scaffold a new wiki
akm wiki register <name> <ref> [--writable] [--max-pages N] [--max-depth N]
akm wiki list                                         # summaries with counts + last-modified
akm wiki show <name>                                  # path, description, last 3 log entries
akm wiki pages <name>                                 # author-written pages only (excludes schema/index/log/raw)
akm wiki search <name> <query> [--limit N]            # scoped wiki search
akm wiki stash <name> <source> [--as <slug>]          # copy a file/stdin into wikis/<name>/raw/
akm wiki lint <name>                                  # orphan/xref/description/uncited-raw/stale-index checks
akm wiki ingest <name> [--profile <p>] [--model <m>] [--timeout-ms <ms>]  # dispatch an agent inline (uses defaults.agent unless --profile is set)
akm wiki remove <name> --force [--with-sources]       # preserves raw/ by default
```

`register` accepts directory paths, git URLs (`github:owner/repo`, `git+https://…`), and website roots (`https://…`). `--writable` marks a git-backed source as push-writable for `akm sync`.

Page frontmatter fields: `description`, `pageKind`, `xrefs: wiki:<name>/<page>[]` (bidirectional — lint enforces), `sources: raw/<slug>[]`. `wikiRole` is reserved for `index`/`raw`.

`akm wiki lint` exits 1 when findings exist — still returns a JSON report.

## Env

Env assets are whole `.env` files under `<stashDir>/env/<name>.env`, referenced as `env:<name>`. They hold a group of related configuration values (URLs, flags, credentials) for an app or service. **Values never surface in any structured channel** — not in the search index, not in `akm show`, not in any JSON output.

```bash
akm env list                                          # list all env refs
akm env path env:<name>                               # print absolute file path (for --env-file consumers)
akm env run env:<name> -- <cmd>                       # inject env into child process (agent-safe: no stdout)
akm env run env:<name> -- $SHELL                      # interactive shell with env loaded
akm env create --from-file <path>                     # ingest an existing .env (mode 0600, refuses to clobber)
akm env export env:<name> --out <file>                # write re-serialized export lines to file (mode 0600, never stdout)
akm env remove env:<name>                             # delete the env file
```

**Hard rules when handling env assets:**
- Never read or echo env values. Use `akm env run` to inject into a child process; use `akm env path` to hand the file path to a `--env-file`-style consumer.
- Never write env values back to chat, logs, or files.
- Env refs do not accept `akm feedback` (the hooks skip them automatically).

## Secrets

Secrets are whole-file single-value assets under `<stashDir>/secrets/<name>`, referenced as
`secret:<name>`. The entire file is the value. **The contents never
surface in structured output** — not in search, not in `akm show`, and not in the
plugin's typed secret surfaces.

```bash
akm secret list                                         # refs only
akm secret path secret:deploy-key                       # absolute file path only
printf '%s' "$TOKEN" | akm secret set secret:deploy-token
akm secret set secret:deploy-key --from-file ~/.ssh/id_ed25519
akm secret run secret:deploy-token GITHUB_TOKEN -- gh release create v1.0.0
akm secret remove secret:deploy-token --yes
```

**Hard rules when handling secrets:**
- Prefer `/akm-secret list|path` for chat-safe discovery. Use raw `akm secret …` for `set`, `run`, and `remove` only after explicit user confirmation.
- Never print or paste a secret value into chat, logs, or files.
- Prefer `akm secret path` plus `_FILE`-style consumers when possible; `akm secret run` puts the value in a child process environment for that process lifetime.
- Secret refs do not accept `akm feedback` (the hooks skip them automatically).

## Workflows

Workflows are stateful multi-step procedures. A workflow is an asset (`workflow:<name>`) that describes ordered steps; a **run** is a live instance driven forward with `akm workflow next` / `complete`.

```bash
akm workflow template                                 # print the starter markdown to stdout
akm workflow create <name> [--from <file>] [--force] [--reset]
akm workflow start <ref> [--params <json>]            # → { runId, ... }
akm workflow next <target> [--params <json>]          # target = runId OR workflow ref (auto-starts)
akm workflow complete <runId> --step <id> [--state completed|blocked|failed|skipped] [--notes "..."] [--evidence <json>]
akm workflow status <target>                          # runId OR workflow ref (resolves most recent run)
akm workflow list [--ref <workflow>] [--active]
akm workflow resume <runId>                           # flip blocked/failed → active
```

When the user asks you to run a workflow, prefer `akm workflow next <ref>` for the first call (auto-starts a new run) and then track the returned `runId` for subsequent `complete`/`next` calls.

## Saving and importing

`akm sync` and `akm import` are no longer first-class slash commands — they live in the
curated long-tail table above. To persist stash edits at the end of a session, run
`/akm-help` topic="sync" to confirm the exact invocation, then run `akm sync …` via Bash.
To promote a drafted markdown file as a first-class asset, run `/akm-help` topic="import"
and then `akm import …` via Bash.

Other long-tail verbs covered the same way: `akm help migrate <version>` (release notes),
`akm config enable skills.sh` / `akm config disable skills.sh` (toggle the skills.sh registry provider).

## Dispatching Stash Agents

You can dispatch a stash agent as a dedicated Claude Code CLI session. The agent's prompt, tool constraints, and model preferences are defined in its markdown file and translated into Claude CLI flags at dispatch time.

### Agent payload shape

`akm show <agent-ref>` returns JSON:

```json
{
  "type": "agent",
  "name": "coach.md",
  "path": "/stash/agents/coach.md",
  "description": "Code review coach",
  "prompt": "You are a code review coach. Focus on ...",
  "toolPolicy": { "read": true, "edit": false, "bash": false },
  "modelHint": "<provider>/<model-id>"
}
```

- `prompt` (required) — the agent's system instructions
- `toolPolicy` (optional) — boolean flags indicating which tool categories the agent should use
- `modelHint` (optional) — preferred `provider/model` (advisory only in Claude Code)

### Dispatch workflow

When the user asks you to dispatch, run, or use a stash agent:

1. **Resolve the ref.** If the user gives a direct ref (e.g. `agent:coach.md`), use it. Otherwise search:
   ```bash
   akm search "<query>" --type agent --limit 1
   ```
   Extract `ref` from the first hit in the `hits` array. Refs use the format `[origin//]type:name` (e.g., `script:deploy.sh`, `npm:@scope/pkg//script:deploy.sh`).

2. **Fetch the agent payload:**
   ```bash
   akm show <ref>
   ```
   Parse the JSON. Verify `type` is `"agent"` and `prompt` is non-empty. If validation fails, inform the user.

3. **Compose the Claude CLI invocation.** Build a one-shot CLI call that embeds the stash agent's persona and the user's task. Enforce `toolPolicy` by passing the resolved tool list through `--allowedTools` — never widen the permission mode to skip the runtime's confirmation prompts entirely, which would ignore the stash agent's own `toolPolicy`:

   ```bash
   claude -p \
     --agents '{"stash-agent":{"description":"{description}","prompt":"{prompt}"}}' \
     --agent stash-agent \
     --model {modelHint-or-default} \
     --allowedTools {tool-list} \
     --no-session-persistence \
     --output-format json \
     --system-prompt '{task/context}'
   ```

4. **Run the CLI through Bash** so this becomes a real Claude Code session with the requested agent, model, and tool constraints enforced by `--allowedTools`.

5. **Report results** to the user. If `modelHint` is absent or invalid, omit `--model` and fall back to the session default.

### Example

User: "Dispatch the coach agent to review src/auth.ts"

You would run:
```bash
akm show agent:coach.md
```
Then spawn a general-purpose subagent with the coach's prompt embedded, tasked with reviewing `src/auth.ts`.

## Executing Stash Commands

You can execute stash command templates by resolving them, rendering argument placeholders, and running the result.

### Command payload shape

`akm show <command-ref>` returns JSON:

```json
{
  "type": "command",
  "name": "review.md",
  "path": "/stash/commands/review.md",
  "description": "Review a file for issues",
  "template": "Review $1 for bugs, security issues, and code quality. Focus on: $ARGUMENTS"
}
```

- `template` (required) — text with `$ARGUMENTS` (full arg string) and positional `$1`, `$2`, ... placeholders

### Template rendering rules

Given arguments `"src/main.ts" --strict`:
- `$ARGUMENTS` → `"src/main.ts" --strict` (the full raw argument string)
- `$1` → `src/main.ts` (first positional arg, quotes stripped)
- `$2` → `--strict` (second positional arg)
- Positional args are split by whitespace. Quoted strings (`"double"`, `'single'`, `` `backtick` ``) are treated as a single argument with quotes removed.

### Execution workflow

When the user asks you to run or execute a stash command:

1. **Resolve the ref.** If the user gives a direct ref (e.g. `command:review.md`), use it. Otherwise search:
   ```bash
   akm search "<query>" --type command --limit 1
   ```
   Extract `ref` from the first hit. Refs use the format `[origin//]type:name`.

2. **Fetch the command payload:**
   ```bash
   akm show <ref>
   ```
   Parse the JSON. Verify `type` is `"command"` and `template` is non-empty.

3. **Render the template.** Replace `$ARGUMENTS` with the full argument string and `$1`, `$2`, etc. with the corresponding positional arguments.

4. **Execute the rendered text:**
   - If it is a shell command (starts with a known CLI tool, contains pipes, redirects, etc.) → execute with the Bash tool.
   - If it is a natural-language instruction or multi-step task → execute with the Agent tool using `subagent_type: "general-purpose"`.
   - If ambiguous, ask the user.

5. **Report results** to the user.

### Example

User: "Run the review command on src/main.ts with --strict"

You would run:
```bash
akm show command:review.md
```
Then render the template replacing `$1` with `src/main.ts` and `$ARGUMENTS` with `src/main.ts --strict`, and execute the resulting instruction.

## Script Execution

Scripts in the stash can be executed directly. The `akm show` response includes a `run` field — a ready-to-execute shell command string.

### Execution workflow

When the user asks you to run or execute a stash script:

1. **Resolve the ref.** If the user gives a direct ref (e.g. `script:deploy.sh`), use it. Otherwise search:
   ```bash
   akm search "<query>" --type script --limit 1
   ```
   Extract `ref` from the first hit.

2. **Fetch the script payload:**
   ```bash
   akm show <ref>
   ```
   Parse the JSON. Verify `type` is `"script"` and `run` is non-empty.

3. **Prepare the environment.** If `setup` is present (e.g. `bun install`), run it first before executing `run`. If `cwd` is present, use it as the working directory.

4. **Execute the command** using the Bash tool with the `run` value:
   ```bash
   # run examples:
   # bash:       cd "/path" && bash "/path/script.sh"
   # bun (ts):   cd "/path" && bun "/path/script.ts"
   # node:       cd "/path" && node "/path/script.js"
   # python:     cd "/path" && python "/path/script.py"
   # powershell: powershell -ExecutionPolicy Bypass -File "/path/script.ps1"
   ```

5. **Report results** to the user.

### Example

User: "Run the deploy script"

You would run:
```bash
akm show script:deploy.sh
```
Extract the `run` field from the response and execute it with the Bash tool.
