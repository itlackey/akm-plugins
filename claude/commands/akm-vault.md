---
description: Read AKM vaults — list vaults, show key names, or load values into a shell as a snippet for eval. Never echo values directly.
argument-hint: <list | show <ref> | load <ref>>
---

Vaults are `.env`-style key/value stores under `<stashDir>/vaults/<name>.env`. This slash
command exposes the **read paths**: listing vaults, showing key names + comments, and
emitting a shell-eval snippet that loads values into a process. Vault **writes** (`set`,
`unset`, `create`) are not available here — discover those via `/akm-help` topic="vault".

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

- `load <ref>` — emit a shell-eval snippet that loads the vault into the current process.
  This action **does** read raw values from the vault and write them to stdout as shell
  text (not JSON). Run:

  ```sh
  akm vault load <ref>
  ```

  Treat the output as opaque shell intended for `eval`. Hand it to a shell via `eval` (or
  pipe it into the next command) — do **not** print the snippet body back to the user, do
  not echo individual values, and do not log it. Only run `load` after the user explicitly
  asks for it; explain what will happen before running.

## Forbidden from this command

`set`, `unset`, and `create` are **not** available through `/akm-vault`. Direct the user
to `/akm-help` topic="vault" (or run `akm vault --help` via Bash) to discover the correct
raw `akm vault …` invocation, and only run those mutating commands after the user
explicitly confirms each call.

## Hard rules when handling vaults

- **Never echo a vault value in chat, logs, or files.** Vault values do not appear in
  `akm vault show` JSON or in search indexes; the only path that emits values is `akm
  vault load`, and that output is meant for `eval`, not for display.
- For `load <ref>`: pipe the output straight to the consumer (typically `eval`); do not
  surface the snippet body in the chat turn.
- If the user shares a value to be stored, do **not** repeat it back. Direct them to
  `/akm-help` topic="vault" so they can run `akm vault set <ref> <key>` themselves, or
  pipe it through stdin where supported.
- If `akm vault list` or `akm vault show` output ever contains something that looks like
  a value (it should not), redact it before surfacing the response to the user.
