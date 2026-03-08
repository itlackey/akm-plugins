---
name: agentikit
description: Search, show, dispatch agents, and execute commands from an Agentikit stash directory. Use when the user wants to find or use tools, skills, commands, agents, or knowledge in their stash.
---

# Agentikit Stash

You have access to the `akm` CLI (Agentikit Manager) to manage extension assets from a stash directory.

The stash directory is configured via the `AGENTIKIT_STASH_DIR` environment variable and contains:

- **tools/** — executable scripts (.sh, .ts, .js, .ps1, .cmd, .bat)
- **skills/** — skill directories containing SKILL.md
- **commands/** — markdown template files
- **agents/** — markdown agent definition files
- **knowledge/** — markdown knowledge files

## Commands

### Build the search index

Scan stash directories, auto-generate missing `.stash.json` metadata, and build a semantic search index.

```bash
akm index [--full]
```

Use `--full` to force a full reindex instead of incremental. Run this after adding new extensions to enable semantic search ranking.

### Search the stash

Find assets using a hybrid search pipeline: semantic embeddings + TF-IDF ranking. Falls back to name substring matching when no index exists.

```bash
akm search [query] [--type tool|skill|command|agent|knowledge|any] [--limit N]
```

### Show an asset

Retrieve the full content/payload of an asset using its ref from search results.

```bash
akm show <ref>
```

Returns type-specific payloads:
- **skill** → full SKILL.md content
- **command** → markdown template + description
- **agent** → prompt + description, toolPolicy, modelHint
- **tool** → execution command and kind
- **knowledge** → full markdown content (supports view modes: toc, frontmatter, section, lines)

### Configuration

Show or update configuration stored in the stash directory.

```bash
akm config                    # Show current config
akm config --set key=value    # Update a config key
```

Configurable keys: `semanticSearch`, `additionalStashDirs`, `embedding`, `llm`.

## Dependencies

`akm init` will auto-install [ripgrep](https://github.com/BurntSushi/ripgrep) to `stash/bin/` if not already on PATH. Ripgrep is used for fast candidate filtering during search.

## Workflow

1. Initialize: `akm init` (creates stash dirs, installs ripgrep)
2. Build the index: `akm index`
3. Search for assets: `akm search "deploy" --type tool`
4. Inspect a result: `akm show <ref>`

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
   Extract `openRef` from the first hit in the `hits` array.

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
   Extract `openRef` from the first hit.

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
