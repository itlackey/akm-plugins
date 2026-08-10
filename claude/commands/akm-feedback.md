---
description: Record positive or negative feedback on an AKM stash asset.
argument-hint: <ref> <+|-> [note]
allowed-tools: Bash(akm feedback *) Bash(akm show *)
---

Parse `"$ARGUMENTS"` as three parts: an asset concept-ID `ref` (e.g. `skills/code-review`), a sentiment token (`+`, `-`, `positive`, `negative`), and an optional free-form note describing what worked or fell short. A negative signal requires a note.

AKM rejects feedback on ineligible refs: `memories/`, `env/`, `secrets/`, and `lessons/` concepts, plus any concept whose quality is `proposed`. Decline those locally and say why rather than shelling out to be rejected.

Run:

```sh
akm feedback <ref> --positive|--negative --reason "<note>" --format json -q
```

If the ref looks ambiguous, first confirm it with `akm show <ref> --format json` and abort if the ref does not resolve. After recording, confirm the outcome to the user and, when negative, suggest finding a replacement via `/akm-curate`.
