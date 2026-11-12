---
description: Show an AKM asset by concept-ID ref, with optional bounded fragment context.
argument-hint: <[bundle//]conceptId[#fragment]> [--lead] [--max-tokens N|--max-chars N] [--outline]
allowed-tools: Bash(bun *akm-cli/dist/cli.js* show *) Bash(bun *akm-cli/dist/cli.js* search *)
---

`${CLAUDE_PLUGIN_ROOT}` is this plugin's directory, which carries the AKM CLI; Codex leaves it unfilled, so use the directory this plugin is installed in. Run every AKM command through it, as written below.

Parse the text the user gave with this command (in Claude Code it follows
below as `ARGUMENTS:`; in Codex it is the user's request) as one required
reference followed by optional flags. The reference cannot contain spaces.
Supported flags are `--lead`, `--max-tokens <positive integer>`,
`--max-chars <positive integer>`, `--outline`, and `--detail normal|full`. Never pass
both budget flags. `--max-chars` requires `--lead`; `--outline` cannot be combined with `--lead` or a budget.

Quote the reference, but keep each flag and its separately quoted value as its
own shell argument. Quoting the entire text turns the flags into
part of the ref. Run:

```sh
bun "${CLAUDE_PLUGIN_ROOT}/node_modules/akm-cli/dist/cli.js" show "<ref>" <flags> --format json -q
```

Exact remains the default and returns only the selected fragment. For an
opaque fragment ref returned by search, `--lead` prepends indexed-safe
lead context under a 3,200-character default budget and leaves the explicitly
labelled selected match last. Friendly authored heading selectors retain their
existing source-live behavior. Summarize the returned asset payload for the
user. Preserve
`selectedRef`, `parentRef`, fragment ordinals and neighbors, separate token
estimates, `contextMode`, and truncation state, as well as fields such as
`prompt`, `template`, `run`, `origin`, `editable`, and `action` when relevant.

When the ref does not resolve, do not stop at "not found": run `bun "${CLAUDE_PLUGIN_ROOT}/node_modules/akm-cli/dist/cli.js" search "<last path segment of the ref>" --format json -q` and offer the closest matches.
