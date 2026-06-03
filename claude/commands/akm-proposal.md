---
description: Operate the AKM v0.8.0 proposal queue — list, show, diff, accept, reject, or drain pending drafts.
argument-hint: <list|show|diff|accept|reject|drain> [id] [--reason "..."]
---

Parse `"$ARGUMENTS"`. The first token is the action (`list`, `show`, `diff`, `accept`, `reject`, `drain`); the second token (when present) is the proposal id; remaining tokens are flags forwarded to the CLI.

Routing:

- **list** — `akm --format json -q proposal list`. Forward `--status pending|accepted|rejected` if the user passed it. Render a table of `id`, `ref`, `status`, `kind`, `createdAt`.
- **show** — `akm --format json -q proposal show <id>`. Render the proposal body and any validation warnings.
- **diff** — `akm --format json -q proposal diff <id>`. The proposal id (full UUID, UUID prefix, or asset ref) is positional. Render the diff against the live ref so the user can see what would change on accept.
- **accept** — **Confirm with the user before running.** Acceptance promotes a draft into curated content via the same `writeAssetToSource()` write path as `akm remember` and `akm import`. Then run `akm --format json -q proposal accept <id>`. If validation fails the proposal stays `pending`; surface the `warnings` array verbatim.
- **reject** — **Confirm with the user before running.** Rejection archives the proposal under `<stashRoot>/.akm/proposals/archive/<id>/`. Then run `akm --format json -q proposal reject <id> --reason "<reason>"`. Always require a non-empty reason; ask the user if missing.
- **drain** — **Mutating. Confirm with the user before running.** Drains the standing pending backlog by a deterministic triage policy (promotes/rejects in bulk and commits to git). Run `akm --format json -q proposal drain [flags]`. Real flags: `--policy <personal-stash|conservative|manual|path>`, `--dry-run`, `--yes` (required for promotion in non-interactive mode), `--promote` (promote matches; default is queue/stage-only), `--max-accepts <N>`, `--max-diff-lines <N>`, `--older-than <D>`, `--judgment`, `--profile <p>` (read the triage block from an improve profile). **Always run `--dry-run` first** and show the user the planned accept/reject/defer set; there is no batch revert, so a wrong bulk drain must be undone one id at a time. Only add `--promote --yes` after explicit user approval.

If the user runs `/akm-proposal` with no arguments, default to `list --status pending`.

After any state-changing call (`accept` / `reject` / `drain`), report the resulting status and the affected refs so the user can verify.

Note: `proposal drain` (and the automatic `processes.triage` pre-pass folded into `akm improve`) is the built-in/automated path that supersedes the old manual proposal-queue management agent session (the `manage-akm-proposals` skill). Manual per-id `accept`/`reject` remains available for fine-grained review.
