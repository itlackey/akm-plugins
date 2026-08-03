# AKM plugin evaluation framework

Measures the **effectiveness** of the Claude Code and OpenCode plugins
in this repo so plugin authors can quantify whether a change helps or
regresses the user experience. Complements the existing correctness
tests under `tests/`.

## Why a separate framework?

`tests/` answers "does the hook still parse stdin and emit valid JSON?".
This framework answers different questions:

- **Did this change drop refs from the curation pipeline?**
  (`mean_expected_coverage` against a gold set of prompt → expected-refs
  pairs — note: holds the akm CLI ranker constant via a fake; this
  measures the plugin's pipeline, not akm's retrieval quality)
- **Did it break the auto-feedback path on either plugin?**
  (precision/recall over actual `akm feedback` calls in the call log,
  measured symmetrically on both Claude and OpenCode)
- **Did it slow the hook down on the user's prompt path?** (p50/p95/p99
  per hook verb — observation only; not gated in CI because latency is
  hardware-dependent)
- **Did it remove or rename a public surface element?** (tool, command,
  hook diff vs a checked-in baseline)

Reports are JSON + markdown so two runs can be cleanly diffed.

### What this framework does NOT measure

- **akm CLI retrieval quality.** The fake-akm shim is held constant; if
  you want to evaluate a new akm-cli ranking algorithm, evaluate it in
  the akm-cli repo. Tier-2 curation deltas reflect plugin behavior
  (truncation, scope filters, parsing) — NOT retrieval.
- **Hook latency in CI.** Latency baselines are environment-dependent
  (dev machine vs GitHub runner can differ 2-5x); CI doesn't gate on
  latency. Use `--include-latency` against a baseline regenerated on
  the same hardware to compare apples-to-apples.

## Tiers

| Tier | What | When | Cost |
|---|---|---|---|
| 1 — correctness | Existing `tests/` (Bun) | every PR | free |
| 2 — deterministic effectiveness | this framework, no LLM | every PR | seconds |
| 3 — LLM-in-the-loop scenarios | Claude judge, scenario YAMLs | manual / `workflow_dispatch` | dollars |

Tier 2 ships five metrics: `surface`, `curation`, `latency`,
`context_budget`, and `feedback`. Tier 3 ships a YAML
scenario format, an Anthropic SDK judge, and
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

# diff a candidate run against the checked-in baseline
bun run diff tier2/baseline/tier2.json ../eval-results/<ts>/tier2.json

# tier-3 (requires ANTHROPIC_API_KEY for the real agent + judge)
bun run tier3 -- --no-judge --agent stub    # smoke test, no API spend
bun run tier3                               # real agent + judge (recommended)
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
   isolated `$AKM_BUNDLE_DIR`, `$AKM_PLUGIN_STATE_DIR`, `$XDG_*` so the
   hook never touches the user's real stash.
2. Installs a deterministic fake `akm` binary on `$PATH` via
   `lib/fake-akm.ts`. The shim ranks fixture assets with simple keyword
   matching so retrieval is held constant — metric deltas reflect plugin
   behavior, not akm-cli changes.
3. Invokes `claude/hooks/akm-hook.ts` directly through `Bun.spawnSync`
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
│   └── tool-outputs/feedback.jsonl  # synthetic outputs for feedback metric
├── tier2/
│   ├── runner.ts            # orchestrator
│   ├── harness/{claude,opencode}.ts  # plugin invocation harnesses
│   ├── metrics/{surface,curation,latency,context-budget,feedback}.ts
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
{"id":"cur-NNN","prompt":"…","expected":["skills/foo","knowledge/bar.md"],"k":5}
```

Refs in `expected` must exist in `fixtures/stash/`. The fake-akm shim
ranks via the asset's `description` + `keywords` frontmatter, so adding
a new prompt usually means tweaking those fields too.

## What this framework does NOT measure

- The akm CLI's actual retrieval quality. The shim is held constant; if
  you want to evaluate a new akm-cli ranking algorithm, evaluate it in
  the akm-cli repo.
- Free/offline tier-3 runs. Tier-3 runs a real Claude agent loop by
  default when `ANTHROPIC_API_KEY` is set (`--agent stub` forces the
  deterministic stub agent for free harness validation, but judge
  scores from stub runs are smoke-test signal only, not effectiveness
  measurements).
- The `akm-curator` sub-agent's own performance. That would need a
  separate scenario class with longer multi-turn fixtures and a
  different rubric. Listed as future work in the design doc.
