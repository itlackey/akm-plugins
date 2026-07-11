#!/usr/bin/env node
// Generates the three embedded copies of the akm_help / /akm-help quick-reference
// table from the single canonical source, docs/akm-help-registry.md.
//
// Consumers (each has a `BEGIN GENERATED: akm-help-table` / `END GENERATED:
// akm-help-table` marker pair around the region this script owns):
//   - claude/commands/akm-help.md   (markdown table)
//   - claude/skills/akm/SKILL.md    (markdown table)
//   - opencode/index.ts             (AKM_HELP_QUICK_REFERENCE array literal)
//
// Usage:
//   node scripts/generate-help-tables.mjs           # rewrite all three consumers
//   node scripts/generate-help-tables.mjs --check    # exit 1 if any consumer would
//                                                     # change; prints which one and
//                                                     # which row drifted
//
// No dependencies beyond node:fs / node:path — runnable with `node` or `bun`.

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, "..")

const REGISTRY_PATH = path.join(repoRoot, "docs/akm-help-registry.md")
const REGISTRY_START = "<!-- REGISTRY TABLE START -->"
const REGISTRY_END = "<!-- REGISTRY TABLE END -->"

const GENERATED_START_PREFIX = "BEGIN GENERATED: akm-help-table"
const GENERATED_END_MARKER = "END GENERATED: akm-help-table"

const CHECK = process.argv.includes("--check")

/** Parse the canonical table out of docs/akm-help-registry.md into row objects. */
function parseRegistry() {
  const content = readFileSync(REGISTRY_PATH, "utf8")
  const startIdx = content.indexOf(REGISTRY_START)
  const endIdx = content.indexOf(REGISTRY_END)
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `${REGISTRY_PATH} is missing ${REGISTRY_START} / ${REGISTRY_END} markers around the curated table.`,
    )
  }
  const block = content.slice(startIdx + REGISTRY_START.length, endIdx)
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"))

  const rows = []
  for (const line of lines) {
    if (line.startsWith("| ---")) continue
    if (line.startsWith("| Task |")) continue
    const trimmed = line.replace(/^\|\s?/, "").replace(/\s?\|$/, "")
    const cells = trimmed.split(" | ")
    if (cells.length !== 4) {
      throw new Error(`Malformed registry row (expected 4 cells, got ${cells.length}): ${line}`)
    }
    const [task, command, notes, keywords] = cells
    rows.push({
      task: task.trim(),
      command: command.trim(),
      notes: notes.trim(),
      keywords: keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      raw: line,
    })
  }
  if (rows.length === 0) throw new Error(`No rows parsed from ${REGISTRY_PATH} — check the table markers.`)
  return rows
}

/** Strip a single or double backtick code-span wrapper, e.g. `` `foo` `` -> `foo`. */
function stripCodeSpan(cell) {
  const t = cell.trim()
  if (t.startsWith("``") && t.endsWith("``") && t.length >= 4) return t.slice(2, -2)
  if (t.startsWith("`") && t.endsWith("`") && t.length >= 2) return t.slice(1, -1)
  return t
}

/**
 * Registry cells escape interior pipes as `\|` so GitHub renders the markdown
 * tables correctly (GFM splits cells on unescaped `|` even inside code spans).
 * The markdown consumers reuse the raw escaped row; runtime TS strings must
 * carry the real character.
 */
function unescapePipes(value) {
  return value.replaceAll("\\|", "|")
}

function renderMarkdownTable(rows) {
  const header = "| Task | Command | Notes | Keywords |"
  const separator = "| --- | --- | --- | --- |"
  return [header, separator, ...rows.map((r) => r.raw)].join("\n")
}

function jsString(value) {
  return JSON.stringify(value)
}

