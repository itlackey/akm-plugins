# AKM Plugins

Platform-specific plugins for the [AKM](https://github.com/itlackey/akm) CLI (v0.8.0+). Both packages wrap the `akm` CLI to **search**, **show**, **dispatch agents**, **execute commands**, **drive workflows**, **manage wikis**, **access vaults**, **operate the v0.8.0 proposal queue**, and **improve assets** from a stash directory.

## What's new in 0.8.0

The v0.8.0 release of akm hard-breaks the old self-improvement CLI and introduces:

- **Proposal queue rename** — `/akm-proposal` (Claude) / `akm_proposal` (OpenCode) now route `list / show / diff / accept / reject` to `akm proposals`, `akm show proposal`, `akm diff` (positional UUID/prefix/ref — no `proposal` middle word), `akm accept`, and `akm reject`.
- **`improve` replaces `reflect` and `distill`** — AKM 0.8.0 removes the old public self-improvement commands. This repo now exposes `akm_improve` / `/akm-improve` as the canonical improvement flow.
- **Task assets** — `akm tasks ...` is now part of the AKM CLI long-tail surface and discoverable here through `akm_help` / `/akm-help`.
- **`lesson` asset type** — first-class type stored under `lessons/<name>.md` with required `description` and `when_to_use` frontmatter.
- **`defaults.agent` config + `akm setup`** — `akm setup` is the human-facing interactive configuration wizard. It can detect installed agent CLIs (`opencode`, `claude`, `codex`, `gemini`, `aider`) and persist `defaults.agent` plus a matching `profiles.agent.<name>` entry, but agents should not invoke it directly. The legacy `agent.default` shape is auto-migrated on load.
- **`quality:"proposed"`** — excluded from default search; surface drafts via `--include-proposed` or the proposal-review commands. The plugin's auto-feedback hook automatically skips proposed-quality refs.

See akm's [`docs/migration/release-notes/0.8.0.md`](https://github.com/itlackey/akm/blob/main/docs/migration/release-notes/0.8.0.md) for the full delta.

## OpenCode

OpenCode plugin that registers tools that call the akm CLI.

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["akm-opencode"]
}
```

Provides a surface of twenty tools. Verbs that are not first-class tools (`save`, `import`, `clone`, `update`, `remove`, `list`-sources, `registry-search`, `reindex`, `config`, `upgrade`, `tasks`, `run`, raw `agent`, vault writes) are discoverable through the `akm_help` tool, which surfaces a curated quick-reference and falls back to live `akm --help` so agents can compose the right CLI invocation and run it via shell:
- `akm_info` — show `akm info` output together with the installed `akm-opencode` plugin version and install location
- `akm_search` — search the stash, the registry, or both (including `workflow`, `vault`, `wiki`, and `lesson` types). Pass `--include-proposed` to merge proposed-quality drafts.
- `akm_show` — show a stash asset by ref
- `akm_agent` — dispatch stash `agent:*` resources into OpenCode sessions
- `akm_workflow` — drive workflow runs (`start`, `next`, `complete`, `status`, `list`, `create`, `template`, `resume`)
- `akm_remember` — record a memory in the default stash
- `akm_cmd` — execute stash `command:*` templates through OpenCode SDK sessions
- `akm_vault` — vault `list`, `show` (key names), and `load` (shell-eval snippet for value injection). `show`/`list` never echo values; writes (`set`, `unset`, `create`) go through raw `akm vault …`
- `akm_curate` — curate stash assets for a task or topic
- `akm_evolve` — dispatch the AKM curator subagent (review session activity, propose stash improvements, persist the report as a memory)
- `akm_wiki` — manage wikis (`create`, `register`, `list`, `show`, `pages`, `search`, `stash`, `lint`, `ingest`, `remove`)
- `akm_feedback` — record positive or negative feedback for a stash asset
- `akm_memory` — audit recall/write/safety behavior, review memory candidates, and promote/reject them with confirmation
- `akm_proposal` — operate the v0.8.0 proposal queue (`list`, `show`, `diff`, `accept`, `reject`). Always confirm with the user before `accept`/`reject`.
- `akm_improve` — generate improvement proposals for an asset ref, an asset type, or the broader stash.
- `akm_propose` — generate a new-asset proposal via the configured agent CLI.
- `akm_init` — initialize the working stash and persist `stashDir` in an agent-safe way.
- `akm_session_messages` — summarize a specific OpenCode session (restricted for arbitrary session IDs)
- `akm_parent_messages` — summarize the parent OpenCode session for dispatched stash subagents
- `akm_help` — quick-reference table for non-first-class `akm` verbs, with live `akm --help` fallback

The OpenCode plugin also hooks `chat.message`, `tool.execute.before`, `tool.execute.after`, `experimental.session.compacting`, and `shell.env` to gate destructive actions, preserve context through compaction, emit structured redacted memory events/candidates, and record user/system feedback and memory usage in OpenCode app logs when relevant.

## Feature parity tracker

| Feature | Tracking issue | Status |
| --- | --- | --- |
| Session-start retrieval | #27 | Shipped in both plugins |
| Auto-attach scope | #28 | Shipped in both plugins |
| Conversation-derived feedback | #29 | Deferred to 0.9.0 — structured recall/candidate pipeline ships in 0.8.0; per-conversation fine-grained feedback extraction requires conversation transcript access not yet exposed by harnesses |
| Session-end `akm index` | #30 | Shipped in both plugins |
| Harness-provided LLM fallback | #31 | Deferred to 0.9.0 — agents currently use their own configured model; harness-level model injection requires SDK support not yet available |
| Shared secret redaction | #64 | Shipped in both plugins |
| Structured memory events | #55 | Shipped in both plugins |
| Claude PreToolUse safety guard | #56 | Shipped in Claude |
| Checkpoint + candidates | #57 | Shipped in both plugins |
| Memory audit and candidate review | #58 | Shipped in both plugins |
| Shared recall policy | #59 | Shipped in both plugins |
| Confidence-scored auto-feedback | #60 | Shipped in both plugins |
| Expanded Claude lifecycle coverage | #61 | Shipped in Claude |
| Subagent context/result capture | #62 | Shipped in both plugins |
| Workflow compliance telemetry | #63 | Shipped in both plugins |

#### Coming in 0.9.0

Two features in the tracker above are planned for 0.9.0 and explicitly deferred from 0.8.0:

- **[#29 Conversation-derived feedback](https://github.com/itlackey/akm-plugins/issues/29)** — Extracting per-message asset feedback signals from the full conversation transcript. The structured recall/candidate pipeline already ships in 0.8.0; this feature requires per-conversation transcript access that harnesses do not yet expose.
- **[#31 Harness-provided LLM fallback](https://github.com/itlackey/akm-plugins/issues/31)** — Injecting an alternate model at the harness level for tool calls. Requires SDK support for model-override injection that is not yet available in either harness SDK.

### Claude Code

Claude Code plugin providing a skill for stash asset management, dynamic agent dispatch, and command execution.

Add the marketplace and install the plugin:

```sh
# Add the AKM marketplace
/plugin marketplace add itlackey/akm-plugins

