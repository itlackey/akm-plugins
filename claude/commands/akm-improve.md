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

Two improve-profile blocks (configured under `profiles.improve.<name>` in `~/.config/akm/config.json`) shape what a run does end to end — surface them when the user asks why `improve` accepted proposals or pushed git:

- **`processes.triage`** — a triage PRE-pass that drains the standing pending backlog before the main improve work. Shape: `{ enabled, applyMode: queue|promote, policy, maxAcceptsPerRun, maxDiffLines, rejectEmpty, judgment: { mode: llm|agent|sdk, profile, timeoutMs } }`. It runs the same deterministic engine as `akm proposal drain` and only fires on whole-stash / type-scoped runs (not single-ref). This plus `akm proposal drain` is the built-in replacement for the old manual proposal-queue management agent session.
- **`sync`** — end-of-run git auto-sync for a git-backed (`.git`) stash. Shape: `{ enabled, push, message }`; `message` supports `{token}` templates (`{timestamp}{date}{time}{scope}{refs}{accepted}`). CLI flags override the profile: `akm improve --sync`/`--no-sync` toggles the end-of-run commit, `--push`/`--no-push` controls whether it pushes. A sync/push failure is non-fatal (surfaced as a warning on `result.sync`). Most default profiles ship `sync` on for git-backed stashes; `quick` ships it off.
