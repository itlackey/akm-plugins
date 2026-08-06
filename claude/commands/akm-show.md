---
description: Show an AKM asset by concept-ID ref.
argument-hint: <[bundle//]conceptId[#fragment]>
---

Run:

```sh
akm show "$ARGUMENTS" --format json
```

Summarize the returned asset payload for the user. Preserve structured fields like `prompt`, `template`, `run`, `origin`, `editable`, and `action` when they are relevant to the next step.
