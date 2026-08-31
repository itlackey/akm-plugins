---
description: Curate AKM bundle assets for a task or topic and load the top matches into context.
argument-hint: <task or topic>
allowed-tools: Bash(akm curate *)
---

Run `akm curate "$ARGUMENTS" --limit 5 --pack 8000 --format json -q` and report the packed matches back to the user, grouped by asset type.

The 0.9.7 `--pack` response already contains the selected local assets' full payloads within one shared token budget. Registry hits are deliberately omitted from packed output. If the packed array is empty, rerun `akm curate "$ARGUMENTS" --from all --limit 5 --format json -q` without `--pack` and report its refs or install guidance instead of inventing content. For each packed match, summarize:
- what the asset does
- when it fits this task
- how it should be applied

After using an asset, record `akm feedback <ref> --positive` (or `--negative --reason "<note>"`) so the bundle learns from this outcome.
