# AKM Plugins

Platform plugins for [AKM](https://github.com/itlackey/akm) `^0.9.14`. Both integrations expose exactly five public AKM surfaces:

| Capability | OpenCode tool | Claude slash command |
| --- | --- | --- |
| Search configured bundles or registries | `akm_search` | `/akm-search` |
| Show a concept | `akm_show` | `/akm-show` |
| Curate concepts for a task | `akm_curate` | `/akm-curate` |
| Record an outcome | `akm_feedback` | `/akm-feedback` |
| Save durable knowledge | `akm_remember` | `/akm-remember` |

AKM references are concept IDs in the form `[bundle//]conceptId[#fragment]`, for example `skills/code-review`, `team-playbook//knowledge/deploy#Rollback`, or the opaque 0.9.14 selector `knowledge/long-guide#akm-fragment-3-1138d4941c9a`. The CLI search and curate commands use `--from local`, `--from registry`, `--from all`, or `--from <bundle-name>`. Curate can also pack ranked local assets' full content into one token-budgeted response; OpenCode exposes that as `akm_curate.pack`, and Claude's `/akm-curate` uses it directly.

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

To test against a local AKM build: the Claude hook reads
`AKM_LOCAL_BUILD_CLI=/absolute/path/to/akm/dist/cli.js` and runs it under Bun;
the OpenCode plugin reads `AKM_OPENCODE_CLI=/absolute/path/to/akm/dist/akm` and
execs it as-is. Two names because they take two different things — one name for
both is how the eval sandbox handed each plugin the other's form.

The OpenCode plugin otherwise runs the `akm-cli` version its own `package.json`
declares — the package manager resolves it at install time, and the plugin does
not search `PATH` or compare versions at runtime.

## Versioning

The plugins keep **MAJOR.MINOR in sync with the AKM CLI line they target, and let PATCH diverge** inside that minor. While AKM is on `0.9.x`, the plugins release `0.9.0`, `0.9.1`, `0.9.2`, … independently of AKM's own patch number.

The Claude compatibility floor is `AKM_VERSION_RANGE` in [`claude/shared/akm-version.ts`](./claude/shared/akm-version.ts). On a `0.x` version a caret range remains inside a minor line — `^0.9.14` means `>=0.9.14 <0.10.0`. OpenCode exact-pins that floor (`akm-cli@0.9.14`) because it imports AKM's in-process `dist/` modules; allowing an untested patch to resolve at user install time would make one plugin release execute different private APIs on different machines.

Patch divergence is deliberate: a plugin-only fix has to be shippable without waiting for an AKM release, which is impossible if the patch component is spent mirroring AKM's.

Versions must be plain semver (`MAJOR.MINOR.PATCH`, optionally `-prerelease`). A four-component string such as `0.9.14.20260904.1` is not semver and npm rejects it on publish. For dated snapshot builds use a prerelease of the *next* patch — `0.9.15-20260904.1`, which sorts above `0.9.14` and below `0.9.15` — rather than a prerelease of the current one, which would sort *below* the version already published. Note that no prerelease satisfies a stable range like `^0.9.14`, so snapshots reach users only through an explicit npm dist-tag.

Both rules are enforced, not conventional:

- [`tests/version-policy.test.ts`](./tests/version-policy.test.ts) pins all four version fields to each other and to the `AKM_VERSION_RANGE` minor line, keeps Claude's install ref equal to that range, and requires OpenCode's dependency and lockfile to equal the range floor exactly.
- `.github/workflows/release.yml` validates the requested version *before* it stamps manifests, commits, and pushes a tag — npm would otherwise be the first thing to reject a bad version, long after the tag exists.

## Links

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
