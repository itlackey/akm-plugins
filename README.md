# AKM Plugins

Platform plugins for [AKM](https://github.com/itlackey/akm) `^0.9.27`. The OpenCode, Claude, and Codex integrations expose exactly five public AKM surfaces:

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

Claude receives the five slash commands, an AKM skill, and lifecycle hooks for scoped curation, feedback, and memory capture. See [claude/README.md](./claude/README.md) for details. The hooks need Claude Code 2.1.139 or newer and Bun on `PATH`; on Windows that means `bun.exe`, and neither Git for Windows nor WSL ([details](./claude/README.md#windows)).

## Codex

Add the marketplace and install the plugin:

```sh
codex plugin marketplace add itlackey/akm-plugins
codex plugin add akm@akm-plugins
```

The Codex plugin is the same [`claude/`](./claude) directory with a second manifest, `.codex-plugin/plugin.json`, listed in [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json). Codex receives the AKM skill, which drives the `akm` CLI directly; the five commands, which Codex converts into skills when it installs the plugin; and two hooks: `SessionStart` injects the AKM primer and checks the CLI version, and `UserPromptSubmit` curates context for each prompt. The Claude plugin's other hooks (session extraction, tool and subagent observations) are not part of it, and neither is tool feedback: Codex's `PostToolUse` reports a Bash command's output but no exit status, so a failed `akm` command could not be told from a successful one, and the plugin submits no feedback under Codex.

Codex does not run plugin hooks until you review and trust them: open `/hooks` in the Codex CLI and trust the two AKM hooks. See [claude/README.md](./claude/README.md#codex) for details. On Windows the hooks run through PowerShell with Bun on `PATH` (the manifest's `commandWindows`); [claude/README.md](./claude/README.md#windows) says what that needs and what is tested.

## Updating

- **Claude Code** does not auto-update third-party marketplaces by default. Turn it on in `/plugin` → Marketplaces → `akm-plugins` → Enable auto-update, or add `"autoUpdate": true` beside `source` in the `akm-plugins` entry of `extraKnownMarketplaces` in `settings.json`. The Claude desktop app starts Claude Code with `DISABLE_AUTOUPDATER=1`, which also switches plugin updates off, so desktop users also need `"env": { "FORCE_AUTOUPDATE_PLUGINS": "1" }` in `settings.json`. To update by hand: `claude plugin marketplace update akm-plugins`, then `claude plugin update akm@akm-plugins`.
- **Codex** updates the plugin by itself every time it starts; `codex plugin marketplace upgrade akm-plugins` does it on demand. A release that changes a hook's command shows that hook as modified in `/hooks`, and it does not run until you trust it again.
- **OpenCode** installs `akm-opencode` the first time and never checks for a newer version. To update, close OpenCode, delete `~/.cache/opencode/packages/akm-opencode@latest`, and start OpenCode again.

## Development

To test against a local AKM build: the Claude hook reads
`AKM_LOCAL_BUILD_CLI=/absolute/path/to/akm/dist/cli.js` and runs it under Bun;
the OpenCode plugin reads `AKM_OPENCODE_CLI=/absolute/path/to/akm/dist/akm` and
execs it as-is. Two names because they take two different things — one name for
both is how the eval sandbox handed each plugin the other's form.

The OpenCode plugin otherwise runs the `akm-cli` version its own `package.json`
declares — the package manager resolves it at install time, and the plugin does
not search `PATH` or compare versions at runtime.

Before a core candidate is published, validate against a package tarball built from
a temporary core checkout whose manifest carries the candidate version. The
OpenCode guard reads the manifest of the dependency it actually imported;
requesting a newer API against an older exact-pinned dependency returns a
structured error instead of silently returning exact content.

Release-order gate: publish `akm-cli@0.9.27` first, then update OpenCode's exact
dependency and lockfile and Claude's compatibility floor to 0.9.27, run the
real-package contract suite, and only then publish the plugins. Do not fabricate
the unpublished registry lock entry on this branch.

## Versioning

The plugins keep **MAJOR.MINOR in sync with the AKM CLI line they target, and let PATCH diverge** inside that minor. While AKM is on `0.9.x`, the plugins release `0.9.0`, `0.9.1`, `0.9.2`, … independently of AKM's own patch number.

The Claude compatibility floor is `AKM_VERSION_RANGE` in [`claude/shared/akm-version.ts`](./claude/shared/akm-version.ts). On a `0.x` version a caret range remains inside a minor line — `^0.9.27` means `>=0.9.27 <0.10.0`. OpenCode exact-pins that floor (`akm-cli@0.9.27`) because it imports AKM's in-process `dist/` modules; allowing an untested patch to resolve at user install time would make one plugin release execute different private APIs on different machines.

Patch divergence is deliberate: a plugin-only fix has to be shippable without waiting for an AKM release, which is impossible if the patch component is spent mirroring AKM's.

Versions must be plain semver (`MAJOR.MINOR.PATCH`, optionally `-prerelease`). A four-component string such as `0.9.27.20260929.1` is not semver and npm rejects it on publish. For dated snapshot builds use a prerelease of the *next* patch — `0.9.28-20260929.1`, which sorts above `0.9.27` and below `0.9.28` — rather than a prerelease of the current one, which would sort *below* the version already published. Note that no prerelease satisfies a stable range like `^0.9.27`, so snapshots reach users only through an explicit npm dist-tag.

**Prerelease channel (`next`).** When the AKM CLI publishes a prerelease to its npm `next` dist-tag (say `0.9.28-alpha.4`), the release workflow can be run with that as `akm_version`. A prerelease `akm_version` makes it a `next` release: the plugin version is `<akm_version>.<UTC yyyymmddhhmm>` (`0.9.28-alpha.4.202610080512`, which sorts above `0.9.28-alpha.4` and below `0.9.28`), `akm-opencode` is published with `--tag next`, and the GitHub release is marked a prerelease. The `akm-cli@<akm_version>` it names must already be on npm. The OpenCode build exact-pins that prerelease and regenerates `opencode/bun.lock` against it, but only in the commit the `v<version>` tag points at: nothing is committed to `main`, and the stable floor (`AKM_VERSION_RANGE`, the pin on `main`) does not move. Claude's range check reads the release core, so an akm prerelease already satisfies `^0.9.27`. To follow the channel in OpenCode, set `"plugin": ["akm-opencode@next"]` in `opencode.json`; `akm-opencode@latest` stays on the stable line.

Both rules are enforced, not conventional:

- [`tests/version-policy.test.ts`](./tests/version-policy.test.ts) pins all five version fields to each other and to the `AKM_VERSION_RANGE` minor line, keeps Claude's install ref equal to that range, and requires OpenCode's dependency and lockfile to equal the range floor exactly.
- `.github/workflows/release.yml` validates the requested version *before* it stamps manifests, commits, and pushes a tag — npm would otherwise be the first thing to reject a bad version, long after the tag exists.

## Links

- [AKM CLI](https://github.com/itlackey/akm)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Codex plugins](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
