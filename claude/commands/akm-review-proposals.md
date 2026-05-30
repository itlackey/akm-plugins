---
description: List every pending AKM proposal and diff each one in a single pass for review.
argument-hint: [--limit N]
---

Walk the proposal queue in one pass so the user can decide accept / reject / revise:

1. Run `akm --format json -q proposals --status pending`. If the array is empty, report "No pending proposals." and stop.
2. For each proposal in the list (cap at 10 unless the user passed `--limit`):
   - Run `akm --format json -q show proposal <id>` and summarize the `kind`, target `ref`, and the body in 2-3 lines.
   - Run `akm --format json -q diff <id>` and surface the diff (collapsed if longer than 40 lines). `akm diff` takes the proposal id positionally — no `proposal` middle word in 0.8.0.
   - List any `warnings` reported by the validator.
3. After all entries are rendered, present a compact recommendation table per id with three columns: `id`, `ref`, `recommendation` (`accept` / `reject` / `revise`). Choose recommendations based on the diff and validation signal — flag conflicts with curated content as `revise`.
4. **Do not call `akm accept` or `akm reject` from this command.** Always wait for the user to confirm and use `/akm-proposal accept <id>` or `/akm-proposal reject <id> --reason "..."`.
