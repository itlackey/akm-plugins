---
description: Show an AKM asset by concept-ID ref, with optional bounded fragment context.
argument-hint: <[bundle//]conceptId[#fragment]> [--context exact|lead] [--max-tokens N|--max-chars N]
allowed-tools: Bash(akm show *) Bash(akm search *)
---

Parse `"$ARGUMENTS"` as one required reference followed by optional flags.
The reference cannot contain spaces. Supported flags are `--context exact|lead`,
`--max-tokens <positive integer>`, `--max-chars <positive integer>`, and
`--detail brief|normal|full`. Never pass both budget flags. A budget requires
`--context lead`.

Quote the reference, but keep each flag and its separately quoted value as its
own shell argument. Quoting the entire argument string turns the flags into
part of the ref. Run:

```sh
akm show "<ref>" <flags> --format json -q
```

Exact remains the default and returns only the selected fragment. For an
opaque fragment ref returned by search, `--context lead` prepends indexed-safe
lead context under a 3,200-character default budget and leaves the explicitly
labelled selected match last. Friendly authored heading selectors retain their
existing source-live behavior. Summarize the returned asset payload for the
user. Preserve
`selectedRef`, `parentRef`, fragment ordinals and neighbors, separate token
estimates, `contextMode`, and truncation state, as well as fields such as
`prompt`, `template`, `run`, `origin`, `editable`, and `action` when relevant.

When the ref does not resolve, do not stop at "not found": run `akm search "<last path segment of the ref>" --format json -q` and offer the closest matches.
