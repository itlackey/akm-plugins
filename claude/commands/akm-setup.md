---
description: Tell the user to run the interactive `akm setup` wizard manually. Agents should not invoke it directly.
---

`akm setup` is the human-facing interactive configuration wizard. Do not run it from the agent.

1. Explain that `akm setup` is interactive and intended for a human terminal session.
2. Tell the user to run `akm setup` themselves if they want to configure stash location, providers, semantic search, registries, sources, output defaults, or agent CLI selection.
3. If the task is only to create the working stash for agent-safe workflows, prefer `akm init` instead.
4. After the user completes setup, you may confirm by reading back `akm --format json -q config get agent.default` if they asked whether an agent CLI was configured.

Without an agent CLI on PATH, `/akm-improve` and `/akm-propose` cannot generate agent-backed proposals. Suggest the user install one (for example `opencode`, `claude`, `codex`, `gemini`, or `aider`) and then run `akm setup` manually.
