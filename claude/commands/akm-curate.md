---
description: Curate AKM stash assets for a task or topic and load the top matches into context.
argument-hint: <task or topic>
allowed-tools: Bash(akm curate *) Bash(akm show *)
---

Run `akm curate "$ARGUMENTS" --limit 5 --format json -q` and report the curated matches back to the user, grouped by asset type.

For each non-trivial match, fetch the full payload with `akm show <ref> --format json` and summarize:
- what the asset does
- when it fits this task
- how it should be applied

After using an asset, record `akm feedback <ref> --positive` (or `--negative --reason "<note>"`) so the stash learns from this outcome.
