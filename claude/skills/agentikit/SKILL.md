---
name: agentikit
description: Search, show, dispatch agents, and execute commands from an Agentikit stash directory. Use when the user wants to find or use tools, skills, commands, agents, or knowledge in their stash.
---

# Agentikit Stash

You have access to the `akm` CLI (Agentikit Manager) to manage extension assets from a stash directory.

### Stash directory resolution

The stash directory is resolved using a three-tier fallback:
1. **Environment variable** — `AKM_STASH_DIR` (optional override)
2. **Config file** — `stashDir` field in `$XDG_CONFIG_HOME/agentikit/config.json`
3. **Platform default** — OS-specific default location

Set the stash directory persistently with `akm config set stashDir /path/to/stash` (preferred). The `AKM_STASH_DIR` env var is only needed as a temporary override.

The stash directory contains:

- **tools/** — executable scripts (.sh, .ts, .js, .ps1, .cmd, .bat)
- **skills/** — skill directories containing SKILL.md
- **commands/** — markdown template files
- **agents/** — markdown agent definition files
- **knowledge/** — markdown knowledge files
- **scripts/** — general-purpose scripts (.py, .rb, .go, .pl, .php, .lua, .r, .swift, .kt)

### Multi-source resolution

Assets are resolved from multiple sources in priority order:
1. **working** (origin: `local`) — your local stash directory (read-write)
2. **mounted** — read-only additional directories configured via `mountedStashDirs` in config
3. **installed** — kits installed from the registry via `akm add` (read-only)

Mounted stash directories let you share curated asset collections across projects without copying files. Configure them with `akm config set mountedStashDirs '["/path/a","/path/b"]'`.

### Asset classification

Assets are classified using a multi-signal matcher system that considers file extension, directory placement, parent directory name, and (for markdown files) content signals such as frontmatter fields and body patterns. This means assets can be correctly classified even if placed outside their canonical directory.

### Refs

Refs use the format `[origin//]type:name`. Simple refs like `tool:deploy.sh` search all sources. Origin-qualified refs like `npm:@scope/pkg//tool:deploy.sh` or `local//tool:deploy.sh` target a specific source.

## Commands

### Build the search index

Scan stash directories, auto-generate missing `.stash.json` metadata, and build a semantic search index.

```bash
akm index [--full]
```

Use `--full` to force a full reindex instead of incremental. Run this after adding new extensions to enable semantic search ranking.

### Search the stash or registry

Find assets using a hybrid search pipeline: semantic embeddings + TF-IDF ranking. Falls back to name substring matching when no index exists.

```bash
akm search [query] [--type tool|skill|command|agent|knowledge|script|any] [--limit N] [--source local|registry|both] [--usage none|both|item|guide]
```

The response includes `hits` (ranked results), plus diagnostic fields: `timing` (totalMs, rankMs, embedMs), `warnings` (string array of non-fatal issues), and `tip` (contextual usage hint).

- Local and installed stash hits include `openRef`, which you pass to `akm show`.
- Registry hits include `installRef` and `installCmd`, which you pass to `akm add` when the user wants to install a kit.
- Use `--source registry` when the user is looking for installable community kits, or `--source both` to search everything at once.
- Use `--usage none` to reduce search noise when you only want concise result metadata.

### Show an asset

Retrieve the full content/payload of an asset using its ref from search results.

```bash
akm show <ref>
```

Returns type-specific payloads:
- **skill** → full SKILL.md content
- **command** → markdown template + description
- **agent** → prompt + description, toolPolicy, modelHint
- **tool** → execution command, kind, and runCmd
- **knowledge** → full markdown content (supports view modes: toc, frontmatter, section, lines)
- **script** → execution command, interpreter, and runCmd

All show responses include these common fields:
- `registryId` — registry package identifier (present for installed kit assets)
- `editable` — boolean indicating whether the asset can be modified (true for working stash, false for mounted/installed)
- `kind` — ToolKind for tools/scripts: `"bash"`, `"sh"`, `"ps1"`, `"cmd"`, `"bat"`, `"bun"`, `"node"`, `"python"`, `"ruby"`, `"go"`, `"unsupported"`
- `runCmd` — ready-to-execute command string for tools and scripts (see Tool/Script Execution below)

### Configuration

Show or update configuration stored at `~/.config/agentikit/config.json` (XDG standard).

```bash
akm config list                 # Show current config
akm config get <key>            # Get a config value
akm config set <key> <value>    # Set a config value
akm config unset <key>          # Remove a config value
akm config providers            # List configured providers
akm config use <provider>       # Switch active provider
```

Configurable keys: `stashDir`, `semanticSearch`, `mountedStashDirs`, `embedding`, `llm`.

### Registry Management

Discover and install kits from npm or GitHub registries.

```bash
akm search "deploy" --source registry  # Search installable registry kits
akm add <package>                      # Install from npm, github, git, or local dir
akm clone <ref>                        # Copy an asset into the working stash for editing
akm list                          # List installed registry kits
akm remove <id>                   # Remove an installed kit
akm update [id]                   # Update one installed kit
akm update --all                  # Update all installed kits
```

Installed kits become searchable alongside local stash assets. Use `--source registry` with search to query only remote registries.

When the user wants to browse community kits:

1. Run `akm search "<query>" --source registry`.
2. Review the returned `hits` and prefer `installRef` / `installCmd` over trying to `akm show` a registry hit directly.
3. If the user wants to install a result, run `akm add <installRef>`.
4. If the user wants to customize an installed asset, run `akm clone <origin-qualified-ref>` to copy it into the working stash before editing.

## Dependencies

`akm init` will auto-install [ripgrep](https://github.com/BurntSushi/ripgrep) to `stash/bin/` if not already on PATH. Ripgrep is used for fast candidate filtering during search.

## Workflow

1. Initialize: `akm init` (creates stash dirs, installs ripgrep)
2. Build the index: `akm index`
3. Search for assets: `akm search "deploy" --type tool`
4. Inspect a result: `akm show <ref>`
5. Search the registry when needed: `akm search "deploy" --source registry`
6. Install kits: `akm add <package>` (optional)

All output is JSON for easy parsing.

## Dispatching Stash Agents

You can dynamically spawn a stash agent to work on a task. The agent's prompt, tool constraints, and model preferences are defined in its markdown file and loaded at runtime.

### Agent payload shape

`akm show <agent-ref>` returns JSON:

```json
{
  "type": "agent",
  "name": "coach.md",
  "path": "/stash/agents/coach.md",
  "description": "Code review coach",
  "prompt": "You are a code review coach. Focus on ...",
  "toolPolicy": { "read": true, "edit": false, "bash": false },
  "modelHint": "anthropic/claude-sonnet-4-5-20250514"
}
```

- `prompt` (required) — the agent's system instructions
- `toolPolicy` (optional) — boolean flags indicating which tool categories the agent should use
- `modelHint` (optional) — preferred `provider/model` (advisory only in Claude Code)

### Dispatch workflow

When the user asks you to dispatch, run, or use a stash agent:

1. **Resolve the ref.** If the user gives a direct ref (e.g. `agent:coach.md`), use it. Otherwise search:
   ```bash
   akm search "<query>" --type agent --limit 1
   ```
   Extract `openRef` from the first hit in the `hits` array. Refs use the format `[origin//]type:name` (e.g., `tool:deploy.sh`, `npm:@scope/pkg//tool:deploy.sh`).

2. **Fetch the agent payload:**
   ```bash
   akm show <ref>
   ```
   Parse the JSON. Verify `type` is `"agent"` and `prompt` is non-empty. If validation fails, inform the user.

3. **Compose the subagent prompt.** Build a prompt that embeds the stash agent's persona and the user's task:

   ```
   <agent-persona>
   {value of the "prompt" field from akm show}
   </agent-persona>

   <tool-constraints>
   {render toolPolicy as natural language, e.g.:
    - "You may read files but must NOT edit files or run shell commands."
    - If toolPolicy is absent, omit this section.}
   </tool-constraints>

   Task: {the user's task description}
   ```

4. **Spawn the subagent** using the Agent tool with `subagent_type: "general-purpose"` and the composed prompt.

5. **Report results** to the user. If `modelHint` was present, note that Claude Code does not support per-subagent model selection so it was not enforced.

### Example

User: "Dispatch the coach agent to review src/auth.ts"

You would run:
```bash
akm show agent:coach.md
```
Then spawn a general-purpose subagent with the coach's prompt embedded, tasked with reviewing `src/auth.ts`.

## Executing Stash Commands

You can execute stash command templates by resolving them, rendering argument placeholders, and running the result.

### Command payload shape

`akm show <command-ref>` returns JSON:

```json
{
  "type": "command",
  "name": "review.md",
  "path": "/stash/commands/review.md",
  "description": "Review a file for issues",
  "template": "Review $1 for bugs, security issues, and code quality. Focus on: $ARGUMENTS"
}
```

- `template` (required) — text with `$ARGUMENTS` (full arg string) and positional `$1`, `$2`, ... placeholders

### Template rendering rules

Given arguments `"src/main.ts" --strict`:
- `$ARGUMENTS` → `"src/main.ts" --strict` (the full raw argument string)
- `$1` → `src/main.ts` (first positional arg, quotes stripped)
- `$2` → `--strict` (second positional arg)
- Positional args are split by whitespace. Quoted strings (`"double"`, `'single'`, `` `backtick` ``) are treated as a single argument with quotes removed.

### Execution workflow

When the user asks you to run or execute a stash command:

1. **Resolve the ref.** If the user gives a direct ref (e.g. `command:review.md`), use it. Otherwise search:
   ```bash
   akm search "<query>" --type command --limit 1
   ```
   Extract `openRef` from the first hit. Refs use the format `[origin//]type:name`.

2. **Fetch the command payload:**
   ```bash
   akm show <ref>
   ```
   Parse the JSON. Verify `type` is `"command"` and `template` is non-empty.

3. **Render the template.** Replace `$ARGUMENTS` with the full argument string and `$1`, `$2`, etc. with the corresponding positional arguments.

4. **Execute the rendered text:**
   - If it is a shell command (starts with a known CLI tool, contains pipes, redirects, etc.) → execute with the Bash tool.
   - If it is a natural-language instruction or multi-step task → execute with the Agent tool using `subagent_type: "general-purpose"`.
   - If ambiguous, ask the user.

5. **Report results** to the user.

### Example

User: "Run the review command on src/main.ts with --strict"

You would run:
```bash
akm show command:review.md
```
Then render the template replacing `$1` with `src/main.ts` and `$ARGUMENTS` with `src/main.ts --strict`, and execute the resulting instruction.

## Tool/Script Execution

Tools and scripts in the stash can be executed directly. The `akm show` response for tools and scripts includes a `runCmd` field — a ready-to-execute shell command string.

### Execution workflow

When the user asks you to run or execute a stash tool or script:

1. **Resolve the ref.** If the user gives a direct ref (e.g. `tool:deploy.sh`), use it. Otherwise search:
   ```bash
   akm search "<query>" --type tool --limit 1
   ```
   Extract `openRef` from the first hit.

2. **Fetch the tool payload:**
   ```bash
   akm show <ref>
   ```
   Parse the JSON. Verify `type` is `"tool"` or `"script"` and `runCmd` is non-empty.

3. **Execute the command** using the Bash tool with the `runCmd` value:
   ```bash
   # runCmd examples by kind:
   # bash:       cd "/path" && bash "/path/script.sh"
   # bun (ts):   cd "/path" && bun "/path/script.ts"
   # node:       cd "/path" && node "/path/script.js"
   # python:     cd "/path" && python "/path/script.py"
   # powershell: powershell -ExecutionPolicy Bypass -File "/path/script.ps1"
   ```

4. **Report results** to the user.

### Example

User: "Run the deploy tool"

You would run:
```bash
akm show tool:deploy.sh
```
Extract the `runCmd` field from the response and execute it with the Bash tool.
