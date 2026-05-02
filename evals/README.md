# AKM plugin evaluation framework

Measures the **effectiveness** of the Claude Code and OpenCode plugins
in this repo so plugin authors can quantify whether a change helps or
regresses the user experience. Complements the existing correctness
tests under `tests/`.

## Why a separate framework?

`tests/` answers "does the hook still parse stdin and emit valid JSON?".
This framework answers different questions:

- **Did this change degrade curation quality?** (precision/recall/MRR
  against a gold set of prompt → expected-refs pairs)
- **Did it slow the hook down on the user's prompt path?** (p50/p95/p99
  per hook verb across a synthetic prompt corpus)
- **Did it remove or rename a public surface element?** (tool, command,
  hook diff vs a checked-in baseline)

Reports are JSON + markdown so two runs can be cleanly diffed.

## Tiers

| Tier | What | When | Cost |
|---|---|---|---|
| 1 — correctness | Existing `tests/` (Bun) | every PR | free |
| 2 — deterministic effectiveness | this framework, no LLM | every PR | seconds |
| 3 — LLM-in-the-loop scenarios | Claude judge, scenario YAMLs | manual / `workflow_dispatch` | dollars |

Tier 2 ships six metrics: `surface`, `curation`, `latency`,
`context_budget`, `feedback`, and `memory`. Tier 3 ships a YAML
scenario format, an Anthropic SDK judge with prompt caching, and
pairwise A/B between two git refs. See `tier3/README.md` for details.

## Quick start

```sh
# from repo root
cd evals
bun install

# run all tier-2 metrics
bun run tier2

# run a single metric
bun run tier2:curation
bun run tier2:latency
bun run tier2:surface
bun run tier2:context-budget
bun run tier2:feedback
bun run tier2:memory

# diff a candidate run against the checked-in baseline
bun run diff tier2/baseline/tier2.json ../eval-results/<ts>/tier2.json

# tier-3 (requires ANTHROPIC_API_KEY for the judge)
bun run tier3 -- --no-judge          # validates harness without spending
bun run tier3                        # runs all scenarios, scores them
bun run tier3 -- --scenarios "curate-skill-*" --budget 1
bun run tier3:ab -- main HEAD --trials 3 --budget 5
```

Reports land in `eval-results/<timestamp>/tier2.{json,md}` at the repo
root (gitignored). The first run also serves as your local baseline:

```sh
# promote a clean run to the checked-in baseline
bun run baseline:update
git add tier2/baseline/tier2.json
```

## How it works

Each metric:
1. Spawns a sandbox via `lib/stash-sandbox.ts` — a temp dir with
   isolated `$AKM_STASH_DIR`, `$AKM_PLUGIN_STATE_DIR`, `$XDG_*` so the
   hook never touches the user's real stash.
2. Installs a deterministic fake `akm` binary on `$PATH` via
   `lib/fake-akm.ts`. The shim ranks fixture assets with simple keyword
   matching so retrieval is held constant — metric deltas reflect plugin
   behavior, not akm-cli changes.
3. Invokes `claude/hooks/akm-hook.sh` directly through `Bun.spawnSync`
   (mirrors the pattern in `tests/claude-plugin.test.ts:36-59`).
4. Parses the hook's JSON stdout to extract injected refs, latency,
   context size, etc.

## Layout

```
evals/
├── lib/
│   ├── fake-akm.ts          # deterministic akm CLI shim
│   ├── stash-sandbox.ts     # temp-dir + env isolation
│   ├── report.ts            # JSON + markdown writer
│   ├── diff.ts              # baseline diff with regression policy
│   └── cli-diff.ts          # CLI: bun run diff <a> <b>
├── fixtures/
│   ├── stash/               # ~15 seeded assets (stable refs)
│   ├── prompts/curation.jsonl       # gold set: prompt → expected refs
│   ├── tool-outputs/feedback.jsonl  # synthetic outputs for feedback metric
│   └── session-logs/        # per-fixture session buffers for memory metric
├── tier2/
│   ├── runner.ts            # orchestrator
│   ├── harness/{claude,opencode}.ts  # plugin invocation harnesses
│   ├── metrics/{surface,curation,latency,context-budget,feedback,memory}.ts
│   └── baseline/            # checked-in baseline JSON
└── tier3/
    ├── runner.ts            # scenario orchestrator + judge driver
    ├── ab.ts                # pairwise A/B with git worktree
    ├── scenarios.ts         # YAML loader + types
    ├── scenarios/*.yaml     # scenario definitions
    ├── harness/run-scenario.ts  # plugin-driving stub agent
    ├── judge/{client,rubric}.ts # Anthropic SDK + rubric
    └── README.md
```

## Adding a metric

1. Create `tier2/metrics/<name>.ts` exporting `run<Name>Metric(opts) -> MetricResult`.
2. Wire it into `tier2/runner.ts` under the `if (opts.metrics.has(...))` chain.
3. Add a regression rule (or several) to `lib/diff.ts` `DEFAULT_POLICY`
   so CI gates on it.
4. Add a script alias in `package.json` if the metric is useful in
   isolation.
5. Update the baseline: `bun run baseline:update`.

## Adding gold curation prompts

Append a JSONL line to `fixtures/prompts/curation.jsonl`:

```jsonl
{"id":"cur-NNN","prompt":"…","expected":["skill:foo","knowledge:bar"],"k":5}
```

Refs in `expected` must exist in `fixtures/stash/`. The fake-akm shim
ranks via the asset's `description` + `keywords` frontmatter, so adding
a new prompt usually means tweaking those fields too.

## What this framework does NOT measure

- The akm CLI's actual retrieval quality. The shim is held constant; if
  you want to evaluate a new akm-cli ranking algorithm, evaluate it in
  the akm-cli repo.
- A real Claude API agent driving the plugin end-to-end. Tier-3 uses a
  deterministic stub agent (the harness simulates the agent's reaction
  to curated context). A real-loop variant is a future enhancement —
  the transcript shape would stay the same.
- The `akm-curator` sub-agent's own performance. That would need a
  separate scenario class with longer multi-turn fixtures and a
  different rubric. Listed as future work in the design doc.
