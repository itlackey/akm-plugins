---
description: Record feedback on an AKM bundle asset; negative feedback with a reason queues it for review and a fix.
argument-hint: <ref> <+|-> [note]
allowed-tools: Bash(akm feedback *) Bash(akm show *)
---

Parse the text the user gave with this command (in Claude Code it follows below as `ARGUMENTS:`; in Codex it is the user's request) as three parts: an asset concept-ID `ref` (e.g. `skills/code-review`), a sentiment token (`+`, `-`, `positive`, `negative`), and an optional free-form note describing what worked or fell short. A negative signal requires a note.

Negative feedback is how an asset gets fixed: the next `akm improve` run reviews it and proposes a change based on the note, so the note must say what is wrong and what should change (for example: `the deploy step uses --prod, but the flag is now --env production`). Positive feedback raises the asset's ranking and never triggers a rewrite.

A failed akm command (for example `akm show` erroring) is not feedback on the asset — do not record it.

AKM rejects feedback on ineligible refs: `memories/`, `env/`, `secrets/`, and `lessons/` concepts, plus any concept whose quality is `proposed`. Decline those locally and say why rather than shelling out to be rejected.

Run:

```sh
akm feedback <ref> --positive|--negative --reason "<note>" --format json -q
```

If the ref looks ambiguous, first confirm it with `akm show <ref> --format json` and abort if the ref does not resolve. After recording, confirm the outcome to the user and, when negative, suggest finding a replacement via `/akm-curate`.
