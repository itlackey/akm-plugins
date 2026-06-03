Improve existing AKM assets or distill repeated evidence into proposals.

1. Identify the strongest evidence refs or the asset type that needs work.
2. Record negative feedback when justified.
3. Call `akm_help` with `topic: "improve"`.
4. Run `akm improve [<type>|<ref>] [--task "..."]`.
5. List resulting pending proposals and do not accept or reject them without explicit user approval.

Improve-profile config (`profiles.improve.<name>`) shapes the run: `processes.triage` is a triage PRE-pass that drains the pending backlog by a deterministic policy (`{ enabled, applyMode: queue|promote, policy, maxAcceptsPerRun, maxDiffLines, rejectEmpty, judgment }`, same engine as `akm proposal drain`); `sync` (`{ enabled, push, message }`, with `{timestamp}{date}{time}{scope}{refs}{accepted}` message tokens) commits/pushes a git-backed stash at end of run. Override sync with `akm improve --sync/--no-sync` and `--push/--no-push`. Triage + `akm proposal drain` is the built-in replacement for the old manual proposal-management agent session.
