---
description: Generate AKM improvement proposals for an asset ref, asset type, or the broader stash.
argument-hint: [<type>|<ref>] [--task "extra guidance"] [--dry-run]
---

Parse `"$ARGUMENTS"` as an optional asset type or `[origin//]type:name` ref, followed by optional `--task` and `--dry-run` flags.

1. Verify the AKM default agent is configured by running `akm config get defaults.agent` (the v0.8.0 canonical slot; the legacy `agent.default` shape is auto-migrated on load). If it is missing and the plugin did not initialize it for the current platform, tell the user agents cannot run `akm setup` for them; ask them to run `akm setup` manually, then stop.
2. Run `akm improve [<type>|<ref>] [--task "..."] [--dry-run]`. `akm improve` rejects `--format` in v0.8.0; do not pass that flag.
3. Explain that `improve` replaces the old reflect/distill split in AKM v0.8.0 and writes only to the proposal queue.
4. If this was not a dry run, surface the returned proposal ids or plan summary, then route the user through `/akm-proposal show <id>` and `/akm-proposal accept <id>` or `/akm-proposal reject <id> --reason "..."`.

Use `/akm-improve memory:<name>` or `/akm-improve lesson` when the goal is to distill repeated evidence or clean up memory-driven assets.

Note: in v0.8.0 `--auto-accept` defaults to OFF — proposals stay in the queue for explicit `/akm-proposal accept` review. Pass `--auto-accept=safe` (alias for `=90`) or `--auto-accept=<N>` to enable whole-batch auto-promotion.
