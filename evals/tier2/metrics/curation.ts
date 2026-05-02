// Curation pipeline integrity metric.
//
// IMPORTANT — what this measures and what it does NOT:
//
// This metric does NOT measure the quality of akm's retrieval algorithm.
// The fake-akm shim ranks fixture assets via simple keyword matching;
// holding that ranker constant means metric deltas reflect PLUGIN
// behavior — truncation, scope filters, output parsing, ref preservation
// — not retrieval quality. To evaluate the akm CLI's retrieval, run a
// retrieval eval inside the akm-cli repo, not here.
//
// What we DO measure for each (prompt, expected refs) pair:
//
//   - expected_coverage: of the K refs the gold says SHOULD surface
//     for this prompt, how many actually made it into the injected
//     context after the plugin's curate-prompt hook ran? (Range 0-1.)
//     This is the right scale for the gold-set shape (most prompts
//     have 1-3 expected refs; precision@5 capped artificially.)
//   - top_rank_of_expected: what was the rank (1-indexed) of the
//     first gold ref to appear? Lower is better; 0 means none surfaced.
//   - extra_refs_returned: count of refs returned beyond the gold set
//     (unlabeled — could be relevant, could be noise; the metric just
//     surfaces the count so plugin changes that suddenly inflate or
//     drop the result set are visible).
//
// Aggregates reported:
//   - mean_expected_coverage: avg across the gold corpus
//   - mean_reciprocal_rank: avg of 1/(top_rank_of_expected) when found
//   - zero_hit_rate: fraction of prompts that returned no expected refs
//
// Diff thresholds gate on mean_expected_coverage, mean_reciprocal_rank,
// and zero_hit_rate. A 5% drop in expected_coverage or a 3% rise in
// zero_hit_rate fails the run — both are real plugin-side signals.

import { readFileSync } from "node:fs"
import path from "node:path"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook, parseInjectedRefs } from "../harness/claude"
import type { MetricResult } from "../../lib/report"

type GoldEntry = { id: string; prompt: string; expected: string[] }

export type CurationOptions = {
  goldPath: string
  stashDir: string
}

export function loadGold(goldPath: string): GoldEntry[] {
  const body = readFileSync(goldPath, "utf8")
  return body
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldEntry)
}

export type CurationPerEntry = {
  id: string
  prompt: string
  expected: string[]
  retrieved: string[]
  expected_coverage: number
  top_rank_of_expected: number  // 1-indexed; 0 = no gold ref found
  extra_refs_returned: number
}

export function runCurationMetric(opts: CurationOptions): MetricResult {
  const gold = loadGold(opts.goldPath)
  const perEntry: CurationPerEntry[] = []
  let coverageSum = 0
  let rrSum = 0
  let zeroHits = 0

  for (const entry of gold) {
    const sandbox = createSandbox({ sourceStash: opts.stashDir })
    try {
      const result = runClaudeHook(["curate-prompt"], {
        input: JSON.stringify({ session_id: `eval-${entry.id}`, prompt: entry.prompt }),
        env: sandbox.env,
      })
      const { refs } = parseInjectedRefs(result.stdout)
      const expectedSet = new Set(entry.expected)
      const matchedExpected = refs.filter((r) => expectedSet.has(r))
      const coverage = entry.expected.length === 0 ? 1 : matchedExpected.length / entry.expected.length
      let topRank = 0
      for (let i = 0; i < refs.length; i++) {
        if (expectedSet.has(refs[i])) {
          topRank = i + 1
          break
        }
      }
      const extra = refs.filter((r) => !expectedSet.has(r)).length
      perEntry.push({
        id: entry.id,
        prompt: entry.prompt,
        expected: entry.expected,
        retrieved: refs,
        expected_coverage: coverage,
        top_rank_of_expected: topRank,
        extra_refs_returned: extra,
      })
      coverageSum += coverage
      rrSum += topRank > 0 ? 1 / topRank : 0
      if (matchedExpected.length === 0) zeroHits++
    } finally {
      sandbox.cleanup()
    }
  }

  const n = gold.length || 1
  const meanCoverage = coverageSum / n
  const meanRR = rrSum / n
  const zeroHitRate = zeroHits / n

  // Worst-performing prompts surface in the markdown table.
  const worst = [...perEntry]
    .sort((a, b) => a.expected_coverage - b.expected_coverage || b.top_rank_of_expected - a.top_rank_of_expected)
    .slice(0, 5)
    .map((e) => [
      e.id,
      e.prompt.length > 60 ? e.prompt.slice(0, 57) + "..." : e.prompt,
      e.expected.join(","),
      e.retrieved.slice(0, 3).join(",") || "—",
      e.expected_coverage.toFixed(2),
      e.top_rank_of_expected || "—",
    ] as Array<string | number>)

  return {
    name: "curation",
    values: {
      n: gold.length,
      mean_expected_coverage: meanCoverage,
      mean_reciprocal_rank: meanRR,
      zero_hit_rate: zeroHitRate,
      per_entry: perEntry,
    },
    table: {
      headers: ["id", "prompt", "expected", "top-3 retrieved", "coverage", "top rank"],
      rows: worst,
    },
    notes: [
      `n=${gold.length} prompts. Worst 5 by coverage shown; full per-entry breakdown in metrics.curation.values.per_entry.`,
      `This metric measures plugin-pipeline integrity (did refs returned by akm survive the hook's processing?), NOT akm retrieval quality. The fake-akm shim is held constant.`,
    ],
  }
}
