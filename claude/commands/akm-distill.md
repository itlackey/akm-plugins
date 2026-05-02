---
description: Distill an AKM ref into a proposed `lesson` asset using the bounded in-tree LLM.
argument-hint: <ref>
---

Parse `"$ARGUMENTS"` as a single `[origin//]type:name` ref. Most often `memory:claude-session-…` or `knowledge:<name>`, but any ref akm recognizes is accepted.

1. Distill is gated by `llm.features.feedback_distillation` (default `false`). Check the gate: `akm --format json -q config get llm.features.feedback_distillation`. If the value is not `true`:
   - Tell the user the gate is off and what flipping it implies (LLM tokens cost money; bounded 30 s timeout per call; output goes to the proposal queue, not live content).
   - **Confirm with the user** before flipping it. Only then run `akm --format json -q config set llm.features.feedback_distillation true`.
2. Run `akm --format json -q distill <ref>`. The wrapper produces a `lesson` proposal with required `description` and `when_to_use` frontmatter and queues it under `<stashRoot>/.akm/proposals/<id>/`.
3. If the gated call returns a fallback (e.g. timeout, throw), report the warning verbatim — no proposal will have been queued.
4. On success, surface the proposal id, the distilled `description`, and route the user through `/akm-proposal show <id>` → `/akm-proposal diff <id>` → `/akm-proposal accept <id>`.

Lessons are stored under `lessons/<name>.md` after acceptance and become first-class searchable assets (`lesson:<name>`).
