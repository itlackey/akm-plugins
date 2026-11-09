---
description: Capture a durable memory in the AKM bundle from the current conversation.
argument-hint: "[optional name or topic hint]"
allowed-tools: Bash(bun *akm-cli/dist/cli.js* remember *)
---

`${CLAUDE_PLUGIN_ROOT}` is this plugin's directory, which carries the AKM CLI; Codex leaves it unfilled, so use the directory this plugin is installed in. Run every AKM command through it, as written below.

Distill the most reusable learning from the current conversation into a concise markdown memory. Prefer durable knowledge (invariants, non-obvious constraints, gotchas, decisions with rationale) over ephemeral chat.

Use the text the user gave with this command (in Claude Code it follows below as `ARGUMENTS:`; in Codex it is the user's request) — if provided — as the memory name or topic hint. Otherwise choose a short kebab-case slug that future searches will match.

`akm remember` reads the memory body from stdin. Persist it with a quoted heredoc so the markdown reaches AKM unexpanded:

```sh
bun "${CLAUDE_PLUGIN_ROOT}/node_modules/akm-cli/dist/cli.js" remember --name <slug> --format json -q <<'MEMORY'
<the distilled markdown memory>
MEMORY
```

Add `--force` only when the user supplied an explicit name, so overwriting is their call. With an auto-picked slug, leave `--force` off and choose a more specific slug if that name is already taken.

Include front matter-free markdown: a one-line summary, then headings for **Context**, **Decision/Learning**, and **References** (link to files, PRs, or AKM refs). Report the resulting `memories/<slug>` ref back to the user.
