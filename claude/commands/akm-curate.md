---
description: Curate AKM bundle assets for a task or topic and load the top matches into context.
argument-hint: <task or topic>
allowed-tools: Bash(bun *akm-cli/dist/cli.js* curate *)
---

`${CLAUDE_PLUGIN_ROOT}` is this plugin's directory, which carries the AKM CLI; Codex leaves it unfilled, so use the directory this plugin is installed in. Run every AKM command through it, as written below.

The task is the text the user gave with this command (in Claude Code it follows below as `ARGUMENTS:`; in Codex it is the user's request). Run `bun "${CLAUDE_PLUGIN_ROOT}/node_modules/akm-cli/dist/cli.js" curate "<task>" --limit 5 --max-tokens 8000 --format json -q` and report the packed matches back to the user, grouped by asset type.

The `--max-tokens` response already contains the selected local assets' full payloads within one shared token budget. Registry hits are deliberately omitted from packed output. If the packed array is empty, rerun `bun "${CLAUDE_PLUGIN_ROOT}/node_modules/akm-cli/dist/cli.js" curate "<task>" --from all --limit 5 --format json -q` without `--max-tokens` and report its refs or install guidance instead of inventing content. For each packed match, summarize:
- what the asset does
- when it fits this task
- how it should be applied

After using an asset, record `akm feedback <ref> --positive` if it helped. Only if its content was wrong or stale, record `akm feedback <ref> --negative --reason "<what is wrong and what it should say>"`: that lowers its ranking, and a later improve run reads your reason, so be specific. To correct a fact you have verified (ran the command, read the official doc or the source file), also pass `--replace "<exact current text>" --with "<corrected text>" --source "<URL, command or file>"`, copying the `--replace` text verbatim from the asset's file and changing only the wrong words. An asset that simply didn't fit this task is not negative feedback: record nothing. A failed akm command is not feedback on the asset.
