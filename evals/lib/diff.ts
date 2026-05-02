// Diff a candidate eval report against a baseline. Used both as a CLI
// (`bun run eval:diff <baseline> <candidate>`) and from CI to gate PRs.
//
// Regression policy is intentionally simple and configurable: each metric
// declares which keys are "higher is better" vs "lower is better", and a
// threshold below which a delta counts as a regression. Surface changes
// (added/removed tools, commands, hooks) are flagged separately because
// removals are usually intentional and reviewed by humans.

import { readFileSync } from "node:fs"
import type { EvalReport } from "./report"

export type DiffPolicy = {
  // Per-metric per-key threshold rules.
  rules: Array<{
    metric: string
    key: string
    direction: "higher-is-better" | "lower-is-better"
    // Deltas with abs(delta) ≤ epsilon are treated as no-change.
    epsilon: number
    // Regression is flagged when the relative change exceeds this fraction
    // (0.03 = 3%). For latency we typically allow 25% slack.
    regressionPct: number
  }>
}

// Opt-in latency rules — usable when you've regenerated the baseline on
// the same hardware as the candidate. Pass `policyWithLatency()` to
// `diffReports` instead of the default to gate on latency too.
export const LATENCY_RULES: DiffPolicy["rules"] = [
  { metric: "latency", key: "curate_prompt_p95_ms", direction: "lower-is-better", epsilon: 5, regressionPct: 0.25 },
  { metric: "latency", key: "session_start_p95_ms", direction: "lower-is-better", epsilon: 10, regressionPct: 0.25 },
  { metric: "latency", key: "post_tool_p95_ms", direction: "lower-is-better", epsilon: 5, regressionPct: 0.25 },
]

export function policyWithLatency(base: DiffPolicy = DEFAULT_POLICY): DiffPolicy {
  return { rules: [...base.rules, ...LATENCY_RULES] }
}

export const DEFAULT_POLICY: DiffPolicy = {
  rules: [
    { metric: "curation", key: "mean_expected_coverage", direction: "higher-is-better", epsilon: 0.01, regressionPct: 0.05 },
    { metric: "curation", key: "mean_reciprocal_rank", direction: "higher-is-better", epsilon: 0.01, regressionPct: 0.05 },
    { metric: "curation", key: "zero_hit_rate", direction: "lower-is-better", epsilon: 0.01, regressionPct: 0.03 },
    // Latency is intentionally excluded from regression gating: the
    // baseline is captured on whoever's machine ran `baseline:update`,
    // and CI hardware is wildly different (often 2-5x slower than dev
    // machines). The latency metric is still computed, reported, and
    // diffable on demand via `bun run diff --include-latency`, but it
    // doesn't fail the run by default. To compare latency
    // apples-to-apples, regenerate the baseline IN the same environment
    // as the candidate run.
    { metric: "context_budget", key: "claude_violations", direction: "lower-is-better", epsilon: 0, regressionPct: 0.0001 },
    { metric: "context_budget", key: "opencode_violations", direction: "lower-is-better", epsilon: 0, regressionPct: 0.0001 },
    { metric: "context_budget", key: "claude_drop_rate", direction: "lower-is-better", epsilon: 0.01, regressionPct: 0.10 },
    { metric: "context_budget", key: "opencode_drop_rate", direction: "lower-is-better", epsilon: 0.01, regressionPct: 0.10 },
    { metric: "feedback", key: "claude_precision", direction: "higher-is-better", epsilon: 0.005, regressionPct: 0.03 },
    { metric: "feedback", key: "claude_recall", direction: "higher-is-better", epsilon: 0.005, regressionPct: 0.03 },
    { metric: "feedback", key: "claude_polarity_flips", direction: "lower-is-better", epsilon: 0, regressionPct: 0.0001 },
    { metric: "feedback", key: "opencode_precision", direction: "higher-is-better", epsilon: 0.005, regressionPct: 0.03 },
    { metric: "feedback", key: "opencode_recall", direction: "higher-is-better", epsilon: 0.005, regressionPct: 0.03 },
    { metric: "feedback", key: "opencode_polarity_flips", direction: "lower-is-better", epsilon: 0, regressionPct: 0.0001 },
    { metric: "memory", key: "claude_avg_body_chars", direction: "higher-is-better", epsilon: 20, regressionPct: 0.20 },
    { metric: "memory", key: "claude_name_format_violations", direction: "lower-is-better", epsilon: 0, regressionPct: 0.0001 },
    { metric: "memory", key: "claude_secret_leakages", direction: "lower-is-better", epsilon: 0, regressionPct: 0.0001 },
  ],
}

