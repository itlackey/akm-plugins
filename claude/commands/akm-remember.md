---
description: Capture a durable memory in the AKM stash from the current conversation.
argument-hint: [optional name or topic hint]
---

Distill the most reusable learning from the current conversation into a concise markdown memory. Prefer durable knowledge (invariants, non-obvious constraints, gotchas, decisions with rationale) over ephemeral chat.

Use `"$ARGUMENTS"` — if provided — as the memory name or topic hint. Otherwise choose a short kebab-case slug that future searches will match.

Write the memory to stdin and persist it with:

```sh
akm --format json -q remember --name <slug> --force
```

Include front matter-free markdown: a one-line summary, then headings for **Context**, **Decision/Learning**, and **References** (link to files, PRs, or stash refs). Report the resulting `memory:<slug>` ref back to the user.
