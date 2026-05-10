Review pending AKM proposals safely.

1. Call `akm_help` with `topic: "proposal"`.
2. Run `akm proposals --status pending --format json`.
3. For relevant proposals, run `akm show proposal <id>` and `akm diff proposal <id>`.
4. Summarize the likely accept, reject, or revise outcome.
5. Do not run `akm accept` or `akm reject` unless the user explicitly approves the exact command.
