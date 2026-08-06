---
description: Record positive or negative feedback on an AKM stash asset.
argument-hint: <ref> <+|-> [note]
---

Parse `"$ARGUMENTS"` as three parts: an asset concept-ID `ref` (e.g. `skills/code-review`), a sentiment token (`+`, `-`, `positive`, `negative`), and an optional free-form note describing what worked or fell short. A negative signal requires a note.

Run:

```sh
akm feedback <ref> --positive|--negative --reason "<note>" --format json -q
```

If the ref looks ambiguous, first confirm it with `akm show <ref> --format json` and abort if the ref does not resolve. After recording, confirm the outcome to the user and, when negative, suggest finding a replacement via `/akm-curate`.
