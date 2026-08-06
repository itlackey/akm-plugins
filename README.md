# AKM Plugins

Platform plugins for [AKM](https://github.com/itlackey/akm) `^0.9.0`. Both integrations expose exactly five public AKM surfaces:

| Capability | OpenCode tool | Claude slash command |
| --- | --- | --- |
| Search configured bundles or registries | `akm_search` | `/akm-search` |
| Show a concept | `akm_show` | `/akm-show` |
| Curate concepts for a task | `akm_curate` | `/akm-curate` |
| Record an outcome | `akm_feedback` | `/akm-feedback` |
| Save durable knowledge | `akm_remember` | `/akm-remember` |

AKM references are concept IDs in the form `[bundle//]conceptId[#fragment]`, for example `skills/code-review`, `memories/release-notes`, or `team-playbook//knowledge/deploy#Rollback`. The CLI search and curate commands use `--from local`, `--from registry`, `--from all`, or `--from <bundle-name>`.

## OpenCode

Add the plugin to `opencode.json`:

```json
{
  "plugin": ["akm-opencode"]
}
```

The plugin also uses OpenCode lifecycle hooks to inject curated context, preserve it through compaction, record usage feedback, and capture useful session memories. See [opencode/README.md](./opencode/README.md) for details.

## Claude Code

Add the marketplace and install the plugin:

```sh
/plugin marketplace add itlackey/akm-plugins
/plugin install akm
```

Or use the Claude CLI:

```sh
claude plugin marketplace add itlackey/akm-plugins
claude plugin install akm@akm-plugins
```

Claude receives the five slash commands, an AKM skill, and lifecycle hooks for scoped curation, feedback, and memory capture. See [claude/README.md](./claude/README.md) for details.

## Development

Set `AKM_LOCAL_BUILD_CLI=/absolute/path/to/akm/dist/cli.js` to test either plugin against a local AKM build.

## Links

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
