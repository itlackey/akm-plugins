# Tier 3 — LLM-in-the-loop scenarios

End-to-end scenario evaluation. Each scenario is a YAML describing a
user goal, expected curated refs, expected feedback, and forbidden
content. The harness drives the scenario through both plugins; an LLM
judge (Claude Sonnet 4.6) scores the resulting transcripts against a
fixed rubric.

## Components

- **`scenarios.ts`** — YAML loader + types. See `scenarios/*.yaml` for
  examples.
- **`harness/run-scenario.ts`** — Drives a scenario through the Claude
  hook script or the OpenCode plugin in-process; produces a structured
  `ScenarioRun` transcript.
- **`judge/rubric.ts`** — 5-dimension rubric (asset_use, on_task,
  feedback_loop, hallucination, conciseness) + JSON schema enforced via
  tool-use forcing.
- **`judge/client.ts`** — Anthropic SDK wrapper with prompt caching on
  the rubric system prompt, structured outputs via tool-use forcing,
  per-run dollar cap, and verdict cache keyed on
  `sha256(scenario.id + transcript)`.
- **`runner.ts`** — Loads scenarios, runs them, judges them, writes
  `eval-results/tier3-<ts>/tier3.{json,md}`.
- **`ab.ts`** — Pairwise A/B between two git refs via `git worktree`.
  Shuffles labels per trial, runs N=3 trials, reports candidate
  win-rate with a Wilson 95% confidence interval.

## Quick start

```sh
cd evals

# Run all scenarios across both plugins, no judge (free; validates harness)
bun run tier3 -- --no-judge --agent stub

# With judge — requires ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY=sk-ant-...
bun run tier3

# Filter to one scenario
bun run tier3 -- --scenarios "curate-skill-*"

# Cap spend
bun run tier3 -- --budget 1

# Pairwise A/B between two git refs
bun run tier3:ab -- main HEAD --trials 3 --budget 5
bun run tier3:ab -- v0.5.0 v0.6.0 --scenarios "curate-*" --plugin claude
```

## Scenario YAML format

```yaml
id: curate-skill-code-review              # unique
description: One-line summary
plugins: [claude, opencode]               # which plugins to evaluate
seed_stash: default                       # currently unused; reserved
user_turns:
  - role: user
    content: "Help me review the diff in src/api/handlers.ts."
expectations:
  must_curate_refs: [skill:code-review]   # MUST appear in injected context
  may_curate_refs: [agent:reviewer]       # bonus if they do
  must_record_feedback_for: [skill:code-review]
  forbid_refs: [vault:staging]            # MUST NOT appear
  max_total_tokens: 8000                  # soft budget the judge considers
judge_rubric: default                     # default | strict
weight: 1.0                               # multiplier in aggregate scores
```

## How the harness works

Two agent modes:

### Real agent (default when `ANTHROPIC_API_KEY` is set)

`tier3/harness/claude-agent.ts` runs an actual Claude API loop. The
agent receives the curated context the plugin would inject, has a Bash
tool whose `akm ...` invocations are routed through the sandbox PATH
(hitting fake-akm, just like the rest of the framework), and decides
what to do. It can:

- pick the right asset from curation, or pick a wrong one, or pick none
- successfully invoke `akm show` and `akm feedback`, or hallucinate refs
- skip recording feedback when it should have, or fire on the wrong ref
- ignore curation entirely and try to answer from memory

The judge then scores a transcript that has REAL variance to disagree
with. This is the only mode that produces meaningful tier-3
effectiveness numbers.

### Stub agent (when no API key, or `--agent stub`)

A deterministic projection of `must_curate_refs ⊆ retrieved`. For each
expected ref that surfaced, it synthesizes a `tool_use → tool_result →
feedback` triple. It hardcodes the plugins' documented skip rule (no
auto-feedback for `memory:`/`vault:` refs) so the transcript matches
what the real plugins would emit. **Stub-mode judge scores are
smoke-test signal only** — the transcript is mechanically derived from
the expectations, so the judge has nothing meaningful to disagree with.
Reports tag every run with `agent_mode: "real" | "stub"` and emit a
WARNING block in the markdown when any stub runs are present, so
consumers can't accidentally treat smoke runs as effectiveness data.

## Cost control

- `--budget USD` — hard cap on judge spend; runner aborts when reached.
  Default: $5 for `runner.ts`, $10 for `ab.ts`.
- Verdict cache (`tier3/.verdict-cache/`) — keyed on
  `(scenario.id, plugin, sha256(transcript))`. Re-running the same
  candidate is free.
- Prompt caching — the rubric system prompt is cached; routine runs hit
  ~90% read price on system tokens.

## Pairwise A/B

The A/B tool uses `git worktree` to materialize two refs in temp
directories, then runs each scenario in both worktrees. The worktrees'
own eval framework (`evals/tier3/harness/...`) is loaded — so the A/B
requires both refs to ship this framework.

For each (scenario, plugin) pair, N=3 trials are run with shuffled
labels (the judge sees "A vs B" without knowing which is baseline).
After mapping back, candidate win-rate is reported with a Wilson 95%
confidence interval.

If a plugin and fixture change ship together, the A/B reflects both.
For plugin-only deltas, port the candidate's fixture commit onto the
baseline ref before running.

## Limits / future work

- Single judge model — currently `claude-sonnet-4-6`. The model can be
  overridden via `Judge({ model: ... })` when the runner instantiates
  it.
- Single agent model — `claude-sonnet-4-6` by default; override via
  `--agent-model claude-opus-4-7` (the plugins are most relevant when
  driving Opus-tier agents in production).
- Curator sub-agent eval — not yet wired up; would need a separate
  scenario class with longer multi-turn fixtures and a different
  rubric.
