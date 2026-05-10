---
description: Generate a new-asset proposal via the configured agent CLI; the result lands in the proposal queue.
argument-hint: <type> <name> (--task "what the asset should do" | --file ./prompt.md)
---

Parse `"$ARGUMENTS"` as `<type> <name>` followed by exactly one of `--task "..."` or `--file ./prompt.md`. `<type>` is one of `skill`, `command`, `agent`, `knowledge`, `lesson`, `script`, `workflow`, `wiki`. `<name>` follows the standard ref slug grammar (`[A-Za-z0-9._/\-]+`).

1. Verify `agent.default` is configured: `akm --format json -q config get agent.default`. If empty, tell the user agents cannot run `akm setup` for them; ask them to run `akm setup` manually, then stop.
2. Confirm the slug is not already taken: `akm --format json -q show <type>:<name>`. If the asset exists, ask the user whether to pick a different name or use `/akm-improve <ref>` to revise the existing one.
3. Run `akm --format json -q propose <type> <name> --task "..."` or `akm --format json -q propose <type> <name> --file ./prompt.md`. The configured agent CLI drafts the asset and writes it as a `quality:"proposed"` proposal — it never lands in curated content directly.
4. Surface the proposal id and a one-line summary; route the user through `/akm-proposal show <id>` → `/akm-proposal diff <id>` → `/akm-proposal accept <id>`.

If neither `--task` nor `--file` is present, or if both are present, stop and ask the user to choose exactly one input form.
