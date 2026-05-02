---
description: Generate a reflection proposal for an AKM ref via the configured agent CLI; the result lands in the proposal queue.
argument-hint: [ref] [--task "what to reflect on"]
---

Parse `"$ARGUMENTS"` as an optional `[origin//]type:name` ref followed by optional flags (commonly `--task "..."`).

1. Verify `agent.default` is configured: `akm --format json -q config get agent.default`. If empty, suggest the user run `/akm-setup` first and stop.
2. Run `akm --format json -q reflect <ref> [--task "..."]` (omit the ref if the user only passed `--task`). The command shells out to the configured agent CLI (`opencode`, `claude`, `codex`, `gemini`, or `aider`) and writes its output to the proposal queue only — it does not mutate any live stash content.
3. Surface the returned proposal id, kind, and a one-line summary. Tell the user to review with `/akm-proposal show <id>` and then `/akm-proposal accept <id>` or `/akm-proposal reject <id> --reason "..."`.

If the agent CLI fails or times out (default 30 s), the wrapper records the error and no proposal is queued. Surface the error verbatim so the user can decide whether to retry.
