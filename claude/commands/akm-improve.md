---
description: Generate AKM improvement proposals for an asset ref, asset type, or the broader stash.
argument-hint: [<type>|<ref>] [--task "extra guidance"] [--dry-run]
---

Parse `"$ARGUMENTS"` as an optional asset type or `[origin//]type:name` ref, followed by optional `--task` and `--dry-run` flags.

1. Verify `agent.default` is configured: `akm --format json -q config get agent.default`. If empty, tell the user agents cannot run `akm setup` for them; ask them to run `akm setup` manually, then stop.
2. Run `akm --format json -q improve [<type>|<ref>] [--task "..."] [--dry-run]`.
3. Explain that `improve` replaces the old reflect/distill split in AKM v0.8.0 and writes only to the proposal queue.
4. If this was not a dry run, surface the returned proposal ids or plan summary, then route the user through `/akm-proposal show <id>` and `/akm-proposal accept <id>` or `/akm-proposal reject <id> --reason "..."`.

Use `/akm-improve memory:<name>` or `/akm-improve lesson` when the goal is to distill repeated evidence or clean up memory-driven assets.
