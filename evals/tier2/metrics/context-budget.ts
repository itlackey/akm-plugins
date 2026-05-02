// Context budget compliance metric.
//
// Both plugins enforce AKM_CONTEXT_BUDGET_CHARS (default 4000) on the
// curated assets they inject — Claude via the curate-prompt hook, OpenCode
// via experimental.chat.system.transform. We measure:
//   - violations: prompts where the injected context exceeded the budget
//   - avg_chars / max_chars: distributional stats
//   - drop_rate: how often refs are dropped due to truncation, comparing
//     the refs the fake-akm produced vs refs that survived in the
//     injected context.

import path from "node:path"
import { readFileSync } from "node:fs"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook, parseInjectedRefs } from "../harness/claude"
import { createOpenCodeHarness, parseRefs } from "../harness/opencode"
import { installFakeAkm, loadFixtureStash } from "../../lib/fake-akm"
import type { MetricResult } from "../../lib/report"

const EVALS_ROOT = path.resolve(import.meta.dir, "../..")

export type ContextBudgetOptions = {
  goldPath: string
  stashDir: string
  budget?: number
  // Cap on how many gold prompts to use (keeps OpenCode runtime down,
  // since opencode-harness imports the full plugin).
  maxPrompts?: number
}

type Sample = {
  id: string
  plugin: "claude" | "opencode"
  budget: number
  chars: number
  injectedRefs: string[]
  expectedRefCount: number
  truncated: boolean
}

function summarize(samples: Sample[]) {
  if (samples.length === 0) return { n: 0, mean: 0, max: 0, violations: 0, dropRate: 0 }
  const chars = samples.map((s) => s.chars)
  const violations = samples.filter((s) => s.chars > s.budget).length
  // Drop rate: per sample, fraction of expected refs that did NOT survive
  // truncation. Averaged across samples for a single number.
  let dropTotal = 0
  let dropDenom = 0
  for (const s of samples) {
    if (s.expectedRefCount === 0) continue
    const survived = s.injectedRefs.length
    const dropped = Math.max(0, s.expectedRefCount - survived)
    dropTotal += dropped
    dropDenom += s.expectedRefCount
  }
  return {
    n: samples.length,
    mean: Math.round(chars.reduce((a, b) => a + b, 0) / samples.length),
    max: Math.max(...chars),
    violations,
    dropRate: dropDenom === 0 ? 0 : dropTotal / dropDenom,
  }
}

export async function runContextBudgetMetric(opts: ContextBudgetOptions): Promise<MetricResult> {
  const budget = opts.budget ?? 4000
  const max = opts.maxPrompts ?? 12
  const gold = readFileSync(opts.goldPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; prompt: string; expected: string[] })
    .slice(0, max)

  const claudeSamples: Sample[] = []
  const opencodeSamples: Sample[] = []

  for (const entry of gold) {
    const sandbox = createSandbox({
      sourceStash: opts.stashDir,
      env: { AKM_CONTEXT_BUDGET_CHARS: String(budget) },
    })
    try {
      // Claude: invoke curate-prompt hook
      const claude = runClaudeHook(["curate-prompt"], {
        input: JSON.stringify({ session_id: `cb-${entry.id}`, prompt: entry.prompt }),
        env: sandbox.env,
      })
      const { context, refs } = parseInjectedRefs(claude.stdout)
      claudeSamples.push({
        id: entry.id,
        plugin: "claude",
        budget,
        chars: context.length,
        injectedRefs: refs,
        expectedRefCount: entry.expected.length,
        truncated: context.length > budget,
      })
    } finally {
      sandbox.cleanup()
    }
  }

  // OpenCode harness reuses one process — initialize once, then loop. We
  // also need to install fake-akm globally so the plugin's execFileSync
  // calls hit it.
  let opencodeAvailable = true
  let opencodeHarness: Awaited<ReturnType<typeof createOpenCodeHarness>> | null = null
  let opencodeSandbox: ReturnType<typeof createSandbox> | null = null
  try {
    opencodeSandbox = createSandbox({
      sourceStash: opts.stashDir,
      env: { AKM_CONTEXT_BUDGET_CHARS: String(budget) },
    })
    opencodeHarness = await createOpenCodeHarness(opencodeSandbox.env)
    for (const entry of gold) {
      const result = await opencodeHarness.curateAndExtract({
        sessionID: `cb-oc-${entry.id}`,
        prompt: entry.prompt,
      })
      opencodeSamples.push({
        id: entry.id,
        plugin: "opencode",
        budget,
        chars: result.context.length,
        injectedRefs: result.refs,
        expectedRefCount: entry.expected.length,
        truncated: result.context.length > budget,
      })
    }
  } catch (err) {
    opencodeAvailable = false
    console.error(`! OpenCode harness failed: ${(err as Error).message}`)
  } finally {
    if (opencodeSandbox) opencodeSandbox.cleanup()
  }

  const claudeSummary = summarize(claudeSamples)
  const opencodeSummary = summarize(opencodeSamples)

  return {
    name: "context_budget",
    values: {
      budget,
      claude_n: claudeSummary.n,
      claude_avg_chars: claudeSummary.mean,
      claude_max_chars: claudeSummary.max,
      claude_violations: claudeSummary.violations,
      claude_drop_rate: claudeSummary.dropRate,
      opencode_n: opencodeSummary.n,
      opencode_avg_chars: opencodeSummary.mean,
      opencode_max_chars: opencodeSummary.max,
      opencode_violations: opencodeSummary.violations,
      opencode_drop_rate: opencodeSummary.dropRate,
      opencode_available: opencodeAvailable,
    },
    table: {
      headers: ["plugin", "n", "avg chars", "max chars", "violations", "drop rate"],
      rows: [
        ["claude", claudeSummary.n, claudeSummary.mean, claudeSummary.max, claudeSummary.violations, claudeSummary.dropRate.toFixed(4)],
        opencodeAvailable
          ? ["opencode", opencodeSummary.n, opencodeSummary.mean, opencodeSummary.max, opencodeSummary.violations, opencodeSummary.dropRate.toFixed(4)]
          : ["opencode", "—", "—", "—", "—", "skipped"],
      ],
    },
    notes: [
      `Budget: ${budget} chars. Drop rate is the fraction of expected refs that did not survive truncation, averaged across prompts.`,
    ],
  }
}
