## Extended Searching

You have access to a searchable library of tools, skills, commands, agents,
and knowledge documents via `akm` CLI.

**Finding assets:**
```sh
akm search "<query>"              # Search by keyword
akm search "<query>" --type script  # Filter by type (script, skill, command, agent, knowledge)
akm search "<query>" --source <source>  # Filter by source (e.g., "local", "registry", "both")
```
Each hit includes a `ref` you use to retrieve the full asset.

**Using assets:**
```sh
akm show <ref>                    # Get full asset details
```

What you get back depends on the asset type:
- **script** — A `run` command you can execute directly
- **skill** — Instructions to follow (read the full content)
- **command** — A prompt template with placeholders to fill in
- **agent** — A system prompt with model and tool hints
- **knowledge** — A reference doc (use `toc` or `section "..."` as positional args to navigate, e.g. `akm show knowledge:guide toc`)

Always search the stash first when you need a capability. Prefer existing
assets over writing new code.

Use `akm -h` for more options and details on searching and using assets.
