---
description: Show an AKM asset by concept-ID ref.
argument-hint: <[bundle//]conceptId[#fragment]>
allowed-tools: Bash(akm show *) Bash(akm search *)
---

Run:

```sh
akm show "$ARGUMENTS" --format json
```

Summarize the returned asset payload for the user. Preserve structured fields like `prompt`, `template`, `run`, `origin`, `editable`, and `action` when they are relevant to the next step.

When the ref does not resolve, do not stop at "not found": run `akm search "<last path segment of the ref>" --format json -q` and offer the closest matches.
