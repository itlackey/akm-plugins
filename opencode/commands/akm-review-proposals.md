Review pending AKM proposals safely.

1. Call `akm_help` with `topic: "proposal"`.
2. Run `akm proposal list --status pending --format json`.
3. For relevant proposals, run `akm proposal show <id>` and `akm proposal diff <id>` (positional id).
4. Summarize the likely accept, reject, or revise outcome.
5. Do not run `akm proposal accept` or `akm proposal reject` unless the user explicitly approves the exact command.
6. For a large backlog, suggest the deterministic bulk path: `akm proposal drain --policy <personal-stash|conservative|manual> --dry-run` to preview, then `--promote --yes` only after explicit approval (mutating; commits to git, no batch revert). This — plus the automatic `processes.triage` pre-pass inside `akm improve` — is the built-in replacement for the old manual proposal-management agent session.
