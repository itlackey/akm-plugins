---
description: Show a specific AKM stash asset by ref.
argument-hint: <ref> [toc|frontmatter|section|lines ...]
---

Run:

```sh
akm --format json show "$ARGUMENTS"
```

Summarize the returned asset payload for the user. Preserve structured fields like `prompt`, `template`, `run`, `origin`, `editable`, and `action` when they are relevant to the next step.
