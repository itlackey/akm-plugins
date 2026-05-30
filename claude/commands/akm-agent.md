---
description: Resolve and dispatch an AKM stash agent from Claude.
argument-hint: <agent-ref-or-query> [task...]
---

Parse `"$ARGUMENTS"` into an agent identifier and an optional task.

- If the first token already looks like `agent:<name>` (or an origin-qualified agent ref), use it directly.
- Otherwise resolve the best match with `akm --format json search "<identifier>" --type agent --limit 1`.
- Fetch the agent with `akm --format json show <ref>`.

Then dispatch it as a real Claude CLI agent session:
- verify the payload is an agent with a non-empty `prompt`
- pass the stash agent prompt through `--agents` as a custom agent definition
- select it with `--agent <name>`
- apply `modelHint` via `--model` when it is present and valid
- apply `toolPolicy` via `--tools` / `--allowedTools` so the runtime enforces it
- run the session in non-interactive mode with `-p/--print`

When the agent finishes, summarize the result and mention the stash ref that powered it.
