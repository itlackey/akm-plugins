// Pairwise A/B between two git refs.
//
// For each scenario × plugin, we run both refs (baseline = ref A, candidate = ref B),
// then ask the judge to pick the better transcript. Labels are shuffled to
// debias position effects. We run N=3 trials per pair and take the
// majority vote, with a Wilson confidence interval on the win-rate.
//
// Mechanics:
//   - We use a git worktree (`git worktree add`) to materialize each ref
//     in an isolated directory. The harness runs against THAT directory's
//     plugin source AND fixtures (claude/hooks/akm-hook.sh,
//     opencode/index.ts, evals/fixtures/...).
//   - This means a fixture change between the two refs WILL show up in
//     the A/B. If you want plugin-only deltas, pin the candidate's
//     fixture commit onto the baseline ref before running.
//   - The scenario LIST comes from the current workspace (so both refs
//     get the same scenario set even if one ref doesn't have a YAML).
//     But each scenario is run by the worktree's harness against the
//     worktree's fixtures — so the gold-set drift caveat above applies.
//
// Usage:
//   bun tier3/ab.ts main HEAD                       # baseline=main, candidate=HEAD
//   bun tier3/ab.ts v0.5.0 v0.6.0 --scenarios curate-*
//   bun tier3/ab.ts --baseline main --candidate HEAD --trials 3 --budget 10

import path from "node:path"
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { writeReport, type EvalReport, type MetricResult } from "../lib/report"
import { loadScenarios, type Scenario, type ScenarioPlugin } from "./scenarios"
import { runScenario, type ScenarioRun } from "./harness/run-scenario"
import { Judge } from "./judge/client"
import Anthropic from "@anthropic-ai/sdk"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const EVALS_ROOT = path.resolve(import.meta.dir, "..")

type CliOptions = {
  baselineRef: string
  candidateRef: string
  scenarioGlob?: string
  pluginFilter?: ScenarioPlugin
  trials: number
  budget: number
  outDir: string
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = []
  const opts: Partial<CliOptions> = { trials: 3, budget: 10 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--baseline") opts.baselineRef = argv[++i]
    else if (a === "--candidate") opts.candidateRef = argv[++i]
    else if (a === "--scenarios") opts.scenarioGlob = argv[++i]
    else if (a === "--plugin") opts.pluginFilter = argv[++i] as ScenarioPlugin
    else if (a === "--trials") opts.trials = parseInt(argv[++i], 10)
    else if (a === "--budget") opts.budget = parseFloat(argv[++i])
    else if (a === "--out") opts.outDir = argv[++i]
    else if (a === "--help" || a === "-h") {
      console.log("Usage: bun tier3/ab.ts <baseline> <candidate> [--scenarios GLOB] [--plugin claude|opencode] [--trials N] [--budget USD]")
      process.exit(0)
    } else if (!a.startsWith("--")) positional.push(a)
  }
  const baselineRef = opts.baselineRef ?? positional[0]
  const candidateRef = opts.candidateRef ?? positional[1]
  if (!baselineRef || !candidateRef) {
    console.error("Usage: bun tier3/ab.ts <baseline> <candidate> [...]")
    process.exit(64)
  }
  return {
    baselineRef,
    candidateRef,
    scenarioGlob: opts.scenarioGlob,
    pluginFilter: opts.pluginFilter,
    trials: opts.trials ?? 3,
    budget: opts.budget ?? 10,
    outDir: opts.outDir ?? "",
  } as CliOptions
}

type Worktree = { root: string; cleanup: () => void }

