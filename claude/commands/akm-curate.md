---
description: Curate AKM bundle assets for a task or topic and load the top matches into context.
argument-hint: <task or topic>
allowed-tools: Bash(akm curate *)
---

The task is the text the user gave with this command (in Claude Code it follows below as `ARGUMENTS:`; in Codex it is the user's request). Run `akm curate "<task>" --limit 5 --pack 8000 --format json -q` and report the packed matches back to the user, grouped by asset type.

The 0.9.14 `--pack` response already contains the selected local assets' full payloads within one shared token budget. Registry hits are deliberately omitted from packed output. If the packed array is empty, rerun `akm curate "<task>" --from all --limit 5 --format json -q` without `--pack` and report its refs or install guidance instead of inventing content. For each packed match, summarize:
- what the asset does
- when it fits this task
- how it should be applied

After using an asset, record `akm feedback <ref> --positive` if it helped. Only if its content was wrong or stale, record `akm feedback <ref> --negative --reason "<what is wrong and what it should say>"`: that lowers its ranking, and a later improve run reads your reason, so be specific. To correct a fact you have verified (ran the command, read the official doc or the source file), also pass `--replace "<exact current text>" --with "<corrected text>" --source "<URL, command or file>"`, copying the `--replace` text verbatim from the asset's file and changing only the wrong words. An asset that simply didn't fit this task is not negative feedback: record nothing. A failed akm command is not feedback on the asset.
