// Tier-3 runner. Loads scenarios, runs each through the configured
// plugins, judges with Claude Sonnet 4.6, and writes a structured report.
//
// Usage:
//   bun tier3/runner.ts                              # all scenarios, both plugins
//   bun tier3/runner.ts --scenarios curate-skill-*   # filter by id glob
//   bun tier3/runner.ts --plugin claude              # single plugin
//   bun tier3/runner.ts --budget 5                   # $ cap on judge spend
//   bun tier3/runner.ts --no-judge                   # run scenarios but skip judging
//                                                    # (useful for harness validation w/o API key)
//   bun tier3/runner.ts --out path/                  # custom output dir
//
// Requires ANTHROPIC_API_KEY in the environment unless --no-judge.

import path from "node:path"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { writeReport, type EvalReport, type MetricResult } from "../lib/report"
import { loadScenarios, type Scenario, type ScenarioPlugin } from "./scenarios"
import { runScenario, type ScenarioRun } from "./harness/run-scenario"
import { Judge, type JudgeVerdict } from "./judge/client"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const EVALS_ROOT = path.resolve(import.meta.dir, "..")

type CliOptions = {
  scenarioGlob?: string
  pluginFilter?: ScenarioPlugin
  budget: number
  outDir: string
  noJudge: boolean
  agentMode?: "real" | "stub"
  agentBudget: number
  agentModel?: string
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    scenarioGlob: undefined,
    pluginFilter: undefined,
    budget: 5,
    outDir: "",
    noJudge: false,
    agentBudget: 0.50,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--scenarios") opts.scenarioGlob = argv[++i]
    else if (a === "--plugin") opts.pluginFilter = argv[++i] as ScenarioPlugin
    else if (a === "--budget") opts.budget = parseFloat(argv[++i])
    else if (a === "--agent-budget") opts.agentBudget = parseFloat(argv[++i])
    else if (a === "--agent") opts.agentMode = argv[++i] as "real" | "stub"
    else if (a === "--agent-model") opts.agentModel = argv[++i]
    else if (a === "--out") opts.outDir = argv[++i]
    else if (a === "--no-judge") opts.noJudge = true
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun tier3/runner.ts [options]
  --scenarios GLOB       Filter scenarios by id (e.g. "curate-skill-*")
  --plugin claude|opencode  Run only one plugin
  --agent real|stub      Force agent mode (default: real if API key, stub otherwise)
  --agent-model MODEL    Override agent model (default: claude-sonnet-4-6)
  --agent-budget USD     Per-scenario agent budget cap (default: 0.50)
  --budget USD           Judge budget cap across the run (default: 5)
  --out DIR              Custom output dir
  --no-judge             Skip judging (free; useful with --agent stub for harness validation)`)
      process.exit(0)
    }
  }
  return opts
}

function getGitSha(): string | null {
  try {
    const out = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT })
    if (out.exitCode === 0) return out.stdout.toString().trim()
  } catch {}
  return null
}

function getPluginVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "claude/package.json"), "utf8"))
    return pkg.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

type ScenarioOutcome = {
  scenarioId: string
  plugin: ScenarioPlugin
  run: ScenarioRun
  verdict: JudgeVerdict | null
  weight: number
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const wantsRealAgent = opts.agentMode === "real" || (!opts.agentMode && process.env.ANTHROPIC_API_KEY)
  const needsKey = !opts.noJudge || wantsRealAgent
  if (needsKey && !process.env.ANTHROPIC_API_KEY) {
    console.error("! ANTHROPIC_API_KEY not set.")
    console.error("  Pass --no-judge --agent stub to validate the harness end-to-end without API access,")
    console.error("  or export ANTHROPIC_API_KEY to enable the real agent + judge.")
    process.exit(2)
  }
  if (opts.agentMode === "stub" || (!opts.agentMode && !process.env.ANTHROPIC_API_KEY)) {
    console.warn("! Running with stub agent — transcripts are mechanical projections of expectations.")
    console.warn("  Judge scores from stub runs are smoke-test signal only, not effectiveness measurements.")
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = opts.outDir || path.join(REPO_ROOT, "eval-results", `tier3-${ts}`)
  mkdirSync(outDir, { recursive: true })

  const scenariosDir = path.join(EVALS_ROOT, "tier3/scenarios")
  const scenarios = loadScenarios(scenariosDir, opts.scenarioGlob)
  if (scenarios.length === 0) {
    console.error(`! No scenarios match glob "${opts.scenarioGlob ?? "*"}" in ${scenariosDir}`)
    process.exit(1)
  }

  const cacheDir = path.join(EVALS_ROOT, "tier3/.verdict-cache")
  const judge = opts.noJudge ? null : new Judge({ budgetUsd: opts.budget, cacheDir })

  const start = performance.now()
  const outcomes: ScenarioOutcome[] = []

  for (const scenario of scenarios) {
    const plugins = opts.pluginFilter ? [opts.pluginFilter] : scenario.plugins
    for (const plugin of plugins) {
      console.log(`→ ${scenario.id} [${plugin}]`)
      const run = await runScenario(scenario, plugin, {
        agentMode: opts.agentMode,
        agentBudgetUsd: opts.agentBudget,
        agentModel: opts.agentModel,
      })
      if (run.agentMode === "real") {
        console.log(`  agent: turns=${run.agentTurns ?? 0} stop=${run.agentStopReason} cost=$${(run.agentCostUsd ?? 0).toFixed(4)}`)
      }
      let verdict: JudgeVerdict | null = null
      if (judge) {
        try {
          verdict = await judge.score(scenario, run)
          console.log(`  ✓ verdict overall=${verdict.scores.overall}/3 cost=$${verdict.costUsd.toFixed(4)} ${verdict.cached ? "(cached)" : ""}`)
        } catch (err) {
          console.error(`  ! judge failed: ${(err as Error).message}`)
        }
      }
      outcomes.push({ scenarioId: scenario.id, plugin, run, verdict, weight: scenario.weight ?? 1 })
    }
  }

  const durationMs = Math.round(performance.now() - start)

  // Aggregate scores per plugin: weighted-average overall + per-dimension means.
  const plugins: ScenarioPlugin[] = ["claude", "opencode"]
  const aggregate: Record<string, Record<string, number>> = {}
  for (const plugin of plugins) {
    const verdicts = outcomes
      .filter((o) => o.plugin === plugin && o.verdict)
      .map((o) => ({ verdict: o.verdict!, weight: o.weight }))
    if (verdicts.length === 0) continue
    const totalWeight = verdicts.reduce((a, v) => a + v.weight, 0) || 1
    const wmean = (key: keyof JudgeVerdict["scores"]) =>
      verdicts.reduce((a, v) => a + (v.verdict.scores[key] as number) * v.weight, 0) / totalWeight
    aggregate[plugin] = {
      n: verdicts.length,
      asset_use: wmean("asset_use"),
      on_task: wmean("on_task"),
      feedback_loop: wmean("feedback_loop"),
      hallucination: wmean("hallucination"),
      conciseness: wmean("conciseness"),
      overall: wmean("overall"),
    }
  }

  const totalJudgeCost = outcomes.reduce((a, o) => a + (o.verdict?.costUsd ?? 0), 0)
  const totalAgentCost = outcomes.reduce((a, o) => a + (o.run.agentCostUsd ?? 0), 0)
  const totalInputTokens = outcomes.reduce((a, o) => a + (o.verdict?.inputTokens ?? 0), 0)
  const totalOutputTokens = outcomes.reduce((a, o) => a + (o.verdict?.outputTokens ?? 0), 0)
  const totalHookInjectedChars = outcomes.reduce((a, o) => a + o.run.injectedContextChars, 0)
  const agentModes = [...new Set(outcomes.map((o) => o.run.agentMode))]
  const realAgentRuns = outcomes.filter((o) => o.run.agentMode === "real").length
  const stubAgentRuns = outcomes.filter((o) => o.run.agentMode === "stub").length

  const report: EvalReport = {
    version: "1",
    tier: "tier3",
    pluginVersion: getPluginVersion(),
    gitSha: getGitSha(),
    ranAt: new Date().toISOString(),
    durationMs,
    metrics: {
      scores: {
        name: "scores",
        values: {
          agent_modes: agentModes,
          real_agent_runs: realAgentRuns,
          stub_agent_runs: stubAgentRuns,
          aggregate,
          per_scenario: outcomes.map((o) => ({
            id: o.scenarioId,
            plugin: o.plugin,
            agent_mode: o.run.agentMode,
            scores: o.verdict?.scores ?? null,
            error: o.run.error,
            curated_refs: o.run.curatedRefs,
            feedback_emitted: o.run.feedbackEmitted,
          })),
        },
        table: {
          headers: ["plugin", "n", "asset_use", "on_task", "feedback_loop", "hallucination", "conciseness", "overall"],
          rows: Object.entries(aggregate).map(([plugin, a]) => [
            plugin,
            a.n,
            a.asset_use.toFixed(2),
            a.on_task.toFixed(2),
            a.feedback_loop.toFixed(2),
            a.hallucination.toFixed(2),
            a.conciseness.toFixed(2),
            a.overall.toFixed(2),
          ]),
        },
        notes: [
          opts.noJudge
            ? "Judge skipped (--no-judge). Scenarios were run but not scored."
            : `Judge: claude-sonnet-4-6, structured output via tool-use forcing. Verdicts cached on (scenario, plugin, sha256(transcript)).`,
          stubAgentRuns > 0
            ? `WARNING: ${stubAgentRuns}/${outcomes.length} runs used the stub agent. These transcripts are mechanical projections of the scenario expectations — the judge has nothing to disagree with, so scores from stub runs are smoke-test signal only, not effectiveness measurements.`
            : "All runs used the real Claude agent loop.",
        ],
      } as MetricResult,
      cost: {
        name: "cost",
        values: {
          judge_usd: totalJudgeCost,
          agent_usd: totalAgentCost,
          total_usd: totalJudgeCost + totalAgentCost,
          budget_usd: opts.budget,
          per_agent_budget_usd: opts.agentBudget,
          judge_input_tokens: totalInputTokens,
          judge_output_tokens: totalOutputTokens,
          hook_injected_chars: totalHookInjectedChars,
          n_runs: outcomes.length,
          n_judged: outcomes.filter((o) => o.verdict).length,
          n_real_agent: realAgentRuns,
          n_stub_agent: stubAgentRuns,
        },
        table: {
          headers: ["metric", "value"],
          rows: [
            ["judge_usd", `$${totalJudgeCost.toFixed(4)}`],
            ["agent_usd", `$${totalAgentCost.toFixed(4)}`],
            ["total_usd", `$${(totalJudgeCost + totalAgentCost).toFixed(4)}`],
            ["budget_usd", `$${opts.budget.toFixed(4)}`],
            ["judge_input_tokens", totalInputTokens],
            ["judge_output_tokens", totalOutputTokens],
            ["hook_injected_chars", totalHookInjectedChars],
            ["n_real_agent", realAgentRuns],
            ["n_stub_agent", stubAgentRuns],
          ],
        },
      } as MetricResult,
    },
  }

  const { jsonPath, markdownPath } = writeReport(outDir, report)
  console.log(`\n✓ Wrote ${jsonPath}`)
  console.log(`✓ Wrote ${markdownPath}`)
  console.log(`\nAgent runs: ${realAgentRuns} real, ${stubAgentRuns} stub`)
  if (!opts.noJudge) {
    console.log(`Total spend: agent $${totalAgentCost.toFixed(4)} + judge $${totalJudgeCost.toFixed(4)} = $${(totalJudgeCost + totalAgentCost).toFixed(4)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
