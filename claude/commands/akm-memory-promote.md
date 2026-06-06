---
description: Promote a pending AKM memory candidate through the appropriate AKM path.
argument-hint: <candidate-id>
---

Read `~/.local/state/akm-claude/memory-candidates.jsonl` (or `$XDG_STATE_HOME/akm-claude/memory-candidates.jsonl`), locate the candidate matching `"$ARGUMENTS"`, and inspect its `recommendedAction`.

Promotion rules:

- `remember` — run `akm --format json -q remember --name candidate-<id> --force` with the candidate content on stdin
- `feedback` — if `targetRef` is present, run `akm --format json -q feedback <targetRef> --positive --reason "<content>"`
- `distill` — if `targetRef` is present, run `akm improve <targetRef>` (the `improve` verb rejects `--format` in v0.8.0)
- `propose` — run `akm --format json -q propose knowledge candidate-<id> --task "<content>"`
- `ignore` — do not promote; tell the user to reject it instead

After a successful mutation, update the matching JSONL entry to `status: promoted`.

If the candidate is missing, already rejected, or malformed, stop and explain why.
