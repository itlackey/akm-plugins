---
description: Reject a pending AKM memory candidate and record why.
argument-hint: <candidate-id> [--reason "..."]
---

Read `~/.local/state/akm-claude/memory-candidates.jsonl` (or `$XDG_STATE_HOME/akm-claude/memory-candidates.jsonl`) and locate the candidate id from `"$ARGUMENTS"`.

Extract an optional rejection reason from `--reason "..."`. If the user gave no reason, use a short factual default such as `not durable enough`.

Update the candidate entry in-place to:

- `status: rejected`
- `reason: <reason>`

Report the updated candidate back to the user briefly.

Do not run `akm remember`, `akm feedback`, or `akm propose` from this command.
