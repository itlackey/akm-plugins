---
description: Generate a new-asset proposal via the configured agent CLI; the result lands in the proposal queue.
argument-hint: <type> <name> --task "what the asset should do"
---

Parse `"$ARGUMENTS"` as `<type> <name>` followed by required flag `--task "..."`. `<type>` is one of `skill`, `command`, `agent`, `knowledge`, `lesson`, `script`, `workflow`, `wiki`. `<name>` follows the standard ref slug grammar (`[A-Za-z0-9._/\-]+`).

1. Verify `agent.default` is configured: `akm --format json -q config get agent.default`. If empty, suggest `/akm-setup` and stop.
2. Confirm the slug is not already taken: `akm --format json -q show <type>:<name>`. If the asset exists, ask the user whether to pick a different name or use `/akm-reflect <ref>` to revise the existing one.
3. Run `akm --format json -q propose <type> <name> --task "..."`. The configured agent CLI drafts the asset and writes it as a `quality:"proposed"` proposal — it never lands in curated content directly.
4. Surface the proposal id and a one-line summary; route the user through `/akm-proposal show <id>` → `/akm-proposal diff <id>` → `/akm-proposal accept <id>`.

If `--task` is missing, ask the user to provide it before running.
