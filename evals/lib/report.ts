// Report writer + formatter. Tier-2 produces both machine-readable JSON
// (for diff'ing across runs/branches) and a human-readable markdown
// summary (rendered as a PR comment in CI).

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

export type MetricResult = {
  name: string
  // Free-form key→value bag. Stable shape per metric (callers document it)
  // so the diff tool can compare runs.
  values: Record<string, unknown>
  // Markdown table rows for the summary. Each row is a list of cells.
  table?: { headers: string[]; rows: Array<Array<string | number>> }
  // Optional notes the reporter renders verbatim under the metric heading.
  notes?: string[]
}

export type EvalReport = {
  version: "1"
  tier: "tier2" | "tier3"
  pluginVersion: string
  gitSha: string | null
  ranAt: string
  durationMs: number
  metrics: Record<string, MetricResult>
}

export function writeReport(reportDir: string, report: EvalReport): { jsonPath: string; markdownPath: string } {
  mkdirSync(reportDir, { recursive: true })
  const jsonPath = path.join(reportDir, `${report.tier}.json`)
  const markdownPath = path.join(reportDir, `${report.tier}.md`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n")
  writeFileSync(markdownPath, renderMarkdown(report))
  return { jsonPath, markdownPath }
}

export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = []
  lines.push(`# AKM plugin eval — ${report.tier}`)
  lines.push("")
  lines.push(`- Plugin version: \`${report.pluginVersion}\``)
  lines.push(`- Git SHA: \`${report.gitSha ?? "n/a"}\``)
  lines.push(`- Ran at: ${report.ranAt}`)
  lines.push(`- Duration: ${report.durationMs} ms`)
  lines.push("")

  for (const [name, m] of Object.entries(report.metrics)) {
    lines.push(`## ${name}`)
    lines.push("")
    if (m.notes && m.notes.length > 0) {
      for (const n of m.notes) lines.push(`> ${n}`)
      lines.push("")
    }
    if (m.table && m.table.rows.length > 0) {
      lines.push(`| ${m.table.headers.join(" | ")} |`)
      lines.push(`| ${m.table.headers.map(() => "---").join(" | ")} |`)
      for (const row of m.table.rows) {
        lines.push(`| ${row.map((c) => String(c)).join(" | ")} |`)
      }
      lines.push("")
    } else {
      const rows = Object.entries(m.values)
      if (rows.length > 0) {
        lines.push(`| Key | Value |`)
        lines.push(`| --- | --- |`)
        for (const [k, v] of rows) lines.push(`| \`${k}\` | ${formatValue(v)} |`)
        lines.push("")
      }
    }
  }
  return lines.join("\n") + "\n"
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4)
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${v.map(formatValue).join(", ")}]`
  if (typeof v === "object") return `\`${JSON.stringify(v)}\``
  return String(v)
}
