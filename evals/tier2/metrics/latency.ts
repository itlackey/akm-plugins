// Latency metric: time the major hook verbs across a synthetic prompt
// corpus. Hook performance matters because it runs on every user turn —
// regressions show up immediately as visible UI lag.
//
// We sample each verb N times to keep p95/p99 stable, drop the first
// invocation (cold start, includes shell startup), and report p50/p95/p99
// per verb. The diff tool flags p95 increases over a configurable
// threshold (default +25%).

import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook } from "../harness/claude"
import type { MetricResult } from "../../lib/report"

export type LatencyOptions = {
  stashDir: string
  prompts: string[]
  iterations?: number
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function summarize(samples: number[]) {
  return {
    n: samples.length,
    p50: quantile(samples, 0.5),
    p95: quantile(samples, 0.95),
    p99: quantile(samples, 0.99),
    min: samples.length ? Math.min(...samples) : 0,
    max: samples.length ? Math.max(...samples) : 0,
    mean: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0,
  }
}

export function runLatencyMetric(opts: LatencyOptions): MetricResult {
  const iterations = opts.iterations ?? 3
  const verbs: Array<{ name: string; run: (env: Record<string, string>, prompt: string) => number }> = [
    {
      name: "curate_prompt",
      run: (env, prompt) =>
        runClaudeHook(["curate-prompt"], {
          input: JSON.stringify({ session_id: "lat", prompt }),
          env,
        }).durationMs,
    },
    {
      name: "session_start",
      run: (env) =>
        runClaudeHook(["session-start"], {
          input: JSON.stringify({ session_id: "lat" }),
          env,
        }).durationMs,
    },
    {
      name: "post_tool",
      run: (env, prompt) =>
        runClaudeHook(["post-tool", "success"], {
          input: JSON.stringify({
            tool: "Bash",
            input: { command: "akm show skills/code-review" },
            output: `{"ref":"skills/code-review","prompt":"${prompt.slice(0, 32)}"}`,
          }),
          env,
        }).durationMs,
    },
  ]

  const summaries: Record<string, ReturnType<typeof summarize>> = {}
  for (const verb of verbs) {
    const samples: number[] = []
    for (const prompt of opts.prompts) {
      // Each (verb, prompt) gets a fresh sandbox so hot caches don't bias
      // the result. First sample per pair is dropped to absorb shell
      // spawn cost.
      const sandbox = createSandbox({ sourceStash: opts.stashDir })
      try {
        for (let i = 0; i < iterations + 1; i++) {
          const ms = verb.run(sandbox.env, prompt)
          if (i > 0) samples.push(ms)
        }
      } finally {
        sandbox.cleanup()
      }
    }
    summaries[verb.name] = summarize(samples)
  }

  const flat: Record<string, number> = {}
  for (const [verb, s] of Object.entries(summaries)) {
    flat[`${verb}_p50_ms`] = Math.round(s.p50)
    flat[`${verb}_p95_ms`] = Math.round(s.p95)
    flat[`${verb}_p99_ms`] = Math.round(s.p99)
    flat[`${verb}_mean_ms`] = Math.round(s.mean)
    flat[`${verb}_n`] = s.n
  }

  return {
    name: "latency",
    values: { ...flat, summaries },
    table: {
      headers: ["verb", "n", "p50 ms", "p95 ms", "p99 ms", "mean ms"],
      rows: Object.entries(summaries).map(([name, s]) => [
        name,
        s.n,
        Math.round(s.p50),
        Math.round(s.p95),
        Math.round(s.p99),
        Math.round(s.mean),
      ]),
    },
    notes: [
      `Each verb sampled across ${opts.prompts.length} prompts × ${iterations} iterations (first iteration per prompt dropped as cold start).`,
    ],
  }
}
