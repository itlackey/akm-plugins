// Standalone CLI: `bun evals/lib/cli-diff.ts <baseline> <candidate>`
// Exits nonzero on regression so CI can gate on it.

import { writeFileSync } from "node:fs"
import path from "node:path"
import { diffReports, renderDiffMarkdown, loadReport } from "./diff"

function main() {
  const [baselinePath, candidatePath, outPath] = process.argv.slice(2)
  if (!baselinePath || !candidatePath) {
    console.error("Usage: bun evals/lib/cli-diff.ts <baseline.json> <candidate.json> [diff.md]")
    process.exit(64)
  }
  const baseline = loadReport(baselinePath)
  const candidate = loadReport(candidatePath)
  const summary = diffReports(baseline, candidate)
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
