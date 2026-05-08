---
description: Review AKM memory candidates captured from Claude checkpoints and hooks.
argument-hint: [--session] [--status pending|promoted|rejected]
---

Read `~/.local/state/akm-claude/memory-candidates.jsonl` (or `$XDG_STATE_HOME/akm-claude/memory-candidates.jsonl`).

Parse `"$ARGUMENTS"` for optional filters:

- `--session` — prefer candidates whose `sessionId` matches the current Claude session when available
- `--status <value>` — filter to `pending`, `promoted`, or `rejected`

Render a concise markdown list showing:

- `id`
- `type`
- `scope`
- `confidence`
- `recommendedAction`
- `status`
- short evidence preview

If there are no matches, say so explicitly.

Do not mutate candidate state in this command.
