// Tier-2 runner. Orchestrates the deterministic metrics and writes a
// machine-readable report + a markdown summary into eval-results/<ts>/.
//
// Usage:
//   bun evals/tier2/runner.ts                # all metrics
//   bun evals/tier2/runner.ts --metric curation
//   bun evals/tier2/runner.ts --out path/    # custom output dir
//   bun evals/tier2/runner.ts --baseline path/tier2.json  # diff vs baseline

import path from "node:path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { writeReport, type EvalReport } from "../lib/report"
import { runSurfaceMetric } from "./metrics/surface"
import { runCurationMetric } from "./metrics/curation"
import { runLatencyMetric } from "./metrics/latency"
import { diffReports, renderDiffMarkdown, loadReport } from "../lib/diff"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const EVALS_ROOT = path.resolve(import.meta.dir, "..")

type CliOptions = {
  metrics: Set<string>
  outDir: string
  baseline: string | null
  failOnRegression: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    metrics: new Set(["surface", "curation", "latency"]),
    outDir: "",
    baseline: null,
    failOnRegression: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--metric") {
      opts.metrics = new Set(argv[++i].split(","))
    } else if (a === "--out") {
      opts.outDir = argv[++i]
    } else if (a === "--baseline") {
      opts.baseline = argv[++i]
    } else if (a === "--no-fail") {
      opts.failOnRegression = false
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun evals/tier2/runner.ts [--metric a,b] [--out DIR] [--baseline FILE] [--no-fail]",
      )
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

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = opts.outDir || path.join(REPO_ROOT, "eval-results", ts)
  mkdirSync(outDir, { recursive: true })

  const stashDir = path.join(EVALS_ROOT, "fixtures/stash")
  const goldPath = path.join(EVALS_ROOT, "fixtures/prompts/curation.jsonl")

  const start = performance.now()
  const report: EvalReport = {
    version: "1",
    tier: "tier2",
    pluginVersion: getPluginVersion(),
    gitSha: getGitSha(),
    ranAt: new Date().toISOString(),
    durationMs: 0,
    metrics: {},
  }

  if (opts.metrics.has("surface")) {
    console.log("→ surface")
    report.metrics.surface = runSurfaceMetric(REPO_ROOT)
  }
  if (opts.metrics.has("curation")) {
    console.log("→ curation")
    report.metrics.curation = runCurationMetric({ goldPath, stashDir })
  }
  if (opts.metrics.has("latency")) {
    console.log("→ latency")
    // Use a small subset of the gold prompts so latency stays under a minute.
    const prompts = readFileSync(goldPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(0, 8)
      .map((l) => JSON.parse(l).prompt as string)
    report.metrics.latency = runLatencyMetric({ stashDir, prompts, iterations: 3 })
  }

  report.durationMs = Math.round(performance.now() - start)

  const { jsonPath, markdownPath } = writeReport(outDir, report)
  console.log(`\n✓ Wrote ${jsonPath}`)
  console.log(`✓ Wrote ${markdownPath}`)

  let exitCode = 0
  if (opts.baseline) {
    if (!existsSync(opts.baseline)) {
      console.error(`! Baseline not found: ${opts.baseline}`)
      exitCode = 2
    } else {
      const baseline = loadReport(opts.baseline)
      const summary = diffReports(baseline, report)
      summary.baselinePath = opts.baseline
      summary.candidatePath = jsonPath
      const diffMd = renderDiffMarkdown(summary)
      const diffPath = path.join(outDir, "diff.md")
      writeFileSync(diffPath, diffMd)
      console.log(`✓ Wrote ${diffPath}`)
      if (opts.failOnRegression && summary.regressionExitCode !== 0) {
        console.error(`! Regressions detected (${summary.regressions.length})`)
        exitCode = summary.regressionExitCode
      }
    }
  }

  process.exit(exitCode)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
