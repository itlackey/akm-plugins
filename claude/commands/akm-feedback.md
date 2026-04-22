---
description: Record positive or negative feedback on an AKM stash asset.
argument-hint: <ref> <+|-> [note]
---

Parse `"$ARGUMENTS"` as three parts: an asset `ref` (e.g. `skill:code-review`), a sentiment token (`+`, `-`, `positive`, `negative`), and an optional free-form note describing what worked or fell short.

Run:

```sh
akm --format json -q feedback <ref> --positive|--negative --note "<note>"
```

If the ref looks ambiguous, first confirm it with `akm --format json show <ref>` and abort if the ref does not resolve. After recording, confirm the outcome to the user and, when negative, suggest a concrete follow-up (clone and edit the asset, open an issue, or propose a replacement via `/akm-curate`).