function addWorktree(ref: string): Worktree {
  const dir = mkdtempSync(path.join(tmpdir(), `akm-ab-${ref.replace(/[^A-Za-z0-9.-]/g, "_")}-`))
  const r = Bun.spawnSync(["git", "worktree", "add", "--detach", dir, ref], { cwd: REPO_ROOT })
  if (r.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`git worktree add failed for ${ref}: ${r.stderr.toString()}`)
  }
  return {
    root: dir,
    cleanup() {
      Bun.spawnSync(["git", "worktree", "remove", "--force", dir], { cwd: REPO_ROOT })
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

// We re-import the harness from the worktree's evals/ so the harness
// references the worktree's plugin source. Bun caches imports by URL, so
// each worktree gets a fresh module graph keyed on its absolute path.
async function loadHarnessForWorktree(worktreeRoot: string) {
  // Force a fresh import of the worktree's harness/run-scenario.ts. Bun
  // caches by absolute URL; each worktree path is a unique URL.
  const modulePath = path.join(worktreeRoot, "evals/tier3/harness/run-scenario.ts")
  if (!existsSync(modulePath)) {
    throw new Error(
      `Worktree ${worktreeRoot} doesn't contain evals/tier3/harness/run-scenario.ts. ` +
        `The A/B tool requires both refs to ship the eval framework.`,
    )
  }
  return await import(modulePath) as { runScenario: typeof runScenario }
}

type PairwiseResult = {
  scenarioId: string
  plugin: ScenarioPlugin
  trials: Array<{ winner: "A" | "B" | "tie"; reasoning: string; aLabel: "baseline" | "candidate"; bLabel: "baseline" | "candidate"; costUsd: number }>
  // After mapping back from shuffled labels:
  baselineWins: number
  candidateWins: number
  ties: number
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// Wilson score interval at 95% confidence for a binomial proportion.
// Ties are folded into the denominator as 0.5-of-each: if the judge
// genuinely can't pick, that's information about the candidate's
// strength, not a sample to discard. With 3 trials and 1 tie, the old
// code computed a CI over n=2 which was meaningless; this gives a
// stable n=3 estimate.
function wilsonInterval(candidateWins: number, baselineWins: number, ties: number): { lower: number; upper: number; point: number; n: number } {
  const n = candidateWins + baselineWins + ties
  if (n === 0) return { lower: 0, upper: 0, point: 0, n: 0 }
  const z = 1.96
  const p = (candidateWins + ties / 2) / n
  const denom = 1 + (z * z) / n
  const center = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return {
    point: p,
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
    n,
  }
}

const PAIRWISE_SCHEMA = {
  type: "object",
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    reasoning: { type: "string", maxLength: 200 },
  },
  required: ["winner", "reasoning"],
}

const PAIRWISE_SYSTEM = `You are an objective evaluator comparing two transcripts of an agent attempting the same task.

You will see:
1. The scenario goal and expectations.
2. Transcript A and Transcript B (labels are shuffled — neither is identifiably "better").

Pick the transcript that better fulfilled the scenario expectations on these axes (in order of importance):
- Asset use: did the agent surface and use the must-curate refs?
- Feedback loop: did it record feedback when warranted?
- On task: did it complete the user goal?
- No leaks: forbidden refs absent; no vault values surfaced.
- Conciseness: less injected context for equivalent quality is better.

Reply via the pick_winner tool. Only call "tie" if you genuinely cannot distinguish — be willing to commit a preference. Justification ≤200 chars; reference concrete behaviors.`

async function judgePair(
  client: Anthropic,
  scenario: Scenario,
  runA: ScenarioRun,
  runB: ScenarioRun,
): Promise<{ winner: "A" | "B" | "tie"; reasoning: string; costUsd: number }> {
  // Render compact transcripts
  const renderRun = (label: string, run: ScenarioRun) => {
    const lines: string[] = [`# Transcript ${label}`, `injected_chars=${run.injectedContextChars} curated_refs=[${run.curatedRefs.join(",")}] feedback_emitted=${JSON.stringify(run.feedbackEmitted)}`]
    for (const t of run.transcript) {
      if (t.type === "user") lines.push(`USER: ${t.content}`)
      else if (t.type === "injected_context") lines.push(`INJECTED (chars=${t.chars}, refs=[${t.refs.join(",")}])`)
      else if (t.type === "tool_use") lines.push(`TOOL_USE: ${t.tool} ${t.ref ?? ""}`)
      else if (t.type === "tool_result") lines.push(`TOOL_RESULT: ${t.tool} ok=${t.ok}`)
      else if (t.type === "feedback") lines.push(`FEEDBACK: ${t.ref} ${t.sentiment}`)
      else if (t.type === "agent_summary") lines.push(`AGENT: ${t.text}`)
    }
    if (run.error) lines.push(`ERROR: ${run.error}`)
    return lines.join("\n")
  }
  const userPrompt = [
    `Scenario: ${scenario.id}`,
    `Description: ${scenario.description}`,
    `Expectations: ${JSON.stringify(scenario.expectations)}`,
    "",
    renderRun("A", runA),
    "",
    renderRun("B", runB),
    "",
    "Use pick_winner.",
  ].join("\n")

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    // No cache_control: system prompt is well below Sonnet 4.6's
    // 2048-token cacheable minimum — the marker silently never fires.
    system: PAIRWISE_SYSTEM,
    tools: [{ name: "pick_winner", description: "Record which transcript better fulfilled the scenario.", input_schema: PAIRWISE_SCHEMA as Anthropic.Tool["input_schema"] }],
    tool_choice: { type: "tool", name: "pick_winner" },
    messages: [{ role: "user", content: userPrompt }],
  })
  const tool = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
  if (!tool) throw new Error("Pairwise judge returned no tool_use")
  const input = tool.input as { winner: "A" | "B" | "tie"; reasoning: string }
  // Pricing (Sonnet 4.6): inp $3/M, out $15/M, cache read $0.30/M, cache write $3.75/M
  const u = response.usage
  const cost =
    (u.input_tokens ?? 0) / 1e6 * 3.0 +
    (u.output_tokens ?? 0) / 1e6 * 15.0 +
    (u.cache_read_input_tokens ?? 0) / 1e6 * 0.30 +
    (u.cache_creation_input_tokens ?? 0) / 1e6 * 3.75
  return { winner: input.winner, reasoning: input.reasoning, costUsd: cost }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("! ANTHROPIC_API_KEY not set; A/B requires the judge.")
    process.exit(2)
  }
  const opts = parseArgs(process.argv.slice(2))
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = opts.outDir || path.join(REPO_ROOT, "eval-results", `ab-${opts.baselineRef}-vs-${opts.candidateRef}-${ts}`.replace(/[^A-Za-z0-9.\/-]/g, "_"))
  mkdirSync(outDir, { recursive: true })

  const scenarios = loadScenarios(path.join(EVALS_ROOT, "tier3/scenarios"), opts.scenarioGlob)
  if (scenarios.length === 0) {
    console.error("! No scenarios match")
    process.exit(1)
  }

  console.log(`A/B: ${opts.baselineRef} vs ${opts.candidateRef} — ${scenarios.length} scenarios × ${opts.trials} trials`)
  const baselineWt = addWorktree(opts.baselineRef)
  const candidateWt = addWorktree(opts.candidateRef)

  let totalCost = 0
  const pairResults: PairwiseResult[] = []

  try {
    const baselineHarness = await loadHarnessForWorktree(baselineWt.root)
    const candidateHarness = await loadHarnessForWorktree(candidateWt.root)
    const client = new Anthropic()

    for (const scenario of scenarios) {
      const plugins = opts.pluginFilter ? [opts.pluginFilter] : scenario.plugins
      for (const plugin of plugins) {
        console.log(`→ ${scenario.id} [${plugin}]`)
        const result: PairwiseResult = {
          scenarioId: scenario.id,
          plugin,
          trials: [],
          baselineWins: 0,
          candidateWins: 0,
          ties: 0,
        }
        // Run each side once per pair (cheap; can be cached); shuffle labels per trial.
        const baselineRun = await baselineHarness.runScenario(scenario, plugin)
        const candidateRun = await candidateHarness.runScenario(scenario, plugin)
        for (let trial = 0; trial < opts.trials; trial++) {
          const order = shuffle(["baseline", "candidate"]) as ["baseline" | "candidate", "baseline" | "candidate"]
          const aRun = order[0] === "baseline" ? baselineRun : candidateRun
          const bRun = order[1] === "baseline" ? baselineRun : candidateRun
          if (totalCost >= opts.budget) {
            console.error(`  ! budget reached ($${totalCost.toFixed(4)} / $${opts.budget.toFixed(4)}) — aborting`)
            trial = opts.trials
            break
          }
          const { winner, reasoning, costUsd } = await judgePair(client, scenario, aRun, bRun)
          totalCost += costUsd
          // Map shuffled label back to baseline/candidate.
          const realWinner =
            winner === "tie" ? "tie" : winner === "A" ? order[0] : order[1]
          if (realWinner === "baseline") result.baselineWins++
          else if (realWinner === "candidate") result.candidateWins++
          else result.ties++
          result.trials.push({ winner, reasoning, aLabel: order[0], bLabel: order[1], costUsd })
        }
        const candidateInterval = wilsonInterval(result.candidateWins, result.baselineWins, result.ties)
        console.log(`  baseline=${result.baselineWins} candidate=${result.candidateWins} ties=${result.ties} candidate_winrate=${(candidateInterval.point * 100).toFixed(0)}% [${(candidateInterval.lower * 100).toFixed(0)}-${(candidateInterval.upper * 100).toFixed(0)}%]`)
        pairResults.push(result)
      }
    }
  } finally {
    baselineWt.cleanup()
    candidateWt.cleanup()
  }

  const totalBaseline = pairResults.reduce((a, p) => a + p.baselineWins, 0)
  const totalCandidate = pairResults.reduce((a, p) => a + p.candidateWins, 0)
  const totalTies = pairResults.reduce((a, p) => a + p.ties, 0)
  const overallWinrate = wilsonInterval(totalCandidate, totalBaseline, totalTies)

  const report: EvalReport = {
    version: "1",
    tier: "tier3",
    pluginVersion: "ab",
    gitSha: `${opts.baselineRef}..${opts.candidateRef}`,
    ranAt: new Date().toISOString(),
    durationMs: 0,
    metrics: {
      ab: {
        name: "ab",
        values: {
          baseline_ref: opts.baselineRef,
          candidate_ref: opts.candidateRef,
          trials_per_pair: opts.trials,
          baseline_wins: totalBaseline,
          candidate_wins: totalCandidate,
          ties: totalTies,
          candidate_winrate: overallWinrate.point,
          candidate_winrate_lower_95: overallWinrate.lower,
          candidate_winrate_upper_95: overallWinrate.upper,
          per_pair: pairResults.map((p) => ({
            scenario: p.scenarioId,
            plugin: p.plugin,
            baseline_wins: p.baselineWins,
            candidate_wins: p.candidateWins,
            ties: p.ties,
            sample_reasoning: p.trials[0]?.reasoning ?? null,
          })),
        },
        table: {
          headers: ["scenario", "plugin", "baseline wins", "candidate wins", "ties", "first-trial reasoning"],
          rows: pairResults.map((p) => [
            p.scenarioId,
            p.plugin,
            p.baselineWins,
            p.candidateWins,
            p.ties,
            (p.trials[0]?.reasoning ?? "").slice(0, 80),
          ]),
        },
        notes: [
          `Candidate (${opts.candidateRef}) win-rate: ${(overallWinrate.point * 100).toFixed(1)}% [${(overallWinrate.lower * 100).toFixed(1)}-${(overallWinrate.upper * 100).toFixed(1)}%] (Wilson 95% CI, ties counted as 0.5 each, n=${overallWinrate.n}).`,
          `Total judge cost: $${totalCost.toFixed(4)}.`,
        ],
      } as MetricResult,
    },
  }
  const { jsonPath, markdownPath } = writeReport(outDir, report)
  console.log(`\n✓ Wrote ${jsonPath}`)
  console.log(`✓ Wrote ${markdownPath}`)
  console.log(`Total cost: $${totalCost.toFixed(4)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
