---
description: Manage AKM wikis — scaffold, register external sources, stash raw content, lint, or search a wiki.
argument-hint: <create|register|list|show|pages|search|stash|lint|ingest|remove> [args]
---

Parse `"$ARGUMENTS"` as a subcommand followed by its arguments and route to `akm wiki`.

Recognized subcommands (see the AKM skill for the full contract):

- `create <name>` — scaffold `<stashDir>/wikis/<name>/` with `schema.md`, `index.md`, `log.md`, and `raw/`.
- `register <name> <ref> [--writable] [--max-pages N] [--max-depth N]` — register an existing directory, git repo, or website as a first-class wiki.
- `list` — summaries with page/raw counts and last-modified timestamps.
- `show <name>` — path, description, counts, last 3 log entries.
- `pages <name>` — author-written pages only (excludes schema/index/log/raw).
- `search <name> <query> [--limit N]` — scoped search inside a single wiki.
- `stash <name> <source> [--as <slug>]` — copy a file (or `-` for stdin) into `wikis/<name>/raw/<slug>.md` with frontmatter.
- `lint <name>` — run structural lint (orphans, broken xrefs, missing descriptions, uncited raws, stale index). Exits 1 when findings exist; still emits a JSON report.
- `ingest <name> [--profile <profile>] [--model <alias|id>] [--timeout-ms <ms>]` — dispatch an agent inline to execute the ingest workflow. Requires `defaults.agent` (or an explicit `--profile`) to be configured; the named profile must exist under `profiles.agent`.
- `remove <name> --force [--with-sources]` — remove a wiki. Preserves `raw/` unless `--with-sources` is passed.

Run `akm --format json -q wiki <subcommand> <args>` and report the parsed result back to the user. When running `lint`, report findings grouped by kind (orphan, broken-xref, missing-description, uncited-raw, stale-index, broken-source) and suggest next steps. When running `ingest`, the CLI now dispatches the configured agent inline (using `defaults.agent` unless `--profile` overrides it) — confirm intent with the user before running, surface the returned agent dispatch result, and remind the user that the agent will write pages into the wiki on success. If the user has not configured `defaults.agent`, ask them to run `akm setup` first or pass an explicit `--profile <name>` whose profile already exists under `profiles.agent`.

If the user asks to "refresh" or "reindex" a wiki, run `akm wiki lint <name>` first to surface any structural issues, then regenerate content as needed.
