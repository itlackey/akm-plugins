# AKM plugin eval — tier2

- Plugin version: `0.6.0`
- Git SHA: `2e54fa05c87b152484e395f2ff6057a933aa2f13`
- Ran at: 2026-05-02T15:31:23.927Z
- Duration: 33020 ms

## surface

| Component | Count | Items |
| --- | --- | --- |
| claude commands | 12 | akm-agent, akm-cmd, akm-curate, akm-evolve, akm-feedback, akm-help, akm-remember, akm-search, akm-show, akm-vault, akm-wiki, akm-workflow |
| claude agents | 1 | akm-curator |
| claude hooks | 7 | PostToolUse, PostToolUseFailure, PreCompact, SessionStart, Stop, SubagentStop, UserPromptSubmit |
| claude skills | 1 | akm |
| opencode tools | 14 | akm_agent, akm_cmd, akm_curate, akm_evolve, akm_feedback, akm_help, akm_parent_messages, akm_remember, akm_search, akm_session_messages, akm_show, akm_vault, akm_wiki, akm_workflow |
| opencode commands | 6 | akm-distill-lesson, akm-evolve-session, akm-propose-asset, akm-reflect-on-failure, akm-review-proposals, akm-workflow-status |
| opencode agents | 1 | akm-curator |

## curation

> n=40 prompts, k=5. Worst 5 entries shown below; full per-entry breakdown is in the JSON report under `metrics.curation.values.per_entry`.

| id | prompt | expected | top-3 retrieved | p@k | r@k | rr |
| --- | --- | --- | --- | --- | --- | --- |
| cur-032 | What's the recommended way to handle exceptions in this c... | knowledge:repo-conventions,skill:debug-runtime | script:lint,command:bump-version,knowledge:api-error-codes | 0.00 | 0.00 | 0.00 |
| cur-034 | Write tests for the new parser module | command:scaffold-test | skill:code-review,knowledge:api-error-codes,vault:staging | 0.00 | 0.00 | 0.00 |
| cur-030 | Resume the release workflow that was paused yesterday | workflow:release | command:bump-version,script:smoke,workflow:release | 0.20 | 1.00 | 0.33 |
| cur-008 | Generate release notes from the staged commits | command:summarize-diff,workflow:release | command:bump-version,command:summarize-diff,script:smoke | 0.20 | 0.50 | 0.50 |
| cur-001 | Help me review this pull request for style issues and bugs | skill:code-review,agent:reviewer | skill:code-review,agent:reviewer,agent:planner | 0.40 | 1.00 | 1.00 |

## latency

> Each verb sampled across 8 prompts × 3 iterations (first iteration per prompt dropped as cold start).

| verb | n | p50 ms | p95 ms | p99 ms | mean ms |
| --- | --- | --- | --- | --- | --- |
| curate_prompt | 24 | 130 | 140 | 146 | 132 |
| session_start | 24 | 474 | 501 | 504 | 477 |
| post_tool | 24 | 41 | 44 | 45 | 41 |

## context_budget

> Budget: 4000 chars. Drop rate is the fraction of expected refs that did not survive truncation, averaged across prompts.

| plugin | n | avg chars | max chars | violations | drop rate |
| --- | --- | --- | --- | --- | --- |
| claude | 12 | 867 | 960 | 0 | 0.0000 |
| opencode | 12 | 863 | 956 | 0 | 0.0000 |

## feedback

> n=12 synthetic tool outputs. "Polarity flips" counts cases where the plugin fired feedback with the wrong sign (positive output classified negative or vice versa).

| plugin | tp | fp | fn | tn | precision | recall | polarity flips |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 9 | 0 | 0 | 3 | 1.0000 | 1.0000 | 0 |
| opencode | 9 | 2 | 0 | 1 | 0.8182 | 1.0000 | 0 |

## memory

> Sparse fixtures (< 2 buffer entries) are expected to be trivial-rate dropped.
> Vault leak fires when the captured memory body contains a non-empty value for known secret keys; since the hook pipes the buffer untouched into akm remember, the test indirectly validates that vault VALUES never enter the buffer in the first place.

| fixture | captured? | chars | ref coverage | vault leak? |
| --- | --- | --- | --- | --- |
| rich-multi-asset | yes | 551 | 1.00 | no |
| memory-intent-only | yes | 211 | 1.00 | no |
| sparse-single-entry | no (trivial) | 0 | 1.00 | no |
| vault-leak-attempt | yes | 314 | 1.00 | no |

