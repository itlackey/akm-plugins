---
description: Read AKM whole-file secrets safely — list secret refs or return a secret file path without surfacing contents.
argument-hint: <list | path <ref>>
---

Secrets are whole-file single-value assets stored under `<stashDir>/secrets/`. The
entire file is the secret value. This slash command exposes the **chat-safe** paths only:
listing secret refs and returning the absolute file path for `_FILE`-style consumers.
Secret writes (`set`), command injection (`run`), and deletion (`remove`) stay on the raw
CLI path via `/akm-help` topic="secret".

## Allowed invocations

Parse `"$ARGUMENTS"` as a subcommand:

- `list` — list all visible secrets by ref. Run:

  ```sh
  akm --format json -q secret list
  ```

- `path <ref>` — print the absolute file path for a secret without reading or echoing the
  file contents. Run:

  ```sh
  akm secret path <ref>
  ```

  Treat the returned path as sensitive. Only run `path` after the user explicitly asks for
  access to that secret, and prefer passing the path to `_FILE`-style consumers instead of
  reading the file.

## Forbidden from this command

`set`, `run`, and `remove` are **not** available through `/akm-secret`. Direct the user to
`/akm-help` topic="secret" (or run `akm secret --help` via Bash) to discover the correct raw
`akm secret …` invocation, and only run those commands after explicit confirmation.

## Hard rules when handling secrets

- **Never echo secret contents in chat, logs, or files.** `akm secret` is designed so values
  never appear in structured output.
- For `path <ref>`: return or use the file path only. Do not open the file unless the user
  explicitly asks for some downstream action that requires it.
- If the user shares material to store, do **not** repeat it back. Route them to
  `/akm-help` topic="secret" so they can run `printf '%s' "$VALUE" | akm secret set <ref>` or
  `akm secret set <ref> --from-file ./path` directly.
