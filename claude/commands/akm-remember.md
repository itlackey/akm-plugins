---
description: Capture a durable memory in the AKM bundle from the current conversation.
argument-hint: "[optional name or topic hint]"
allowed-tools: Bash(akm remember *)
---

Distill the most reusable learning from the current conversation into a concise markdown memory. Prefer durable knowledge (invariants, non-obvious constraints, gotchas, decisions with rationale) over ephemeral chat.

Use `"$ARGUMENTS"` — if provided — as the memory name or topic hint. Otherwise choose a short kebab-case slug that future searches will match.

`akm remember` reads the memory body from stdin. Persist it with a quoted heredoc so the markdown reaches AKM unexpanded:

```sh
akm remember --name <slug> --format json -q <<'MEMORY'
<the distilled markdown memory>
MEMORY
```

Add `--force` only when the user supplied an explicit name, so overwriting is their call. With an auto-picked slug, leave `--force` off and choose a more specific slug if that name is already taken.

Include front matter-free markdown: a one-line summary, then headings for **Context**, **Decision/Learning**, and **References** (link to files, PRs, or AKM refs). Report the resulting `memories/<slug>` ref back to the user.
