# akm-plugin test suite

## Test files

| File | What it covers |
| --- | --- |
| `opencode-plugin.test.ts` | Full integration coverage for the OpenCode plugin (`opencode/index.ts`): all tools, lifecycle hooks, proposal queue, improve/propose, env, secret, wiki, workflow, akm CLI resolution |
| `claude-plugin.test.ts` | Claude Code plugin (`claude/hooks/akm-hook.ts`): hook wiring, command/doc parity assertions |
| `codex-plugin.test.ts` | Codex plugin (`claude/.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`): manifest and marketplace checks, the commands Codex would convert into skills (a mirror of its install-time rules: one with `$ARGUMENTS` is dropped), then the manifest's two hook commands run as Codex runs them (`commandWindows` on Windows, `command` elsewhere; through every shell Codex may use: `sh -c`, or `pwsh`, `powershell.exe` and `cmd.exe /C` on Windows) — Codex's stdin and stdout shapes, state under `PLUGIN_DATA` rather than `akm-claude`, records labelled `codex`, the Codex wording of the no-bun message, no feedback submitted for a tool event or a "that worked", and the macOS and Linux command exiting 0 without a word when an upgrade has already deleted the plugin root it names |
| `hook-commands.test.ts` | The Claude plugin's manifest handlers (all exec form) run the way Claude Code runs them, with the repo's fake akm on `PATH`, on every platform: every handler dispatches, session-start / curate-prompt / auto-feedback / session-end / extract-session end to end, prompts with spaces and shell metacharacters, HOME unset, a reindex that outlives the hook; `spawnPlan()` (how akm.cmd is started on Windows) and `runPlan()` (what runs akm and gives up on it); on Windows the PATHEXT order, a timed-out `akm.cmd` that has started `bun` and `node` children leaving nothing running, and, when `AKM_REAL_NPM_BIN` is set, the akm-cli npm itself installed |
| `real-hosts.test.ts` | The real Claude Code and the real Codex, started offline against this checkout's plugin (no login, no model call), the skills Codex lists for the plugin (the five commands among them), and the trust hash Codex computes for each of the two hooks, pinned because changing a hook asks every user to trust it again. Skipped unless `AKM_REAL_CLAUDE_BIN` / `AKM_REAL_CODEX_BIN` name their executables; the Windows CI job installs both from npm, and the Linux jobs (`tests.yml`, `release.yml`) install Codex |
| `host-runtime.ts` | Not a test: what each host does to run a hook (Claude's exec form, Codex's per-platform command and shell), a PATH and environment that are right on Windows, and `itPosix` |
| `ref-extraction.test.ts` | `extractAkmRefs()` pattern matching: all ref shapes, edge cases |
| `ref-resolver-contract.test.ts` | Ref resolver contract: resolve + feedback integration |
| `opencode-eval-harness.test.ts` | Eval harness fixtures and score thresholds |
| `release-version.test.ts` | `scripts/release-version.ts`: the plugin release version derived from the akm version (0.10 daily builds `0.10.YYMMDDNN[-stage]` with their own counter; the 0.9 `<akm_version><yyyymmddhhmm>` scheme), validation, and that no derived version is a 20-digit patch |
| `akm-version-check.test.ts` | `satisfiesAkmVersionRange()` against the `^0.10.26101001-alpha` contract: judges the release core, so it accepts 0.10 daily builds (8-digit patch) at or above the floor (prereleases included) and rejects releases below the floor or outside the line. |

## AKM CLI resolution (audit #19)

`opencode-plugin.test.ts` — `describe("akm CLI availability")` — covers all three fallback
paths that `getBundledAkmCommand()` and `getResolvedAkmDetails()` exercise:

| Test | Path exercised |
| --- | --- |
| "uses a compatible AKM executable without attempting Bun auto-install" | `akm` on PATH (compatible version) |
| "falls back to ~/.local/bin/akm when PATH lookup fails" | `~/.local/bin/akm` user-local binary |
| "prefers ~/.config/opencode/node_modules/.bin/akm before user-local fallbacks" | `~/.config/opencode/node_modules/.bin/akm` (config-dir install) |
| "returns a compatibility error when only unsupported AKM versions are available" | No compatible candidate found → structured error |

The `moduleDir/node_modules/.bin/akm` path (the plugin's own bundled binary, first
candidate in `getBundledAkmCommand()`) is exercised indirectly: the mock filesystem
setup in `createPluginInput()` does not create that file, so the function falls through
to PATH candidates, matching normal dev-machine behavior. A direct
`getBundledAkmCommand()` unit test is not required because the function is a thin
`existsSync` + `readFileSync(package.json)` wrapper with no conditional logic beyond
file presence.

## Redaction patterns (audit #16)

`tests/redaction.test.ts` — unit tests for all patterns in `shared/redaction.ts`:

- Private key PEM blocks
- Bearer tokens
- GitHub tokens (gh[pousr]_* and github_pat_*)
- OpenAI API keys (sk-*)
- Slack tokens (xox[baprs]-*)
- Database connection strings (postgres://, mysql://, mongodb+srv://, redis://)
- AWS ARN structures with embedded 12-digit account IDs
- JWT-shaped tokens (eyJ header, three base64url segments)
- Env-assignment lines (KEY=VALUE) for sensitive key names
- JSON-like key:value pairs for password, secret, token, etc.
- High-entropy strings (opt-in via `AKM_REDACT_HIGH_ENTROPY=1`)

## Proposal cache invalidation (audit #15)

`tests/proposal-cache.test.ts` — verifies that `pendingProposalSummaryCache` is cleared
after `akm_proposal accept`, `akm_proposal reject`, and non-dry-run `akm_improve` so
the next `getPendingProposalCount()` call re-fetches from the CLI rather than returning
stale data.

## Windows

`.github/workflows/tests.yml` has a `windows` job (`windows-latest`) that runs the hook-side tests: `claude-plugin`, `codex-plugin`, `hook-commands`, `akm-version-check` and the pure shared-module tests, then `real-hosts`. The OpenCode tests and `fake-akm-contract` (which needs the `opencode/` dependencies and a POSIX shim) stay on Linux.

The fake akm installs an `akm.cmd` beside its extensionless sh script on Windows, as npm does for the real one, and `PATH` there holds only the test's bin directory, Bun's directory and the system directories, so `sh` (Git Bash) is not resolvable. Tests that write their own fake akm as a POSIX `sh` script, check POSIX mode bits or run `akm-hook.sh` are registered with `itPosix` (from `host-runtime.ts`), which skips them on Windows and puts that in the test's name. The Windows-capable tests above cover the same hook modes and akm calls.
