---
description: Resolve and execute an AKM stash command template from Claude.
argument-hint: <command-ref-or-query> [arguments...]
---

Parse `"$ARGUMENTS"` into a command identifier and the raw trailing argument string.

- If the identifier already looks like `command:<name>` (or an origin-qualified command ref), use it directly.
- Otherwise resolve the best match with `akm --format json search "<identifier>" --type command --limit 1`.
- Fetch the command with `akm --format json show <ref>`.

Then follow the AKM skill's existing command-execution flow:
- verify the payload is a command with a non-empty `template`
- render `$ARGUMENTS`, `$1`, `$2`, and the rest of the positional placeholders
- execute the rendered result in the appropriate Claude flow

Report the rendered command intent and the outcome back to the user.
