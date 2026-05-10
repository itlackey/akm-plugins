# AKM plugin eval — tier2

- Plugin version: `0.6.0`
- Git SHA: `2aafb1681325dd87afbcd2fdea90b98c99d4e643`
- Ran at: 2026-05-02T15:54:10.150Z
- Duration: 37194 ms

## surface

| Component | Count | Items |
| --- | --- | --- |
| claude commands | 12 | akm-agent, akm-cmd, akm-curate, akm-evolve, akm-feedback, akm-help, akm-remember, akm-search, akm-show, akm-vault, akm-wiki, akm-workflow |
| claude agents | 1 | akm-curator |
| claude hooks | 7 | PostToolUse, PostToolUseFailure, PreCompact, SessionStart, Stop, SubagentStop, UserPromptSubmit |
| claude skills | 1 | akm |
| opencode tools | 14 | akm_agent, akm_cmd, akm_curate, akm_evolve, akm_feedback, akm_help, akm_parent_messages, akm_remember, akm_search, akm_session_messages, akm_show, akm_vault, akm_wiki, akm_workflow |
| opencode commands | 5 | akm-improve-asset, akm-evolve-session, akm-propose-asset, akm-review-proposals, akm-workflow-status |
| opencode agents | 1 | akm-curator |

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
| curate_prompt | 24 | 129 | 134 | 135 | 130 |
| session_start | 24 | 486 | 507 | 529 | 486 |
| post_tool | 24 | 42 | 46 | 47 | 43 |

## context_budget

> Budget: 4000 chars. Drop rate is the fraction of expected refs that did not survive truncation, averaged across prompts.

| plugin | n | avg chars | max chars | violations | drop rate |
| --- | --- | --- | --- | --- | --- |
| claude | 12 | 867 | 960 | 0 | 0.0000 |
| opencode | 12 | 863 | 956 | 0 | 0.0000 |

## feedback

> Both plugins measured by actual `akm feedback` invocations in the call log (NOT in-process classification — that change vs the previous metric exposed an apparent ~18% precision delta on OpenCode that was entirely due to the asymmetric measurement).
> n=12 synthetic tool outputs. "neither"-labeled fixtures verify the plugins correctly skip auto-feedback for memory: and vault: refs.

| plugin | tp | fp | fn | tn | precision | recall | polarity flips |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 9 | 0 | 0 | 3 | 1.0000 | 1.0000 | 0 |
| opencode | 9 | 0 | 0 | 3 | 1.0000 | 1.0000 | 0 |

## memory

> Sparse fixtures (< 2 buffer entries) are expected to be trivial-rate dropped.
> claude_secret_leakages > 0 means the plugin committed a buffer containing a secret-shaped value (e.g. KEY=value). This is a finding about the plugin's lack of buffer scrubbing — vault values stored via the akm CLI are protected, but raw user prompts captured into the buffer are not.

| fixture | captured? | body chars | name format | secret leakage? |
| --- | --- | --- | --- | --- |
| rich-multi-asset | yes | 632 | ok | — |
| memory-intent-only | yes | 294 | ok | — |
| sparse-single-entry | no (trivial) | 0 | — | — |
| vault-leak-attempt | yes | 511 | ok | LEAK: DATABASE_URL=postgres://staging-pw-DO-NOT-LEAK@db.example.co |
