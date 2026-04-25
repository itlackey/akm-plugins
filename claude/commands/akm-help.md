---
description: Discover the right akm CLI command and args for tasks not covered by a first-class slash command.
argument-hint: [task description | subcommand]
---

The Claude AKM plugin ships **first-class slash commands** for the high-value verbs:
`/akm-search`, `/akm-show`, `/akm-agent`, `/akm-cmd`, `/akm-curate`, `/akm-remember`,
`/akm-feedback`, `/akm-evolve`, `/akm-wiki`, `/akm-workflow`, `/akm-vault` (read-only),
`/akm-add`, and `/akm-help` (this command).

Everything else — `save`, `import`, `clone`, `update`, `remove`, `list` (configured sources),
`registry search`, `index` (reindex), `config`, `upgrade`, ad-hoc `run`, and vault writes —
is reached by invoking the raw `akm` CLI through Bash. This command helps you pick the
right invocation.

## Curated quick reference

| Task | Command | Notes | Keywords |
| --- | --- | --- | --- |
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

## How to use this command

1. **If `"$ARGUMENTS"` looks like a single subcommand token** (e.g. `save`, `clone`, `config`,
   `vault`), treat it as a CLI verb and surface the live help by running:

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
