---
description: Curate AKM stash assets for a task or topic and load the top matches into context.
argument-hint: <task or topic>
---

Run `akm --detail agent --format text -q curate "$ARGUMENTS" --limit 6` and report the curated matches back to the user, grouped by asset type.

For each non-trivial match, fetch the full payload with `akm --format json show <ref>` and summarize:
- what the asset does
- when it fits this task
- whether it should be cloned, dispatched, or executed

If the user confirms a candidate, proceed to use it: clone with `akm clone <ref>`, dispatch with the AKM skill's agent-dispatch flow, or execute its `run` command directly. After using an asset, record `akm feedback <ref> --positive` (or `--negative` with a note) so the stash learns from this outcome.
