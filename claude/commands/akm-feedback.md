---
description: Record feedback on an AKM bundle asset; negative feedback is only for wrong or stale content, lowers its ranking, and can carry an exact fix.
argument-hint: <ref> <+|-> [note]
allowed-tools: Bash(akm feedback *) Bash(akm show *)
---

Parse the text the user gave with this command (in Claude Code it follows below as `ARGUMENTS:`; in Codex it is the user's request) as three parts: an asset concept-ID `ref` (e.g. `skills/code-review`), a sentiment token (`+`, `-`, `positive`, `negative`), and an optional free-form note describing what worked or what is wrong. A negative signal requires a note.

Negative feedback is only for content that is wrong or stale. It flags the asset and lowers its ranking; the next `akm improve` run may repair its description, title or `when_to_use` from the note, but it does not rewrite the text. So the note must say what is wrong and what it should say (for example: `the deploy step uses --prod, but the flag is now --env production`). Positive feedback only raises the asset's ranking.

To correct a wrong fact in the asset's text, attach the exact fix, but only when you have verified the correct fact (ran the command, read the official doc or the source file) and can cite it in `--source`. Copy each `--replace` verbatim from the asset's file (`akm show <ref> --format json` gives its `path`) and change only the wrong words or lines: no rewording, no added headings or intros. `--replace` and `--with` repeat, paired in order; write `--with=<text>` when the text starts with `-`. akm checks that each `--replace` text appears exactly once and that the frontmatter still parses. If a check fails it records nothing and says why, so fix the text and retry. A valid fix is queued as a proposal for review, showing the reason and source. Without a verified fix, record the note only.

An asset that simply didn't fit the task is not negative feedback: record nothing. A failed akm command (for example `akm show` erroring) is not feedback on the asset — do not record it.

AKM rejects feedback on ineligible refs: `memories/`, `env/`, `secrets/`, and `lessons/` concepts, plus any concept whose quality is `proposed`. Decline those locally and say why rather than shelling out to be rejected.

Run:

```sh
akm feedback <ref> --positive|--negative --reason "<note>" --format json -q
```

With a verified fix:

```sh
akm feedback <ref> --negative --reason "<what is wrong>" --replace "<exact current text>" --with "<corrected text>" --source "<URL, command or file that shows it>" --format json -q
```

If the ref looks ambiguous, first confirm it with `akm show <ref> --format json` and abort if the ref does not resolve. After recording, confirm the outcome to the user and, when negative, suggest finding a replacement via `/akm-curate`.
