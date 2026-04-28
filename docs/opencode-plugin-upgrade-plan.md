# OpenCode AKM Plugin Status And Follow-Up Plan

## Current State

The old upgrade plan is no longer accurate. The OpenCode plugin on `main`
already shipped the AKM v1 recovery work that restored the trimmed tool
surface, workflow instruction pack, proposal-awareness, curator flow,
workflow commands, raw CLI guardrails, scope propagation, and compaction-safe
context reinjection.

Current OpenCode shape:

- One primary plugin module at `opencode/index.ts`.
- A trimmed surface of 14 first-class `akm_*` tools.
- Packaged OpenCode workflow commands under `opencode/commands/`.
- A packaged curator subagent at `opencode/agent/akm-curator.md`.
- Hook coverage for `event`, `stop`, `chat.message`,
  `experimental.chat.system.transform`, `experimental.session.compacting`,
  `tool.execute.before`, `tool.execute.after`, `permission.ask`,
  `command.execute.before`, and `shell.env`.

Baseline verification after the recovery merge:

- `bun test tests/opencode-plugin.test.ts tests/claude-plugin.test.ts`
- Result: `122 pass, 0 fail`

## Shipped On Main

These AKM v1 OpenCode items are implemented on `main` even if some tracking
issues still need to be closed or updated:

- `lesson:*` support in ref parsing and search typing.
- Proposed-quality warning preservation and `include_proposed` search support.
- AKM v1 workflow instruction injection into session context.
- Pending proposal summary injection without loading proposal bodies.
- Workflow-compliance telemetry events.
- Native OpenCode workflow command docs.
- Raw `akm` CLI risk gating in `permission.ask` and `command.execute.before`.
- Scoped `--user` / `--agent` / `--run` / `--channel` passthrough for
  `akm_remember` and `akm_feedback`.
- Conversation-derived negative retrospective feedback for explicit
  corrections and other negative signals.
- Compaction-safe reinjection of hints, curated context, workflows, pending
  proposal summaries, and curator reports.
- Mid-session memory checkpoints and session-end memory capture.

Primary implementation files:

- `opencode/index.ts`
- `opencode/README.md`
- `opencode/agent/akm-curator.md`
- `opencode/commands/`
- `tests/opencode-plugin.test.ts`

## Remaining Follow-Up

The remaining work is no longer a broad architecture upgrade. It is mostly
tracker cleanup plus a smaller set of parity and refinement tasks.

Known open repo issues still reported as open:

- `#46` workflow-compliance telemetry
- `#45` pending proposal summaries
- `#44` workflow-driven curator
- `#43` raw CLI guardrails
- `#42` lesson/proposed-quality awareness
- `#41` AKM v1 instruction pack
- `#40` built-in workflow commands
- `#39` `akm_help` workflow routing
- `#31` harness-provided LLM fallback
- `#29` conversation-derived feedback
- `#28` auto-pass harness scope metadata

Status interpretation:

- `#39` through `#46` are implemented on `main` and should be reconciled with
  the merged recovery work rather than treated as missing.
- `#28` and `#29` are partially or materially addressed on `main`, but should
  be re-reviewed against their exact acceptance criteria before closing.
- `#31` remains blocked upstream.

## Issue #31

Issue `#31` asks the plugin to lend the harness provider connection to AKM
when `akm.llm` is unset so `akm index` passes can still run.

Latest review target:

- `itlackey/akm` branch `release/1.0.0`

What the AKM v1 branch currently does:

- `src/llm/index-passes.ts` defines the locked v1 rule: every index-time LLM
  pass resolves from the shared top-level `akm.llm` block.
- `resolveIndexPassLLM()` returns `undefined` when `config.llm` is absent.
- `src/indexer/memory-inference.ts` exits early when
  `resolveIndexPassLLM("memory", config)` returns no config.
- `src/indexer/graph-extraction.ts` exits early when
  `resolveIndexPassLLM("graph", config)` returns no config.
- `docs/configuration.md` still documents both passes as disabled when no
  `akm.llm` block is configured.

What I did not find in `release/1.0.0`:

- No `AKM_LLM_PROXY_CMD` support.
- No equivalent env-var fallback for a harness-provided model connection.
- No documented stdin/stdout proxy contract for AKM to call back into a
  harness.

Conclusion:

- OpenCode cannot finish `#31` by itself.
- The plugin can detect that `akm.llm` is unset, but there is still no
  AKM-side contract that would let the CLI borrow the harness connection for
  `akm index` passes.
- The previously dropped OpenCode prototype was only a stub and did not prove
  an end-to-end contract.

Current status for `#31`: blocked on AKM-side implementation and contract.

## Recommended Next Steps For #31

The correct sequence is:

1. Define and land an AKM-side fallback contract in `itlackey/akm`.
2. Document the contract clearly: env var name, request/response format,
   timeout rules, and failure semantics.
3. Wire OpenCode and Claude to expose their harness connection through that
   contract only when `akm.llm` is unset and a harness model is available.
4. Add parity tests proving `akm index` LLM passes succeed without persisted
   `akm.llm` and degrade to no-op when no harness model is available.

Suggested AKM contract questions that still need explicit answers:

- Is the handoff one-shot stdio, local HTTP, or another transport?
- What exact payload does AKM send to the harness proxy?
- Is streaming required, or is one-shot JSON enough for index passes?
- How does AKM select provider/model when the harness has multiple options?
- How are timeout and retry failures surfaced so index passes remain no-op
  instead of hard-failing?

## Plugin Follow-Up After #31 Is Unblocked

Once AKM exposes the fallback contract, the OpenCode plugin work should stay
minimal:

- Use `shell.env` to expose the proxy hook only when `akm.llm` is unset.
- Reuse existing session model information where available.
- Avoid persisting provider credentials into AKM config.
- Keep failure mode non-fatal so `akm index` still degrades to no-op when the
  harness model is unavailable.

Expected verification at that point:

1. OpenCode test coverage for `shell.env` fallback exposure.
2. Claude parity coverage for the same scenario.
3. AKM CLI integration coverage showing `akm index` uses the proxy path when
   `akm.llm` is unset.
4. Manual smoke test proving no provider secrets are copied into AKM config.

## Tracker Cleanup Plan

Short-term repository cleanup should focus on status accuracy:

1. Reconcile `#39` through `#46` against the merged recovery work and close or
   relabel them as appropriate.
2. Re-review `#28` and `#29` against current `main` behavior and tighten any
   missing acceptance coverage before closing.
3. Leave `#31` open but explicitly marked blocked on AKM-side support.
4. Update any stale parity tracker docs after the issue states are reconciled.

## Evidence

- OpenCode plugin implementation: `opencode/index.ts`
- OpenCode tests: `tests/opencode-plugin.test.ts`
- OpenCode docs: `opencode/README.md`
- AKM v1 LLM resolution: `itlackey/akm@release/1.0.0/src/llm/index-passes.ts`
- AKM memory inference gate:
  `itlackey/akm@release/1.0.0/src/indexer/memory-inference.ts`
- AKM graph extraction gate:
  `itlackey/akm@release/1.0.0/src/indexer/graph-extraction.ts`
- AKM configuration docs:
  `itlackey/akm@release/1.0.0/docs/configuration.md`
