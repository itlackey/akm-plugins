---
description: Read AKM env assets — list envs, show key names, run a command with env injected, or get the file path. Never echo values directly.
argument-hint: <list | path <ref> | run <ref> -- <cmd>>
---

Env assets are whole `.env` files under `<stashDir>/env/<name>.env`. This slash command
exposes the **chat-safe** read paths: listing env refs, showing key names, getting the
file path, or running a command with the env injected into its process. Values never reach
stdout or chat. Writes (`create`, `remove`) stay on the raw CLI path via `/akm-help`
topic="env".

## Allowed invocations

Parse `"$ARGUMENTS"` as a subcommand:

- `list` — list all env refs. Run:

  ```sh
  akm --format json -q env list
  ```

- `path <ref>` — print the absolute file path for an env asset without echoing values.
  Use with Docker `--env-file` or `source` consumers. Run:

  ```sh
  akm env path <ref>
  ```

- `run <ref> -- <cmd>` — inject the env into a child command without values touching
  stdout. This is the primary agent-safe value-load path. Run:

  ```sh
  akm env run <ref> -- <cmd>
  ```

  For an interactive shell: `akm env run <ref> -- $SHELL`.

## Forbidden from this command

`create` and `remove` are **not** available through `/akm-env`. Direct the user to
`/akm-help` topic="env" (or run `akm env --help` via Bash) to discover the correct raw
`akm env …` invocation, and only run those mutating commands after explicit confirmation.

## Hard rules when handling env assets

- **Never echo env values in chat, logs, or files.** Key names and comments are safe to
  surface; values must never appear in structured output.
- For `run <ref> -- <cmd>`: only run after the user explicitly asks; explain what will
  happen before executing.
- If the user shares credential material to be stored, do **not** repeat it back. Route
  them to `/akm-help` topic="env" so they can edit the file directly or use
  `akm env create --from-file <path>`.
- Prefer `run` over `path` when the consumer is a command you control — `run` ensures
  values never reach stdout.
