# AKM help registry

This document is the **canonical source of truth** for the `akm_help` tool (opencode plugin) and the `/akm-help` slash command (Claude plugin). Both surfaces embed a copy of the table below; the parity test in `tests/claude-plugin.test.ts` fails when any row drifts between this file and the embedded copies.

When you change a row here, you must also update:

- `opencode/index.ts` (the `AKM_HELP_QUICK_REFERENCE` constant)
- `claude/commands/akm-help.md` (embedded table)
- `claude/skills/akm/SKILL.md` (embedded table in the `akm_help` quick reference subsection)

## Curated quick reference

| Task | Command | Notes | Keywords |
| --- | --- | --- | --- |
| Review pending proposals and decide whether to accept, reject, or revise them | `akm proposal list --status pending --format json` | Inspect individual entries with `akm proposal show <id>` and `akm proposal diff <id>` (positional id). Accept/reject requires explicit user approval. | proposal, review proposals, pending proposals, accept proposal, reject proposal |
| Bulk-triage the standing pending proposal backlog by policy | `akm proposal drain --policy <personal-stash|conservative|manual> --dry-run` | Mutating: promotes/rejects in bulk and commits to git (no batch revert). Preview with `--dry-run`, then `--promote --yes` after explicit approval. Flags: `--max-accepts`, `--max-diff-lines`, `--older-than`, `--judgment`, `--profile`. Supersedes the old manual proposal-management agent session; also runs automatically as the `processes.triage` improve pre-pass. | proposal, drain, triage, backlog, bulk accept, bulk reject |
| Improve existing assets or distill repeated evidence into proposals | `akm improve [<type>|<ref>] [--task "..."]` | `improve` replaces the old reflect/distill flow in v0.8.0. Proposed assets are not curated until accepted. Profiles add a `processes.triage` pre-pass and end-of-run `sync` (commit/push). | improve, lesson, reflect, distill, drift, failure, triage, sync |
| Manage scheduled task assets via the OS scheduler | `akm tasks <add|list|show|remove|enable|disable|run|history|sync|doctor> ...` | Tasks are first-class in v0.8.0 but remain a long-tail CLI surface in this plugin. | tasks, scheduled task, cron, launchd, schtasks |
| Create a proposed asset for a coverage gap | `akm propose <type> <name> --task "..."` | Drafts a `quality:"proposed"` asset that lands in the proposal queue — never directly curated. | propose, coverage gap, proposed asset |
| Search including proposed-quality assets | `akm search <query> --include-proposed` | Default search hides drafts; this flag merges them into hits. Do not treat proposed assets as curated until accepted. | include-proposed, proposed quality, lesson |
| Manage whole-file secrets outside chat-safe read paths | `akm secret <set|run|remove> ...` | Use `/akm-secret` or `akm_secret` for `list` / `path`. Never paste secret values into chat; `set` reads from stdin/--from-file/--from-env and `run` injects into a child process only. | secret, docker secret, pem, token, _FILE |
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
