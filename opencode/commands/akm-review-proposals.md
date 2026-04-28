Review pending AKM proposals safely.

1. Call `akm_help` with `topic: "proposal"`.
2. Run `akm proposal list --status pending --format json`.
3. For relevant proposals, run `akm proposal show <id>` and `akm proposal diff <id>`.
4. Summarize the likely accept, reject, or revise outcome.
5. Do not run `akm proposal accept` or `akm proposal reject` unless the user explicitly approves the exact command.
