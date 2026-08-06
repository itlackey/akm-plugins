# AKM plugin eval — tier2

- Plugin version: `0.9.0`
- Git SHA: `f9559a84b3fe5eb481489600637e11655420b3b8`
- Ran at: 2026-08-03T07:39:44.484Z
- Duration: 23989 ms

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
| cur-032 | What's the recommended way to handle exceptions in this c... | knowledge/repo-conventions,skills/debug-runtime | scripts/lint.sh,commands/bump-version,env/staging.env | 0.00 | — |
| cur-034 | Write tests for the new parser module | commands/scaffold-test | skills/code-review,env/staging.env,knowledge/api-error-codes | 0.00 | — |
| cur-008 | Generate release notes from the staged commits | commands/summarize-diff,workflows/release | commands/bump-version,commands/summarize-diff,scripts/smoke.sh | 0.50 | 2 |
| cur-013 | Walk through the deployment runbook for tonight's rollout | knowledge/deployment-runbook,workflows/release | knowledge/deployment-runbook,env/staging.env,knowledge/api-error-codes | 0.50 | 1 |
| cur-040 | Plan a refactor of the payments module with tradeoffs | agents/planner,skills/refactor-py | agents/planner,skills/code-review,commands/bump-version | 0.50 | 1 |

## latency

> Each verb sampled across 8 prompts × 3 iterations (first iteration per prompt dropped as cold start).

| verb | n | p50 ms | p95 ms | p99 ms | mean ms |
| --- | --- | --- | --- | --- | --- |
| curate_prompt | 24 | 97 | 107 | 108 | 97 |
| session_start | 24 | 168 | 188 | 192 | 169 |
| post_tool | 24 | 39 | 44 | 45 | 39 |

## context_budget

> Budget: 4000 chars. Drop rate is the fraction of expected refs that did not survive truncation, averaged across prompts.

| plugin | n | avg chars | max chars | violations | drop rate |
| --- | --- | --- | --- | --- | --- |
| claude | 12 | 1304 | 1383 | 0 | 0.0000 |
| opencode | 12 | 281 | 281 | 0 | 0.0000 |

## feedback

> Both plugins measured by actual `akm feedback` invocations in the call log (NOT in-process classification — that change vs the previous metric exposed an apparent ~18% precision delta on OpenCode that was entirely due to the asymmetric measurement).
> n=13 synthetic tool outputs, all using AKM 0.9 concept-ID refs. "neither"-labeled fixtures verify the plugins correctly skip auto-feedback for the documented skip list (memories/, env/, secrets/, lessons/).

| plugin | tp | fp | fn | tn | precision | recall | polarity flips |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 9 | 0 | 0 | 4 | 1.0000 | 1.0000 | 0 |
| opencode | 9 | 0 | 0 | 4 | 1.0000 | 1.0000 | 0 |