# Install the plugin
/plugin install akm
```

Or via the Claude CLI:

```sh
claude plugin marketplace add itlackey/akm-plugins
claude plugin install akm@akm-plugins
```

Provides:
- **AKM Skill** — Claude automatically uses the akm CLI when you ask about stash assets
- **Slash-command surface (21 verbs)** — `/akm-search`, `/akm-show`, `/akm-memory-audit`, `/akm-memory-candidates`, `/akm-memory-promote`, `/akm-memory-reject`, `/akm-agent`, `/akm-cmd`, `/akm-curate`, `/akm-remember`, `/akm-feedback`, `/akm-evolve`, `/akm-wiki`, `/akm-workflow`, `/akm-vault` (`list`/`show`/`load`), `/akm-proposal` (`list`/`show`/`diff`/`accept`/`reject`), `/akm-review-proposals`, `/akm-improve`, `/akm-propose`, `/akm-setup`, and `/akm-help`
- **`/akm-help` discovery flow** — for verbs without a dedicated slash command (save, import, clone, update, remove, list-sources, registry-search, reindex, config, upgrade, run-script, raw `agent`, vault writes), `/akm-help <task>` surfaces a curated quick-reference and falls back to live `akm --help` so Claude can compose the right `akm` invocation and run it via Bash
- **Dynamic agent dispatch** — Claude fetches agent definitions from the stash and spawns subagents on the fly with the agent's prompt, tool constraints, and task
- **Command execution** — Claude resolves command templates, renders argument placeholders (`$ARGUMENTS`, `$1`, `$2`), and executes the result
- **Claude hooks** — on session start the plugin verifies `akm-cli` satisfies `^0.8.0` (override via `AKM_PACKAGE_REF`) and prints a stderr banner pointing at `/akm-setup` when the CLI is missing or out of range (no silent install — installation requires explicit user consent via `/akm-setup`). The hook can also set `defaults.agent` to the current platform in the AKM config file when no agent default is configured (legacy `agent.default` is auto-migrated on load), surfaces pending-proposal counts in the SessionStart header, and records redacted event/feedback/memory/candidate data in local state files. Auto-feedback skips proposed-quality and `lesson:*` refs. Destructive `akm` subcommands are no longer gated by the plugin — see [claude/README.md "Locking down destructive commands"](./claude/README.md#locking-down-destructive-commands) for the recommended `permissions.ask` / `permissions.deny` recipe. Human users can run `akm setup` manually when interactive setup is needed.

### All Other Agents

For Codex, Co-Pilot, Cursor, QwenCLI, and any system that uses AGENTS.md or instruction files, you can simply drop in the [AGENTS.md](./AGENTS.md) or copy the content into the appropriate location for your platform.

## Stash model

The stash directory is resolved automatically via a three-tier fallback: `AKM_STASH_DIR` env var (optional override) → `stashDir` in `config.json` → platform default. Set it persistently with:

```sh
akm config set stashDir /abs/path/to/your-stash
```

Expected layout:

```
stash/
├── scripts/    # executable scripts (.sh, .ts, .js, .ps1, .cmd, .bat, .py, .rb, .go, .pl, .php, .lua, .r, .swift, .kt)
├── skills/     # skill directories containing SKILL.md
├── commands/   # markdown files
├── agents/     # markdown files
├── knowledge/  # markdown files
├── memories/   # markdown memory files (akm remember)
├── lessons/    # first-class durable learnings (lesson:<name>) with description + when_to_use frontmatter
├── workflows/  # multi-step procedures (workflow:<name>)
├── vaults/     # .env secret stores (vault:<name>) — values never surface through structured output
├── wikis/      # per-wiki directories <name>/{schema,index,log}.md + raw/ + pages
└── .akm/proposals/  # v0.8.0 proposal queue — drafts that never leak into search or commits
```

Assets are resolved from three source types: **working** (local stash), **search paths** (additional dirs via `searchPaths` config), and **installed** (registry kits via `akm add`).

## Configuration

Config is stored at `~/.config/akm/config.json` (XDG standard). Use `akm config list` to view, `akm config set <key> <value>` to update.

## Prerequisites

For OpenCode, the plugin ships a bundled `akm-cli` dependency that OpenCode/Bun installs alongside the plugin itself, and falls back to an existing `akm` on PATH when needed. It does **not** install `akm-cli` globally on its own — if neither the bundled binary nor the PATH binary satisfies `^0.8.0`, the plugin writes a stderr banner pointing at manual install and `akm setup` instead.

For Claude Code, the plugin uses `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `PreCompact`, `PostCompact`, and `SessionEnd` hooks to gate risky raw AKM Bash, inject scoped AKM context, and record redacted memory/event/candidate activity across prompt, tool, task, compaction, and session lifecycle events. On session start the plugin checks that `akm-cli@^0.8.0` is on PATH (no silent install): when it is missing or out of range the hook writes a clear stderr banner and the SessionStart context tells the agent that `akm` is unavailable until the user runs `/akm-setup` to confirm an install.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/akm/main/install.ps1 -OutFile install.ps1; ./install.ps1

# Or via Bun
bun install -g akm-cli@^0.8.0
```

## Ecosystem

| Repo | What it is |
| --- | --- |
| [itlackey/akm](https://github.com/itlackey/akm) | Core Agent Kit Manager CLI (v0.8.0+) |
| [itlackey/akm-stash](https://github.com/itlackey/akm-stash) | Official stash — ready-made skills, workflows, commands, and knowledge |
| [itlackey/akm-registry](https://github.com/itlackey/akm-registry) | Official registry index — pre-configured in every akm install |
| [itlackey/akm-bench](https://github.com/itlackey/akm-bench) | Benchmark harness for measuring agent performance with akm |
| [itlackey/akm-eval](https://github.com/itlackey/akm-eval) | Eval framework for akm asset quality using authoritative upstream harnesses |

## Docs

- **AKM CLI**: [github.com/itlackey/akm](https://github.com/itlackey/akm)
- **OpenCode**: [Plugins](https://opencode.ai/docs/plugins/) · [Custom tools](https://opencode.ai/docs/custom-tools/)
- **Claude Code**: [Plugins](https://code.claude.com/docs/en/plugins) · [Skills](https://code.claude.com/docs/en/skills)