function renderTsTable(rows) {
  const lines = []
  lines.push("const AKM_HELP_QUICK_REFERENCE: readonly AkmHelpEntry[] = [")
  for (const row of rows) {
    lines.push("  {")
    lines.push(`    task: ${jsString(unescapePipes(row.task))},`)
    lines.push(`    command: ${jsString(unescapePipes(stripCodeSpan(row.command)))},`)
    if (row.notes) lines.push(`    notes: ${jsString(unescapePipes(row.notes))},`)
    lines.push(`    keywords: [${row.keywords.map((k) => jsString(unescapePipes(k))).join(", ")}],`)
    lines.push("  },")
  }
  lines.push("]")
  return lines.join("\n")
}

/**
 * Replace the region between `BEGIN GENERATED: akm-help-table` and
 * `END GENERATED: akm-help-table` markers (markers themselves preserved) with
 * `body`. Works for both `<!-- comment -->` (markdown) and `// comment` (TS)
 * marker styles since we only search for the marker text, not its wrapper.
 */
function replaceGeneratedRegion(content, body, consumerPath) {
  const startMarkerIdx = content.indexOf(GENERATED_START_PREFIX)
  const endMarkerIdx = content.indexOf(GENERATED_END_MARKER)
  if (startMarkerIdx === -1 || endMarkerIdx === -1) {
    throw new Error(`${consumerPath} is missing BEGIN/END GENERATED: akm-help-table markers.`)
  }
  // Find the end of the BEGIN marker's line and the start of the END marker's line.
  const startLineEnd = content.indexOf("\n", startMarkerIdx) + 1
  const endLineStart = content.lastIndexOf("\n", endMarkerIdx) + 1
  if (startLineEnd <= 0 || endLineStart <= startLineEnd) {
    throw new Error(`${consumerPath}: could not locate generated region bounds around the markers.`)
  }
  return content.slice(0, startLineEnd) + body + "\n" + content.slice(endLineStart)
}

const CONSUMERS = [
  {
    name: "claude/commands/akm-help.md",
    path: path.join(repoRoot, "claude/commands/akm-help.md"),
    render: renderMarkdownTable,
  },
  {
    name: "claude/skills/akm/SKILL.md",
    path: path.join(repoRoot, "claude/skills/akm/SKILL.md"),
    render: renderMarkdownTable,
  },
  {
    name: "opencode/index.ts",
    path: path.join(repoRoot, "opencode/index.ts"),
    render: renderTsTable,
  },
]

function main() {
  const rows = parseRegistry()
  let drift = false

  for (const consumer of CONSUMERS) {
    const current = readFileSync(consumer.path, "utf8")
    const body = consumer.render(rows)
    const next = replaceGeneratedRegion(current, body, consumer.name)

    if (current === next) continue

    if (CHECK) {
      drift = true
      console.error(`DRIFT: ${consumer.name} does not match ${path.relative(repoRoot, REGISTRY_PATH)}`)
      const currentLines = new Set(current.split("\n"))
      const nextLines = next.split("\n")
      const taskRe = /^\s*task:\s*"((?:[^"\\]|\\.)*)"/
      const drifted = new Set()
      let runningTask = null
      for (const line of nextLines) {
        const trimmed = line.trim()
        const taskMatch = taskRe.exec(line)
        if (trimmed.startsWith("|")) {
          // Markdown table row — each line IS a whole row, self-labeled.
          if (!currentLines.has(line)) {
            const taskCell = line.split(" | ")[0]?.replace(/^\|\s?/, "")
            drifted.add(taskCell || line.slice(0, 80))
          }
          continue
        }
        if (taskMatch) runningTask = taskMatch[1]
        if (!currentLines.has(line) && runningTask) drifted.add(runningTask)
      }
      for (const task of drifted) console.error(`  row differs: ${task}`)
    } else {
      writeFileSync(consumer.path, next)
      console.log(`updated ${consumer.name}`)
    }
  }

  if (CHECK && drift) {
    console.error("\nRun `node scripts/generate-help-tables.mjs` to sync, then re-run --check.")
    process.exit(1)
  }

  if (CHECK && !drift) {
    console.log("OK: all consumers match docs/akm-help-registry.md")
  }
}

main()
