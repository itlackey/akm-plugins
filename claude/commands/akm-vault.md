---
description: Read-only access to encrypted-at-rest AKM vaults — list vaults or show key names. Never displays values.
argument-hint: <list | show <ref>>
---

Vaults are `.env`-style key/value stores under `<stashDir>/vaults/<name>.env`. **This
slash command is strictly read-only**: it lists vaults and shows key names + comments,
nothing more.

## Allowed invocations

Parse `"$ARGUMENTS"` as a subcommand:

- `list [<ref>]` — list all vaults, or list keys + comments of one vault. Run:

  ```sh
  akm --format json -q vault list ${ref:-}
  ```

- `show <ref>` — show a single vault's key names and comments. Run:

  ```sh
  akm --format json -q vault show <ref>
  ```

## Forbidden from this command

`set`, `unset`, `load`, `create`, and the `shell_snippet` flow are **not** available
through `/akm-vault`. Direct the user to `/akm-help` topic="vault" (or run `akm vault --help`
through Bash) to discover the correct raw `akm vault …` invocation, and only run those
mutating commands after the user explicitly confirms each call.

## Hard rules when handling vaults

- **Never echo a vault value in chat, logs, or files.** Vault values do not appear in
  `akm show` JSON or in search indexes; the only path that emits values is `akm vault
  load`, which is intentionally outside this slash command.
- If the user shares a value to be stored, do **not** repeat it back. Direct them to
  `/akm-help` topic="vault" so they can run `akm vault set <ref> <key>` themselves, or
  pipe it through stdin where supported.
- If `akm vault list` or `akm vault show` output ever contains something that looks like
  a value (it should not), redact it before surfacing the response to the user.
