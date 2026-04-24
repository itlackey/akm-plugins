---
description: Drive AKM workflow runs — start, step, complete, resume, inspect status.
argument-hint: <start|next|complete|status|list|create|resume|template> [args]
---

Parse `"$ARGUMENTS"` as a subcommand followed by its arguments and route to `akm workflow`.

Recognized subcommands:

- `start <workflow-ref> [--params <json>]` — start a new run of `workflow:<name>`. Returns `{ runId, ... }`.
- `next <target> [--params <json>]` — advance a run. `<target>` may be a `runId` or a workflow ref (passing a ref auto-starts a new run).
- `complete <runId> --step <id> [--state completed|blocked|failed|skipped] [--notes "..."] [--evidence <json>]` — record a step transition. Default state is `completed`.
- `status <target>` — show the current state of a run (`runId` or workflow ref for most recent run).
- `list [--ref <workflow>] [--active]` — enumerate runs; `--active` restricts to non-terminal runs.
- `create <name> [--from <file>] [--force] [--reset]` — author a new workflow asset. `--force` requires `--from` or `--reset`.
- `resume <runId>` — flip a `blocked` or `failed` run back to active.
- `template` — print the starter markdown template to stdout.

Run `akm --format json -q workflow <subcommand> <args>` and report the result. For `start` and `next`, capture the returned `runId` and offer to run the next step. For `complete`, confirm with the user before transitioning to a non-default state (`blocked`, `failed`, `skipped`). For `list --active`, surface any stuck runs the user may want to resume.

When the user says "run workflow X" without specifying a runId, prefer `akm workflow next workflow:<X>` — it auto-starts a fresh run and performs the first step in one call.
