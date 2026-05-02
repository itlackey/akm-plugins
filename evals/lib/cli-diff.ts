// Standalone CLI: `bun evals/lib/cli-diff.ts <baseline> <candidate>`
// Exits nonzero on regression so CI can gate on it.

import { writeFileSync } from "node:fs"
import { diffReports, renderDiffMarkdown, loadReport, policyWithLatency, DEFAULT_POLICY } from "./diff"

function main() {
  const args = process.argv.slice(2)
  let includeLatency = false
  const positional: string[] = []
  for (const a of args) {
    if (a === "--include-latency") includeLatency = true
    else if (a === "--help" || a === "-h") {
      console.error("Usage: bun evals/lib/cli-diff.ts [--include-latency] <baseline.json> <candidate.json> [diff.md]")
      process.exit(0)
    } else positional.push(a)
  }
  const [baselinePath, candidatePath, outPath] = positional
  if (!baselinePath || !candidatePath) {
    console.error("Usage: bun evals/lib/cli-diff.ts [--include-latency] <baseline.json> <candidate.json> [diff.md]")
    process.exit(64)
  }
  const baseline = loadReport(baselinePath)
  const candidate = loadReport(candidatePath)
  const policy = includeLatency ? policyWithLatency(DEFAULT_POLICY) : DEFAULT_POLICY
  const summary = diffReports(baseline, candidate, policy)
  summary.baselinePath = baselinePath
  summary.candidatePath = candidatePath
  const md = renderDiffMarkdown(summary)
  if (outPath) {
    writeFileSync(outPath, md)
    console.log(`✓ Wrote ${outPath}`)
  } else {
    process.stdout.write(md)
  }
  if (summary.regressions.length > 0) {
    console.error(`\n! ${summary.regressions.length} regression(s)`)
  }
  const removals =
    (summary.surface?.removedTools.length ?? 0) +
    (summary.surface?.removedCommands.length ?? 0) +
    (summary.surface?.removedHooks.length ?? 0)
  if (removals > 0) {
    console.error(`! ${removals} surface removal(s)`)
  }
  process.exit(summary.regressionExitCode)
}

main()
