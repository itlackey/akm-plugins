---
description: Run the akm-curator agent to review recent session activity and evolve the stash.
argument-hint: [optional focus area]
---

Dispatch the `akm-curator` subagent with the following task:

> Review the recent Claude Code session activity (see `~/.local/state/akm-claude/` and the session-summary memories named `memory:claude-session-*`), plus any focus area provided in `"$ARGUMENTS"`. Identify:
>
> 1. Assets that repeatedly helped — promote them by adding crisper descriptions or tags.
> 2. Assets that repeatedly failed — propose edits or deprecations.
> 3. Recurring patterns that are not yet captured — draft new skills, commands, or knowledge documents and write them to the working stash via `akm clone` / file writes.
> 4. Duplicate or conflicting assets — flag them and suggest consolidation.
>
> Produce a concrete action list with the exact `akm` commands or file edits needed. Do not apply destructive changes without explicit user approval.

Use the AKM skill for searching, showing, and cloning assets. After the curator reports back, surface its recommendations to the user and offer to apply each one.
