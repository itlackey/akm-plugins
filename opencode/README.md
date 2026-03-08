# agentikit-opencode

OpenCode plugin for the [Agentikit](https://github.com/itlackey/agentikit) CLI. Registers tools that let your AI agent **search** and **show** extension assets from a stash directory.

## Installation

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["agentikit-opencode"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `akm_search` | Search the stash for tools, skills, commands, agents, and knowledge |
| `akm_show` | Show a stash asset by its ref |
| `akm_index` | Build or rebuild the search index |
| `akm_agent` | Dispatch a stash `agent:*` into OpenCode using the stash prompt and metadata |
| `akm_cmd` | Execute a stash `command:*` template in OpenCode via SDK session prompting |

## Agent Dispatch

Use `akm_agent` after retrieving an agent ref from `akm_search`.

Inputs:
- `ref` (optional): stash ref like `agent:coach.md`
- `query` (optional): resolve best matching stash agent when `ref` is omitted
- `task_prompt` (required): user task to run
- `dispatch_agent` (optional): OpenCode agent name (defaults to `general`)
- `as_subtask` (optional): create child session (defaults to `true`)

At least one of `ref` or `query` is required.

Behavior:
- Loads the stash agent via `akm show`
- Uses stash `prompt` verbatim as OpenCode `system`
- Applies stash `modelHint` when in `provider/model` format
- Applies stash `toolPolicy` when it maps to boolean tool flags

## Command Execution

Use `akm_cmd` to execute stash command templates through the OpenCode SDK.

Inputs:
- `ref` (optional): stash ref like `command:review.md`
- `query` (optional): resolve best matching stash command when `ref` is omitted
- `arguments` (optional): raw command arguments for `$ARGUMENTS`, `$1`, `$2`, etc.
- `dispatch_agent` (optional): OpenCode agent name (defaults to current agent)
- `as_subtask` (optional): create child session (defaults to `false`)

At least one of `ref` or `query` is required.

## Prerequisites

The `akm` CLI must be installed and available on PATH. Install it from the [agentikit repo](https://github.com/itlackey/agentikit).

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1
```

## Stash model

Set a stash path via `AGENTIKIT_STASH_DIR`:

```sh
export AGENTIKIT_STASH_DIR=/abs/path/to/your-stash
```

Expected layout:

```
$AGENTIKIT_STASH_DIR/
├── tools/      # executable scripts (.sh, .ts, .js, .ps1, .cmd, .bat)
├── skills/     # skill directories containing SKILL.md
├── commands/   # markdown files
├── agents/     # markdown files
└── knowledge/  # markdown files
```

## Docs

- [Agentikit CLI](https://github.com/itlackey/agentikit)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
