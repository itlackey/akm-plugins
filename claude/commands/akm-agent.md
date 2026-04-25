---
description: Resolve and dispatch an AKM stash agent from Claude.
argument-hint: <agent-ref-or-query> [task...]
---

Parse `"$ARGUMENTS"` into an agent identifier and an optional task.

- If the first token already looks like `agent:<name>` (or an origin-qualified agent ref), use it directly.
- Otherwise resolve the best match with `akm --format json search "<identifier>" --type agent --limit 1`.
- Fetch the agent with `akm --format json show <ref>`.

Then follow the AKM skill's existing dynamic agent-dispatch flow:
- verify the payload is an agent with a non-empty `prompt`
- compose the subagent prompt from the stash agent prompt plus the user task
- dispatch it through Claude's subagent tooling

When the agent finishes, summarize the result and mention the stash ref that powered it.
