# AKM Plugins

Platform plugins for [AKM](https://github.com/itlackey/akm) `^0.9.2`. Both integrations expose exactly five public AKM surfaces:

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

## Versioning

The plugins keep **MAJOR.MINOR in sync with the AKM CLI line they target, and let PATCH diverge** inside that minor. While AKM is on `0.9.x`, the plugins release `0.9.0`, `0.9.1`, `0.9.2`, … independently of AKM's own patch number.

The sync point is `AKM_VERSION_RANGE` in [`claude/shared/akm-version.ts`](./claude/shared/akm-version.ts), which both plugins import. On a `0.x` version a caret range remains inside a minor line — `^0.9.2` means `>=0.9.2 <0.10.0` — and its lower bound is the minimum CLI contract the plugins support.

Patch divergence is deliberate: a plugin-only fix has to be shippable without waiting for an AKM release, which is impossible if the patch component is spent mirroring AKM's.

Versions must be plain semver (`MAJOR.MINOR.PATCH`, optionally `-prerelease`). A four-component string such as `0.9.2.20260811.1` is not semver and npm rejects it on publish. For dated snapshot builds use a prerelease of the *next* patch — `0.9.3-20260811.1`, which sorts above `0.9.2` and below `0.9.3` — rather than a prerelease of the current one, which would sort *below* the version already published. Note that no prerelease satisfies a stable range like `^0.9.2`, so snapshots reach users only through an explicit npm dist-tag.

Both rules are enforced, not conventional:

- [`tests/version-policy.test.ts`](./tests/version-policy.test.ts) pins all four version fields to each other and to the `AKM_VERSION_RANGE` minor line, and pins the three install-ref copies of the range to the constant.
- `.github/workflows/release.yml` validates the requested version *before* it stamps manifests, commits, and pushes a tag — npm would otherwise be the first thing to reject a bad version, long after the tag exists.

## Links

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
