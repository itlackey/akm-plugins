---
description: Discover the right akm CLI command and args for tasks not covered by a first-class slash command.
argument-hint: [task description | subcommand]
---

The Claude AKM plugin ships **first-class slash commands** for the high-value verbs:
`/akm-search`, `/akm-show`, `/akm-agent`, `/akm-cmd`, `/akm-curate`, `/akm-remember`,
`/akm-feedback`, `/akm-evolve`, `/akm-wiki`, `/akm-workflow`, `/akm-env` (`list`/`path`/`run`),
`/akm-secret` (`list`/`path`), `/akm-proposal`, `/akm-review-proposals`, `/akm-improve`, `/akm-propose`,
`/akm-setup`, `/akm-memory-audit`, `/akm-memory-candidates`, `/akm-memory-promote`,
`/akm-memory-reject`, and `/akm-help` (this command).

Everything else — `add` (install kits / register sources), `sync`, `import`, `clone`,
`update`, `remove`, `list` (configured sources), `registry search`, `index` (reindex),
`config`, `upgrade`, `tasks`, ad-hoc `run`, env writes, and secret writes / command injection — is reached by invoking the raw `akm`
CLI through Bash. This command helps you pick the right invocation.

## Curated quick reference

<!-- BEGIN GENERATED: akm-help-table (source: docs/akm-help-registry.md; run `node scripts/generate-help-tables.mjs` to refresh) -->
| Task | Command | Notes | Keywords |
| --- | --- | --- | --- |
| Review pending proposals and decide whether to accept, reject, or revise them | `akm proposal list --status pending --format json` | Inspect individual entries with `akm proposal show <id>` and `akm proposal diff <id>` (positional id). Accept/reject requires explicit user approval. | proposal, review proposals, pending proposals, accept proposal, reject proposal |
| Bulk-triage the standing pending proposal backlog by policy | `akm proposal drain --policy <personal-stash|conservative|manual> --dry-run` | Mutating: promotes/rejects in bulk and commits to git (no batch revert). Preview with `--dry-run`, then `--promote --yes` after explicit approval. Flags: `--max-accepts`, `--max-diff-lines`, `--older-than`, `--judgment`, `--profile`. Supersedes the old manual proposal-management agent session; also runs automatically as the `processes.triage` improve pre-pass. | proposal, drain, triage, backlog, bulk accept, bulk reject |
| Improve existing assets or distill repeated evidence into proposals | `akm improve [<type>|<ref>] [--task "..."]` | `improve` replaces the old reflect/distill flow in v0.8.0. Proposed assets are not curated until accepted. Profiles add a `processes.triage` pre-pass and end-of-run `sync` (commit/push). | improve, lesson, reflect, distill, drift, failure, triage, sync |
| Manage scheduled task assets via the OS scheduler | `akm tasks <add|list|show|remove|enable|disable|run|history|sync|doctor> ...` | Tasks are first-class in v0.8.0 but remain a long-tail CLI surface in this plugin. | tasks, scheduled task, cron, launchd, schtasks |
| Create a proposed asset for a coverage gap | `akm propose <type> <name> --task "..."` | Drafts a `quality:"proposed"` asset that lands in the proposal queue — never directly curated. | propose, coverage gap, proposed asset |
| Search including proposed-quality assets | `akm search <query> --include-proposed` | Default search hides drafts; this flag merges them into hits. Do not treat proposed assets as curated until accepted. | include-proposed, proposed quality, lesson |
| Manage whole-file secrets outside chat-safe read paths | `akm secret <set|run|remove> ...` | Use `/akm-secret` or `akm_secret` for `list` / `path`. Never paste secret values into chat; `set` reads from stdin/--from-file/--from-env and `run` injects into a child process only. | secret, docker secret, pem, token, _FILE |
| Read or use `.env`-style config assets without values reaching chat | `akm env <list|path|run> ...` | Chat-safe reads: `list` (key names only), `path <ref>` (file path for `--env-file` consumers), `run <ref> -- <cmd>` (inject into a child process — values never touch stdout). `create`/`set`/`unset`/`remove`/`export` are writes and stay on the raw CLI path; confirm with the user before running them. Use `/akm-env` (Claude) or `akm_env` (OpenCode) for the first-class chat-safe actions. | env, dotenv, environment variables, env file, secrets group |
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
| Extract durable insights from a native agent session file into the proposal queue | `akm extract --type <claude-code|opencode> --session-id <sid>` | Both plugins fire this automatically and asynchronously at session end (event-driven, content-hash deduped — safe to re-run); the hourly `akm improve` extract pass is the backstop for sessions that never fire the hook. `--auto` sweeps every available harness; `--dry-run` previews without queuing. | extract, session insights, distill session, harvest session, extraction |
| Print the current agent-facing usage guide for the akm CLI | `akm hints [--detail brief|normal|full]` | Both plugins inject this at session start as context; `/akm-help` and `akm_help` fall back to it for unmatched topics. `--detail full` prints the complete guide. | hints, guide, cheat sheet, how to use akm, reference |
| Read release notes and migration guidance for an akm CLI version | `akm help migrate <version>` | Bundled per-release notes; an unrecognized version lists what's available. | migrate, migration, release notes, upgrade notes, changelog |
<!-- END GENERATED: akm-help-table -->

## How to use this command

1. **If `"$ARGUMENTS"` looks like a single subcommand token** (e.g. `sync`, `clone`, `config`,
   `env`), treat it as a CLI verb and surface the live help by running:

   ```sh
   akm <subcommand> --help
   ```

   via the Bash tool. Pair the live `--help` output with the matching row from the table
   above (if any) so the user sees both the curated guidance and the long-tail flags.

2. **Otherwise treat `"$ARGUMENTS"` as a free-form task description.** Scan the keyword
   column of the curated table for matches, propose the best `akm` invocation, and explain
   what it will do.

3. **Confirm before destructive or remote actions.** Always ask the user to confirm before
   running anything that writes, deletes, pushes, removes a source, mutates config, or
   contacts a remote registry. Read-only invocations (`akm list`, `akm config get`, etc.)
   may run without explicit confirmation.

4. **Fallback for unknown subcommands.** If neither the curated table nor the user's task
   description matches a known verb, run `akm --help` and surface the top-level command
   list so the user can pick from the long tail.

## See also

- `claude/skills/akm/SKILL.md` — the full AKM skill, including dispatch flows for agents,
  scripts, and commands. Embeds this same quick-reference table under the `akm_help` quick
  reference section.
