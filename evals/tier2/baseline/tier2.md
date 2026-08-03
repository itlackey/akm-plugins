# AKM plugin eval — tier2

- Plugin version: `0.9.0-beta.1`
- Git SHA: `48f9345a3fc44a7a1f5ff2d4d21f7fd21ae57c61`
- Ran at: 2026-07-05T04:34:50.487Z
- Duration: 17512 ms

## surface

| Component | Count | Items |
| --- | --- | --- |
| claude commands | 5 | akm-curate, akm-feedback, akm-remember, akm-search, akm-show |
| claude agents | 0 |  |
| claude hooks | 12 | PostCompact, PostToolBatch, PostToolUse, PostToolUseFailure, PreToolUse, SessionEnd, SessionStart, SubagentStart, TaskCompleted, TaskCreated, UserPromptExpansion, UserPromptSubmit |
| claude skills | 1 | akm |
| opencode tools | 5 | akm_curate, akm_feedback, akm_remember, akm_search, akm_show |
| opencode commands | 0 |  |
| opencode agents | 0 |  |

## curation

> n=40 prompts. Worst 5 by coverage shown; full per-entry breakdown in metrics.curation.values.per_entry.
> This metric measures plugin-pipeline integrity (did refs returned by akm survive the hook's processing?), NOT akm retrieval quality. The fake-akm shim is held constant.

| id | prompt | expected | top-3 retrieved | coverage | top rank |
| --- | --- | --- | --- | --- | --- |
| cur-032 | What's the recommended way to handle exceptions in this c... | knowledge:repo-conventions,skill:debug-runtime | script:lint,command:bump-version,knowledge:api-error-codes | 0.00 | — |
| cur-034 | Write tests for the new parser module | command:scaffold-test | skill:code-review,knowledge:api-error-codes,vault:staging | 0.00 | — |
| cur-008 | Generate release notes from the staged commits | command:summarize-diff,workflow:release | command:bump-version,command:summarize-diff,script:smoke | 0.50 | 2 |
| cur-013 | Walk through the deployment runbook for tonight's rollout | knowledge:deployment-runbook,workflow:release | knowledge:deployment-runbook,knowledge:api-error-codes,vault:staging | 0.50 | 1 |
| cur-040 | Plan a refactor of the payments module with tradeoffs | agent:planner,skill:refactor-py | agent:planner,skill:code-review,command:bump-version | 0.50 | 1 |

## latency

> Each verb sampled across 8 prompts × 3 iterations (first iteration per prompt dropped as cold start).

| verb | n | p50 ms | p95 ms | p99 ms | mean ms |
| --- | --- | --- | --- | --- | --- |
| curate_prompt | 24 | 60 | 89 | 91 | 66 |
| session_start | 24 | 140 | 188 | 193 | 150 |
| post_tool | 24 | 30 | 43 | 46 | 32 |

## context_budget

> Budget: 4000 chars. Drop rate is the fraction of expected refs that did not survive truncation, averaged across prompts.

| plugin | n | avg chars | max chars | violations | drop rate |
| --- | --- | --- | --- | --- | --- |
| claude | 12 | 1286 | 1379 | 0 | 0.0000 |
| opencode | 12 | 281 | 281 | 0 | 0.0000 |

## feedback

> Both plugins measured by actual `akm feedback` invocations in the call log (NOT in-process classification — that change vs the previous metric exposed an apparent ~18% precision delta on OpenCode that was entirely due to the asymmetric measurement).
> n=12 synthetic tool outputs. "neither"-labeled fixtures verify the plugins correctly skip auto-feedback for memory: and vault: refs.

| plugin | tp | fp | fn | tn | precision | recall | polarity flips |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 9 | 0 | 0 | 3 | 1.0000 | 1.0000 | 0 |
| opencode | 9 | 0 | 0 | 3 | 1.0000 | 1.0000 | 0 |
