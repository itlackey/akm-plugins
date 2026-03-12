# akm-opencode

OpenCode plugin for the [Agentikit](https://github.com/itlackey/agentikit) CLI. Registers tools that let your AI agent **search**, **show**, and **manage** extension assets from stash directories and registries.

## Installation

Add to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["akm-opencode"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `akm_search` | Search the local stash, the registry, or both for scripts, skills, commands, agents, and knowledge |
| `akm_registry_search` | Search configured registries for installable kits and optional asset-level hits |
| `akm_show` | Show a stash asset by its ref |
| `akm_index` | Build or rebuild the search index |
| `akm_agent` | Dispatch a stash `agent:*` into OpenCode using the stash prompt and metadata |
| `akm_cmd` | Execute a stash `command:*` template in OpenCode via SDK session prompting |
| `akm_add` | Install kits from npm, GitHub, git URLs, or local directories |
| `akm_list` | List installed registry kits |
| `akm_remove` | Remove an installed registry kit and reindex |
| `akm_update` | Update one installed kit or all installed kits |
| `akm_clone` | Clone an asset into the working stash or a custom destination for editing |
| `akm_config` | Get, set, unset, list, or inspect akm configuration (including `config path --all`) |
| `akm_run` | Execute a stash script using its `run` field |
| `akm_sources` | List all resolved stash search paths |
| `akm_upgrade` | Check for or install akm CLI updates |

### Registry discovery

Use either:

- `akm_search` with `source: "registry"` or `source: "both"`
- `akm_registry_search` when you only want installable community kits

Registry hits include `id`, `installRef`, and `action` fields. Use `installRef` when passing a result into `akm_add`; registry-specific IDs are not installable refs. Use `assets: true` when you also want asset-level matches from registry v2 indexes.

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

The plugin prefers an existing `akm` on PATH. If `akm` is missing and `bun` is available, it will attempt `bun install -g akm-cli` automatically. It does not run the standalone shell installers automatically. If Bun is not available, install `akm` from the [agentikit repo](https://github.com/itlackey/agentikit).

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1

# Or via Bun
bun install -g akm-cli
```

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
└── knowledge/  # markdown files
```

Assets are resolved from three source types: **working** (local stash), **search paths** (additional dirs via `searchPaths` config), and **installed** (registry kits via `akm add`).

## Docs

- [Agentikit CLI](https://github.com/itlackey/agentikit)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
