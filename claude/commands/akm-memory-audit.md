---
description: Inspect recent AKM memory recall, writes, refs, and safety blocks for this Claude session.
argument-hint: [--last-prompt|--session|--refs|--safety]
---

Read Claude plugin state from `~/.local/state/akm-claude/` (or `$XDG_STATE_HOME/akm-claude/` when set) and build a compact markdown report.

Primary sources:

- `events.jsonl` — canonical structured events
- `memory-candidates.jsonl` — pending/promoted/rejected candidates
- `memory.log`, `feedback.log`, `session.log` — fallback context when needed

Focus the report based on `"$ARGUMENTS"`:

- `--last-prompt` — last recall decision, query, injected refs, warnings
- `--session` — recent checkpoint/durable writes plus candidate extraction events
- `--refs` — refs observed/injected recently
- `--safety` — recent `safety_blocked` events

Default to a short report with these sections when no flag is provided:

```md
## Last AKM recall
- Recall decision: recalled/skipped
- Reason: ...
- Query: ...
- Injected refs: ...

## Recent memory writes
- memory:... — checkpoint/session

## Recent safety blocks
- akm proposal accept ... — blocked: requires explicit approval
```

Never print raw secrets. Respect the plugin's redacted event data as-is.
