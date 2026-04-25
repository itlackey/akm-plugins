# AKM help registry

This document is the **canonical source of truth** for the `akm_help` tool (opencode plugin) and the `/akm-help` slash command (Claude plugin). Both surfaces embed a copy of the table below; the parity test in `tests/claude-plugin.test.ts` fails when any row drifts between this file and the embedded copies.

When you change a row here, you must also update:

- `opencode/index.ts` (the `AKM_HELP_QUICK_REFERENCE` constant)
- `claude/commands/akm-help.md` (embedded table)
- `claude/skills/akm/SKILL.md` (embedded table in the `akm_help` quick reference subsection)

## Curated quick reference

| Task | Command | Notes | Keywords |
| --- | --- | --- | --- |
| Install a kit or register an external source (npm, GitHub, git, URL, local dir) | `akm add <package-ref> [--name <n>] [--type wiki] [--writable] [--trust] [--provider <p>] [--max-pages N] [--max-depth N]` | Confirm with the user before passing `--trust` or registering a website crawler. | add, install, register, kit, source, github, npm |
| Commit (and optionally push) pending stash changes | `akm save [<source-name>] [-m <msg>] [--push]` | Add `--push` only when the stash is writable; review the diff first. | save, commit, push, publish, git |
| Import a file (or stdin) into the stash as a typed asset | `akm import <path|-> [--name <name>] [--force]` | Use `-` and pipe content via stdin to import a string. | import, ingest, upload, stdin |
| Clone an asset from any source for editing | `akm clone <ref> [--name <new>] [--dest <dir>] [--force]` | Type subdirectory is appended automatically; ref may include origin (e.g. `npm:@scope/pkg//script:foo`). | clone, copy, fork, edit |
| Update a managed source (or all of them) | `akm update [<package_ref>|--all] [--force]` |  | update, upgrade kit, refresh, pull |
| Remove a configured source and reindex | `akm remove <id|ref|path|url|name>` | Destructive — confirm intent before running. | remove, uninstall, delete source |
| List configured sources (local dirs, kits, remotes) | `akm list` |  | list, sources, kits, show sources |
| Search the registry only (skip local stash) | `akm registry search <query> [--limit N] [--assets]` | `akm_search` with `source='registry'` covers most cases; this is the explicit form. | registry, search registry, installable, discover kit |
| Build or rebuild the stash search index | `akm index` | Rarely needed — the index refreshes implicitly after writes. | index, reindex, rebuild |
| View or update akm config (get/set/list/unset/path) | `akm config <action> [<key>] [<value>] [--all]` | `akm config path --all` prints config, stash, cache, and index paths. | config, settings, configure, path |
| Check for or install an akm CLI update | `akm upgrade [--check] [--force]` |  | upgrade cli, update cli, self-upgrade |
| Run a stash script end-to-end (resolve → show → run) | `akm show <script-ref> # then exec the printed `run` command` | Or `akm --format json -q show <ref>` and pipe `.run` into your shell. | run, execute, script, exec |
