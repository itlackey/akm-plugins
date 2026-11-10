# AKM Plugins

Platform plugins for [AKM](https://github.com/itlackey/akm). Each plugin carries the exact `akm-cli` it was tested with, so installing a plugin needs no separate akm install. The OpenCode, Claude, and Codex integrations expose exactly five public AKM surfaces:

| | OpenCode | Claude Code | Codex |
| --- | --- | --- | --- |
| Search configured bundles or registries | `akm_search` | `/akm-search` | `akm-search` skill |
| Show a concept | `akm_show` | `/akm-show` | `akm-show` skill |
| Curate concepts for a task | `akm_curate` | `/akm-curate` | `akm-curate` skill |
| Record an outcome | `akm_feedback` | `/akm-feedback` | `akm-feedback` skill |
| Save durable knowledge | `akm_remember` | `/akm-remember` | `akm-remember` skill |
| Curated context at session start | yes | yes | yes |
| Curated context for each prompt | yes | yes | yes |
| AKM skill | no | yes | yes |
| Feedback from tool results | no | yes | no |

AKM references are concept IDs in the form `[bundle//]conceptId[#fragment]`, for example `skills/code-review`, `team-playbook//knowledge/deploy#Rollback`, or the opaque 0.9.14 selector `knowledge/long-guide#akm-fragment-3-1138d4941c9a`. The CLI search and curate commands use `--from local`, `--from registry`, `--from all`, or `--from <bundle-name>`. Curate can also pack ranked local assets' full content into one token-budgeted response; OpenCode exposes that as `akm_curate.pack`, and Claude's `/akm-curate` uses it directly.

AKM 0.9.15 fragment refs remain exact by default. For opaque refs returned by
search, both integrations expose the opt-in indexed-safe `lead` context mode
and its mutually exclusive token/character budgets; responses retain canonical
parent identity alongside selected-fragment, neighbor, size, and truncation
provenance. Friendly authored heading selectors retain their existing
source-live behavior.

## Automatic learning proposals

Both plugins now capture the learning signals that occur naturally in a coding conversation: explicit `remember:` requests, corrections, guardrails, durable preferences, and positive confirmation. Strong reusable signals are redacted, project-scoped, durably deduplicated, and submitted asynchronously with `akm proposal new` as `memory` or `instruction` proposals. Positive feedback remains evidence rather than becoming a content-free proposal.

Proposal authoring uses the agent profile configured for AKM; run `akm setup` if `proposal new` reports that no authoring agent is available.

This flow is informed by [claude-reflect](https://github.com/BayramAnnakov/claude-reflect)'s capture-then-review design, but it ends at the AKM proposal queue instead of writing assistant instruction files directly.

They also retain conservative task-intent observations across sessions. When a similar intent recurs in at least three distinct sessions, the plugin submits a cross-platform `skill` proposal. Neither integration edits `CLAUDE.md`, `AGENTS.md`, rule files, or commands; the boundary stops at proposal submission, and downstream AKM proposal commands own review and promotion.

## OpenCode

There is one plugin per OpenCode major. Install only the one that matches your OpenCode; neither installs or replaces the `opencode` binary.

**OpenCode 1.x** (tested 1.18.34): add `akm-opencode` to `opencode.json`:

```json
{
  "plugin": ["akm-opencode"]
}
```

The bare name resolves to the `latest` tag, which is still a stable 0.9 build. For the AKM 0.10 plugin use `"akm-opencode@next"` (the prerelease channel) or an exact version such as `"akm-opencode@0.10.261002-beta"`.

It also uses OpenCode lifecycle hooks to inject curated context, preserve it through compaction, record usage feedback, and capture useful session memories. See [opencode/README.md](./opencode/README.md) for details.

**OpenCode 2.x** (built against `@opencode/plugin` 2.1.4): add `akm-opencode-v2@next`:

```json
{
  "plugins": ["akm-opencode-v2@next"]
}
```

The bare name `akm-opencode-v2` installs whatever npm's `latest` tag points at. `@next` (the prerelease channel) or an exact version such as `akm-opencode-v2@0.10.261002-beta` is still the explicit choice; `opencode plugin add akm-opencode-v2@next` does the same from the command line.

It registers the same five tools, injects recall into the model request, and extracts finished sessions through `akm proposal extract`. See [opencode-v2/README.md](./opencode-v2/README.md) for the hook mapping and what is not ported from V1.

All three plugins pin the same `akm-cli` release and call only its public CLI; the shared invocation, recall and tool-schema code lives in [`opencode-shared/`](./opencode-shared).

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

To follow the prerelease channel instead, add the marketplace from the `next` branch, which each prerelease moves to its tagged commit:

```sh
claude plugin marketplace add itlackey/akm-plugins@next
```

Or set it in `settings.json` so it updates by itself:

```json
{
  "extraKnownMarketplaces": {
    "akm-plugins": {
      "source": { "source": "github", "repo": "itlackey/akm-plugins", "ref": "next" },
      "autoUpdate": true
    }
  }
}
```

The default branch is the stable channel. Claude receives the five slash commands, an AKM skill, and lifecycle hooks for scoped curation, feedback, and memory capture. See [claude/README.md](./claude/README.md) for details. The plugin declares `akm-cli` as an exact-pinned dependency (`claude/package.json` with `claude/bun.lock`), and Claude Code installs it beside the plugin when the plugin is installed or updated; the hooks and commands run that copy and never an `akm` found on `PATH`. The hooks need Claude Code 2.1.139 or newer and Bun on `PATH` (Claude Code also needs Bun to install the dependency, and it needs the npm registry once; afterwards the plugin works offline). If the install fails, `/plugin` shows a note and the session-start message says the plugin's dependencies are missing: update or reinstall the plugin. A marketplace added from a local checkout gets no dependency install, so run `bun install` in `claude/` first. on Windows that means `bun.exe`, and neither Git for Windows nor WSL ([details](./claude/README.md#windows)).

## Codex

Add the marketplace and install the plugin:

```sh
codex plugin marketplace add itlackey/akm-plugins
codex plugin add akm@akm-plugins
```

For the prerelease channel, add the marketplace from the `next` branch (`codex plugin marketplace add itlackey/akm-plugins --ref next`); the default branch is stable.

The Codex plugin is the same [`claude/`](./claude) directory with a second manifest, `.codex-plugin/plugin.json`, listed in [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json). Codex receives the AKM skill, which drives the bundled `akm` CLI directly; the five commands, which Codex converts into skills when it installs the plugin; and two hooks: `SessionStart` injects the AKM primer (with the project's rules and most-used assets, from an akm that has them) and starts the bundled akm, and `UserPromptSubmit` curates context for each prompt. The Claude plugin's other hooks (session extraction, tool and subagent observations) are not part of it, and neither is tool feedback: Codex's `PostToolUse` reports a Bash command's output but no exit status, so a failed `akm` command could not be told from a successful one, and the plugin submits no feedback under Codex.

Codex installs nothing from `package.json`, so the plugin's `akm-cli` is committed as files (`claude/node_modules`, production dependencies only) on each release tag's commit, and the Codex marketplace entry in [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json) is a `git-subdir` source whose `ref` names that tag; the release workflow points it at the new tag on the default branch, and on `next` the entry names that prerelease's own tag. The files are on tag commits only, never on `main`. Until the first release with this entry, `ref` is `main` and a Codex install has no bundled akm: the session-start message says so.

Codex does not run plugin hooks until you review and trust them: open `/hooks` in the Codex CLI and trust the two AKM hooks. See [claude/README.md](./claude/README.md#codex) for details. On Windows the hooks run through PowerShell with Bun on `PATH` (the manifest's `commandWindows`); [claude/README.md](./claude/README.md#windows) says what that needs and what is tested.

## Updating

From akm 0.10, run `akm upgrade`. After it updates the CLI, it updates the akm plugin of each harness it finds: Claude Code and Codex when the `akm-plugins` marketplace is configured and the plugin is installed, and OpenCode when `akm-opencode` is cached (deferred while OpenCode is running). It only updates; it never installs a plugin, and `akm upgrade --check` reports what is pending without changing anything. With the OpenCode plugin present it also moves the CLI only to the `akm-cli` version `akm-opencode@latest` pins. In a headless container, run `akm upgrade -q` from the entrypoint; Codex hooks still need their one-time trust entries baked into `~/.codex/config.toml` (see the `akm upgrade` entry in the akm CLI reference).

Each prerelease (`next`) moves the repo's `next` branch to its tagged commit, so a marketplace that follows `next` sees every prerelease and one that follows the default branch sees stable releases only. The marketplaces do not pin a tag: a tag never moves, so there would be nothing for an update to find. (Codex's plugin entry does name a tag, but the marketplace file that names it follows the branch, and each release changes it.) The plugin's own `akm-cli` moves with each plugin update, which is why the order is `akm-cli` first, then the plugin: a plugin updated before the CLI on your PATH can carry a newer index layout, and the older `akm` then asks you to run `akm upgrade`. Updates are therefore `akm upgrade`, Claude Code's auto-update, or the commands below.

To update by hand, or with an akm older than 0.10:

- **Claude Code** does not auto-update third-party marketplaces by default. Turn it on in `/plugin` → Marketplaces → `akm-plugins` → Enable auto-update, or add `"autoUpdate": true` beside `source` in the `akm-plugins` entry of `extraKnownMarketplaces` in `settings.json` (with `"ref": "next"` in `source` for the prerelease channel, see [above](#claude-code)). The Claude desktop app starts Claude Code with `DISABLE_AUTOUPDATER=1`, which also switches plugin updates off, so desktop users also need `"env": { "FORCE_AUTOUPDATE_PLUGINS": "1" }` in `settings.json`. To update by hand: `claude plugin marketplace update akm-plugins`, then `claude plugin update akm@akm-plugins`. A session that is already running needs `/reload-plugins` to pick the update up.
- **Codex** updates the plugin by itself every time it starts; `codex plugin marketplace upgrade akm-plugins` does it on demand. A release that changes a hook's command shows that hook as modified in `/hooks`, and it does not run until you trust it again.
- **OpenCode 1** installs `akm-opencode` the first time and never checks for a newer version. To update, run `akm upgrade --next`, or close OpenCode and install the exact version you want: `opencode plugin akm-opencode@<version> -g -f`, with `<version>` from `npm view akm-opencode dist-tags.latest` (or `dist-tags.next`). It replaces the plugin entry in the global `opencode.json` and installs the version into its own cache directory (`~/.cache/opencode/packages/akm-opencode@<version>`), so nothing has to be deleted by hand; the old version's directory is left behind. Use an exact version: `akm-opencode@latest` or `akm-opencode@next` reuses its cache directory and does not refresh it.
- **OpenCode 2** manages its plugins with `opencode plugin check` (lists plugins with a newer version) and `opencode plugin update`; then restart OpenCode. A tag spec such as `akm-opencode-v2@next` is never re-resolved on restart, so a restart alone does not update it. `plugin update` installs the new build into a new cache folder and leaves the old folders behind. `plugin list` and `plugin check` print "No plugins found" until the service has loaded its plugins after a restart, so restart OpenCode first if you see that. The update order for either major is `akm-cli` first, then the plugin.

## Development

To test against a local AKM build: both OpenCode plugins read
`AKM_OPENCODE_CLI=/absolute/path/to/akm/dist/akm` and exec it as-is. The Claude/Codex
hook runs `<plugin root>/node_modules/akm-cli/dist/cli.js` under Bun; from a checkout, run
`bun install` in `claude/` and point `claude/node_modules/akm-cli` at the local build.

Each plugin otherwise runs the `akm-cli` version its own `package.json`
declares: the package manager (or Claude Code, or the release tag's files for Codex) resolves it
at install time, and the plugin does not search `PATH` or compare versions at runtime.

Before a core candidate is published, validate against a package tarball built from
a temporary core checkout whose manifest carries the candidate version.

## Versioning

The plugins keep **MAJOR.MINOR in sync with the AKM CLI line they target, and let PATCH diverge** inside that minor. While AKM is on `0.9.x`, the plugins release `0.9.0`, `0.9.1`, `0.9.2`, … independently of AKM's own patch number. From AKM 0.10 the patch is a monthly release number (see below).

All three plugins exact-pin one `akm-cli` (the dependency in `claude/package.json`, `opencode/package.json` and `opencode-v2/package.json`, with their lockfiles), so a plugin release always executes the CLI it was tested with and the plugins never disagree about which `akm` owns the shared databases. The release workflow sets the pin for a `next` release; for a stable one it requires the pin to equal `akm_version`. None of the plugins checks a version at runtime. Claude Code installs `claude/package.json`'s dependencies only when `claude/bun.lock` agrees with it, so whatever sets the pin regenerates the lock in the same commit.

Patch divergence is deliberate: a plugin-only fix has to be shippable without waiting for an AKM release, which is impossible if the patch component is spent mirroring AKM's.

Versions must be plain semver (`MAJOR.MINOR.PATCH`, optionally `-prerelease`). A four-component string such as `0.9.30.20260929.1` is not semver and npm rejects it on publish. For dated snapshot builds use a prerelease of the *next* patch — `0.9.31-20260929.1`, which sorts above `0.9.30` and below `0.9.31` — rather than a prerelease of the current one, which would sort *below* the version already published. Snapshots reach users only through an explicit npm dist-tag.

**Prerelease channel (`next`).** When the AKM CLI publishes a prerelease to its npm `next` dist-tag (say `0.9.31-alpha.4`), the release workflow can be run with that as `akm_version`. A prerelease `akm_version` makes it a `next` release: the plugin version is `<akm_version>.<UTC yyyymmddhhmm>` (`0.9.31-alpha.4.202610080512`, which sorts above `0.9.31-alpha.4` and below `0.9.31`), `akm-opencode` and `akm-opencode-v2` are published with `--tag next`, and the GitHub release is marked a prerelease. The `akm-cli@<akm_version>` it names must already be on npm; the workflow waits up to 10 minutes for npm to serve it, so dispatch it as soon as the AKM release has finished. The Claude/Codex plugin and both OpenCode builds exact-pin that prerelease and regenerate `claude/bun.lock`, `opencode/bun.lock` and `opencode-v2/bun.lock` against it first, then the typechecks, the tests and the tier-2 evals run against that pin, so a release is tested with the `akm-cli` it ships and a failure stops it before the tag exists. The pins and lockfiles are committed only in the commit the `v<version>` tag points at: nothing is committed to `main`, and the pins on `main` do not move. To follow the channel in OpenCode 1, set `"plugin": ["akm-opencode@next"]` in `opencode.json` (`"plugins": ["akm-opencode-v2@next"]` for OpenCode 2, where the bare name cannot install because every version is a prerelease); the `latest` tags stay on the stable line.

**Semver releases (AKM 0.11 onward).** AKM 0.11+ uses plain semver ([akm#1591](https://github.com/itlackey/akm/issues/1591)): `0.11.0-beta.1`, `0.11.0`, `0.11.1`. Every AKM release, prereleases included, is followed by a plugin release with that version as `akm_version`; the plugins keep their own patch inside AKM's `0.<minor>`. A stable release is `0.<minor>.<P>`, `P` one above the highest stable `akm-opencode` patch of that minor on npm (`0` if none). A prerelease is `0.<minor>.<P>-<stage>.<N>`, with the same `P` and `N` one above the highest published `-<stage>.N` of that version, and is a `next` release. For example `0.11.0-beta.1` gives `0.11.0-beta.1`, then `0.11.0` gives `0.11.0`; a plugin-only fix after that is `0.11.1`, and `0.11.2` with plugins already at `0.11.4` gives `0.11.5`. The release notes name the AKM version carried. For a stable release, move the exact `akm-cli` pin in `claude/package.json`, `opencode/package.json` and `opencode-v2/package.json` to `akm_version` first, and their lockfiles with it (`bun install` in each package). The release then commits the bump (with the Codex marketplace entry's `ref` set to the new tag) to the default branch, and the tag points one commit further, at the commit that adds `claude/node_modules`. A prerelease must sort above npm `next`, so one for an older minor or with a backwards stage (`-beta` after `-rc`) is refused before anything is tagged. The monthly scheme below applies to AKM 0.10 only.

**Monthly release numbers (AKM 0.10 only).** AKM 0.10 versions its releases as `0.10.YYMMNN` (UTC year, month and the release number within that month, two digits each, `NN` 01 to 99), with `-alpha`, `-beta` or `-rc` for a prerelease and no `.N` ([akm#1089](https://github.com/itlackey/akm/issues/1089)). Every release consumes a new `NN` whatever its stage: `0.10.261001-alpha`, `0.10.261002-beta`, `0.10.261003`. The plugins use the same scheme with their own counter. Run the release workflow with the AKM version they target as `akm_version`, and the plugin version is `0.10.<UTC YYMM><NN>[-stage]`: `NN` is one above the highest 6-digit `akm-opencode` version already on npm for the current UTC month (stage ignored), and the stage is copied from `akm_version`.

| `akm_version` | at (UTC) | `akm-opencode` published this month | plugin version | npm tag |
| --- | --- | --- | --- | --- |
| `0.10.261001-beta` | 2026-10-12 | none | `0.10.261001-beta` | `next` |
| `0.10.261003` | 2026-10-20 | `0.10.261001-beta`, `0.10.261002-rc` | `0.10.261003` | `latest` |
| `0.10.261102-rc` | 2026-11-03 | none (October's do not count) | `0.10.261101-rc` | `next` |

A stage makes it a `next` release exactly as the 0.9 prerelease channel does (the `akm-cli@<akm_version>` it names must already be on npm and OpenCode's build exact-pins it), and `0.10.261002-rc` sorts below `0.10.261002`. The 0.9 scheme could not continue: `<akm_version><yyyymmddhhmm>` would be `0.10.261001202610121200`, an 18-digit patch above `Number.MAX_SAFE_INTEGER`, which node-semver and npm reject. A malformed `akm_version` (not two digits each, a month outside 01 to 12, `NN` outside 01 to 99, a stage other than those three) fails before anything is tagged, and so does a retired 8-digit daily `akm_version` (`0.10.YYMMDDNN`). AKM 0.9 releases keep the old scheme above, so the 0.9 plugins can still be released.

**Known, accepted break.** The earlier daily scheme published `0.10.26101001-alpha` to `0.10.26101201-alpha`. Semver compares the patch numerically, so every `0.10.YYMMNN` sorts below those: anyone on a daily alpha must install the first monthly build explicitly once (`akm-opencode@0.10.261001-beta`; `next` is moved to it), and an update check will not offer it. The release workflow skips its sort-above-published check only when the published tag is such an 8-digit build, and `tests/release-version.test.ts` pins this ordering so it is not "fixed" by accident.

Both rules are enforced, not conventional:

- [`tests/version-policy.test.ts`](./tests/version-policy.test.ts) pins all version fields (all three plugins) to each other and to the minor line of the `akm-cli` pin, and requires the Claude/Codex plugin's and both OpenCode packages' dependency and lockfile to be the same exact `akm-cli` version. That pin is written in those manifests and lockfiles only: the workflows read it from them, and the test fails if a workflow names a version. It also keeps the Codex tag stamping and the tag-only `claude/node_modules` commit in the release workflow in their order.
- [`scripts/release-version.ts`](./scripts/release-version.ts) derives the plugin version from `akm_version` and the UTC clock (the 0.9, 0.10 and 0.11+ schemes), tested in [`tests/release-version.test.ts`](./tests/release-version.test.ts).
- `.github/workflows/release.yml` validates the requested version *before* it stamps manifests, commits, and pushes a tag — npm would otherwise be the first thing to reject a bad version, long after the tag exists.

## Links

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Codex plugins](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