export type DiffEntry = {
  metric: string
  key: string
  baseline: number | null
  candidate: number | null
  deltaAbs: number | null
  deltaPct: number | null
  status: "improved" | "regressed" | "unchanged" | "missing"
  rule?: DiffPolicy["rules"][number]
}

export type DiffSummary = {
  baselinePath: string
  candidatePath: string
  baselineSha: string | null
  candidateSha: string | null
  entries: DiffEntry[]
  surface: {
    addedTools: string[]
    removedTools: string[]
    addedCommands: string[]
    removedCommands: string[]
    addedHooks: string[]
    removedHooks: string[]
  } | null
  regressions: DiffEntry[]
  regressionExitCode: number
}

export function loadReport(filePath: string): EvalReport {
  return JSON.parse(readFileSync(filePath, "utf8")) as EvalReport
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

export function diffReports(baseline: EvalReport, candidate: EvalReport, policy: DiffPolicy = DEFAULT_POLICY): DiffSummary {
  const entries: DiffEntry[] = []
  for (const rule of policy.rules) {
    const b = asNumber(baseline.metrics[rule.metric]?.values?.[rule.key])
    const c = asNumber(candidate.metrics[rule.metric]?.values?.[rule.key])
    if (b === null || c === null) {
      entries.push({
        metric: rule.metric,
        key: rule.key,
        baseline: b,
        candidate: c,
        deltaAbs: null,
        deltaPct: null,
        status: "missing",
        rule,
      })
      continue
    }
    const deltaAbs = c - b
    const deltaPct = b === 0 ? 0 : deltaAbs / Math.abs(b)
    let status: DiffEntry["status"] = "unchanged"
    if (Math.abs(deltaAbs) > rule.epsilon) {
      const improved = rule.direction === "higher-is-better" ? deltaAbs > 0 : deltaAbs < 0
      if (improved) status = "improved"
      else if (Math.abs(deltaPct) >= rule.regressionPct) status = "regressed"
      else status = "unchanged"
    }
    entries.push({ metric: rule.metric, key: rule.key, baseline: b, candidate: c, deltaAbs, deltaPct, status, rule })
  }

  // Surface diff is computed from the `surface` metric if both reports
  // include it. Missing surface data is non-fatal — tier-2 may run a
  // subset of metrics.
  let surface: DiffSummary["surface"] = null
  const bSurface = baseline.metrics.surface?.values
  const cSurface = candidate.metrics.surface?.values
  if (bSurface && cSurface) {
    const setDiff = (a: unknown, b: unknown) => {
      const A = new Set(Array.isArray(a) ? (a as string[]) : [])
      const B = new Set(Array.isArray(b) ? (b as string[]) : [])
      return {
        added: [...B].filter((x) => !A.has(x)).sort(),
        removed: [...A].filter((x) => !B.has(x)).sort(),
      }
    }
    const tools = setDiff(bSurface.tools, cSurface.tools)
    const commands = setDiff(bSurface.commands, cSurface.commands)
    const hooks = setDiff(bSurface.hooks, cSurface.hooks)
    surface = {
      addedTools: tools.added,
      removedTools: tools.removed,
      addedCommands: commands.added,
      removedCommands: commands.removed,
      addedHooks: hooks.added,
      removedHooks: hooks.removed,
    }
  }

  const regressions = entries.filter((e) => e.status === "regressed")
  const surfaceRemovals =
    (surface?.removedTools.length ?? 0) +
    (surface?.removedCommands.length ?? 0) +
    (surface?.removedHooks.length ?? 0)

  return {
    baselinePath: "",
    candidatePath: "",
    baselineSha: baseline.gitSha,
    candidateSha: candidate.gitSha,
    entries,
    surface,
    regressions,
    regressionExitCode: regressions.length === 0 && surfaceRemovals === 0 ? 0 : 1,
  }
}

export function renderDiffMarkdown(summary: DiffSummary): string {
  const lines: string[] = []
  lines.push("# Eval diff")
  lines.push("")
  lines.push(`- Baseline SHA: \`${summary.baselineSha ?? "n/a"}\``)
  lines.push(`- Candidate SHA: \`${summary.candidateSha ?? "n/a"}\``)
  lines.push("")

  lines.push("## Metric deltas")
  lines.push("")
  lines.push("| Metric | Key | Baseline | Candidate | Δ | Δ% | Status |")
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- |")
  for (const e of summary.entries) {
    lines.push(
      `| ${e.metric} | ${e.key} | ${fmt(e.baseline)} | ${fmt(e.candidate)} | ${fmt(e.deltaAbs)} | ${fmtPct(e.deltaPct)} | ${statusEmoji(e.status)} ${e.status} |`,
    )
  }
  lines.push("")

  if (summary.surface) {
    lines.push("## Plugin surface")
    lines.push("")
    const s = summary.surface
    const block = (title: string, items: string[]) => {
      if (items.length === 0) return
      lines.push(`**${title}:** ${items.map((x) => `\`${x}\``).join(", ")}`)
    }
    if (
      s.addedTools.length + s.removedTools.length + s.addedCommands.length + s.removedCommands.length + s.addedHooks.length + s.removedHooks.length === 0
    ) {
      lines.push("No surface changes.")
    } else {
      block("Tools added", s.addedTools)
      block("Tools removed", s.removedTools)
      block("Commands added", s.addedCommands)
      block("Commands removed", s.removedCommands)
      block("Hooks added", s.addedHooks)
      block("Hooks removed", s.removedHooks)
    }
    lines.push("")
  }

  if (summary.regressions.length > 0 || (summary.surface && (summary.surface.removedTools.length + summary.surface.removedCommands.length + summary.surface.removedHooks.length > 0))) {
    lines.push("## Regressions")
    lines.push("")
    for (const r of summary.regressions) {
      lines.push(`- **${r.metric}.${r.key}** regressed: ${fmt(r.baseline)} → ${fmt(r.candidate)} (${fmtPct(r.deltaPct)})`)
    }
    if (summary.surface) {
      for (const t of summary.surface.removedTools) lines.push(`- **surface.tool** removed: \`${t}\``)
      for (const c of summary.surface.removedCommands) lines.push(`- **surface.command** removed: \`${c}\``)
      for (const h of summary.surface.removedHooks) lines.push(`- **surface.hook** removed: \`${h}\``)
    }
    lines.push("")
  } else {
    lines.push("No regressions.")
    lines.push("")
  }

  return lines.join("\n")
}

function fmt(v: number | null): string {
  if (v === null) return "—"
  return Number.isInteger(v) ? String(v) : v.toFixed(4)
}

function fmtPct(v: number | null): string {
  if (v === null) return "—"
  return `${(v * 100).toFixed(2)}%`
}

function statusEmoji(s: DiffEntry["status"]): string {
  switch (s) {
    case "improved":
      return "✅"
    case "regressed":
      return "❌"
    case "unchanged":
      return "•"
    case "missing":
      return "⚠️"
  }
}
