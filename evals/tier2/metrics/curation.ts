// Curation quality metric for the Claude UserPromptSubmit hook.
//
// For each (prompt → expected refs) pair, we run the curate-prompt hook
// in a sandbox with a deterministic fake `akm` ranked against the fixture
// stash, parse the refs the hook injects into `additionalContext`, and
// compute precision@K, recall@K, and MRR.
//
// The fake-akm holds the retrieval algorithm constant so the metric
// reflects PLUGIN behavior (truncation, scope filters, formatting), not
// akm-cli changes. A separate contract test in tier-2 (future work)
// exercises the real akm CLI to catch shim drift.

import { readFileSync } from "node:fs"
import path from "node:path"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook, parseInjectedRefs } from "../harness/claude"
import type { MetricResult } from "../../lib/report"

type GoldEntry = { id: string; prompt: string; expected: string[]; k?: number }

export type CurationOptions = {
  goldPath: string
  stashDir: string
  defaultK?: number
}

export function loadGold(goldPath: string): GoldEntry[] {
  const body = readFileSync(goldPath, "utf8")
  return body
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldEntry)
}

function precisionAtK(retrieved: string[], expected: Set<string>, k: number): number {
  const slice = retrieved.slice(0, k)
  if (slice.length === 0) return 0
  let hits = 0
  for (const r of slice) if (expected.has(r)) hits++
  return hits / slice.length
}

function recallAtK(retrieved: string[], expected: Set<string>, k: number): number {
  if (expected.size === 0) return 1
  const slice = retrieved.slice(0, k)
  let hits = 0
  for (const r of slice) if (expected.has(r)) hits++
  return hits / expected.size
}

function reciprocalRank(retrieved: string[], expected: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (expected.has(retrieved[i])) return 1 / (i + 1)
  }
  return 0
}

export type CurationPerEntry = {
  id: string
  prompt: string
  expected: string[]
  retrieved: string[]
  pAtK: number
  rAtK: number
  rr: number
  k: number
}

export function runCurationMetric(opts: CurationOptions): MetricResult {
  const gold = loadGold(opts.goldPath)
  const k = opts.defaultK ?? 5
  const perEntry: CurationPerEntry[] = []
  let pSum = 0
  let rSum = 0
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
      const expected = new Set(entry.expected)
      const ek = entry.k ?? k
      const p = precisionAtK(refs, expected, ek)
      const r = recallAtK(refs, expected, ek)
      const rr = reciprocalRank(refs, expected)
      perEntry.push({
        id: entry.id,
        prompt: entry.prompt,
        expected: entry.expected,
        retrieved: refs,
        pAtK: p,
        rAtK: r,
        rr,
        k: ek,
      })
      pSum += p
      rSum += r
      rrSum += rr
      if (refs.length === 0) zeroHits++
    } finally {
      sandbox.cleanup()
    }
  }

  const n = gold.length || 1
  const pAt5 = pSum / n
  const rAt5 = rSum / n
  const mrr = rrSum / n

  // Worst-performing prompts surface in the markdown table so authors can
  // see exactly which queries regressed.
  const worst = [...perEntry]
    .sort((a, b) => a.rr - b.rr)
    .slice(0, 5)
    .map((e) => [e.id, e.prompt.length > 60 ? e.prompt.slice(0, 57) + "..." : e.prompt, e.expected.join(","), e.retrieved.slice(0, 3).join(",") || "—", e.pAtK.toFixed(2), e.rAtK.toFixed(2), e.rr.toFixed(2)] as Array<string | number>)

  return {
    name: "curation",
    values: {
      n: gold.length,
      p_at_5: pAt5,
      r_at_5: rAt5,
      mrr,
      zero_hit_rate: zeroHits / n,
      per_entry: perEntry,
    },
    table: {
      headers: ["id", "prompt", "expected", "top-3 retrieved", "p@k", "r@k", "rr"],
      rows: worst,
    },
    notes: [
      `n=${gold.length} prompts, k=${k}. Worst 5 entries shown below; full per-entry breakdown is in the JSON report under \`metrics.curation.values.per_entry\`.`,
    ],
  }
}
