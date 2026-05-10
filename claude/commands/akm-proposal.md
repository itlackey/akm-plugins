---
description: Operate the AKM v0.8.0 proposal queue — list, show, diff, accept, or reject pending drafts.
argument-hint: <list|show|diff|accept|reject> [id] [--reason "..."]
---

Parse `"$ARGUMENTS"`. The first token is the action (`list`, `show`, `diff`, `accept`, `reject`); the second token (when present) is the proposal id; remaining tokens are flags forwarded to the CLI.

Routing:

- **list** — `akm --format json -q proposals`. Forward `--status pending|accepted|rejected` if the user passed it. Render a table of `id`, `ref`, `status`, `kind`, `createdAt`.
- **show** — `akm --format json -q show proposal <id>`. Render the proposal body and any validation warnings.
- **diff** — `akm --format json -q diff proposal <id>`. Render the diff against the live ref so the user can see what would change on accept.
- **accept** — **Confirm with the user before running.** Acceptance promotes a draft into curated content via the same `writeAssetToSource()` write path as `akm remember` and `akm import`. Then run `akm --format json -q accept <id>`. If validation fails the proposal stays `pending`; surface the `warnings` array verbatim.
- **reject** — **Confirm with the user before running.** Rejection archives the proposal under `<stashRoot>/.akm/proposals/archive/<id>/`. Then run `akm --format json -q reject <id> --reason "<reason>"`. Always require a non-empty reason; ask the user if missing.

If the user runs `/akm-proposal` with no arguments, default to `list --status pending`.

After any state-changing call (`accept` / `reject`), report the resulting status and the affected ref so the user can verify.
