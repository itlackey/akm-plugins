# akm-plugin test suite

## Test files

| File | What it covers |
| --- | --- |
| `opencode-plugin.test.ts` | Full integration coverage for the OpenCode plugin (`opencode/index.ts`): all tools, lifecycle hooks, proposal queue, improve/propose, env, secret, wiki, workflow, akm CLI resolution |
| `claude-plugin.test.ts` | Claude Code plugin (`claude/hooks/akm-hook.ts`): hook wiring, command/doc parity assertions |
| `ref-extraction.test.ts` | `extractAkmRefs()` pattern matching: all ref shapes, edge cases |
| `ref-resolver-contract.test.ts` | Ref resolver contract: resolve + feedback integration |
| `opencode-eval-harness.test.ts` | Eval harness fixtures and score thresholds |
| `akm-version-check.test.ts` | `satisfiesAkmVersionRange()` against the `^0.9.2` contract: accepts stable 0.9.2+ builds in the 0.9 line and rejects older releases and prereleases. |

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
