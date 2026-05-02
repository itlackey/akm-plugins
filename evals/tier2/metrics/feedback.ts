// Auto-feedback emission metric.
//
// Both plugins inspect tool outputs and decide whether to fire
// `akm feedback <ref> --positive|--negative` on any refs they see. We
// hold both sides to the SAME measurement: actual akm CLI calls in the
// fake-akm call log, NOT the in-process classification signal that
// earlier versions of this metric inspected. Classification without
// emission is invisible to the user; emission is what matters.
//
// For each labeled fixture (label ∈ {positive, negative, neither}):
//   - Drive the appropriate plugin's auto-feedback path with the
//     fixture's tool output.
//   - Inspect the call log for any akm-feedback calls that fired.
//   - Score:
//       * label=positive AND fired --positive on the right ref → TP
//       * label=negative AND fired --negative on the right ref → TP
//       * label=neither AND no fire                            → TN
//       * fire when label=neither                              → FP
//       * no fire when label≠neither                           → FN
//       * fire with the wrong sentiment                        → polarity flip
//   - "neither"-labeled fixtures cover the documented skip list:
//     memory:* and vault:* refs MUST NOT receive auto-feedback.

import { readFileSync } from "node:fs"
import path from "node:path"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook } from "../harness/claude"
import { createOpenCodeHarness } from "../harness/opencode"
import { readCallLog } from "../../lib/fake-akm"
import type { MetricResult } from "../../lib/report"

export type FeedbackFixture = {
  id: string
  label: "positive" | "negative" | "neither"
  refs: string[]
  tool: string
  command?: string
  toolArgs?: Record<string, unknown>
  output: string
}

export type FeedbackOptions = {
  fixturesPath: string
  stashDir: string
}

function loadFixtures(p: string): FeedbackFixture[] {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FeedbackFixture)
}

const REF_RE = /^(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|script|workflow|vault|wiki|lesson):[A-Za-z0-9._\/-]+$/

// Inspect the call log for any `akm feedback <ref> --positive|--negative` calls.
function readEmittedFeedback(callLog: string): Array<{ ref: string; sentiment: "positive" | "negative" }> {
  const calls = readCallLog(callLog)
  const out: Array<{ ref: string; sentiment: "positive" | "negative" }> = []
  for (const call of calls) {
    if (!call.argv.includes("feedback")) continue
    const positive = call.argv.includes("--positive")
    const negative = call.argv.includes("--negative")
    if (!positive && !negative) continue
    const ref = call.argv.find((a) => REF_RE.test(a))
    if (!ref) continue
    out.push({ ref, sentiment: positive ? "positive" : "negative" })
  }
  return out
}

type Outcome = {
  id: string
  label: "positive" | "negative" | "neither"
  emitted: Array<{ ref: string; sentiment: "positive" | "negative" }>
  // Classification of this fixture's outcome:
  result: "tp" | "fp" | "fn" | "tn" | "polarity_flip"
}

function classify(fixture: FeedbackFixture, emitted: Array<{ ref: string; sentiment: "positive" | "negative" }>): Outcome["result"] {
  const targetRefs = new Set(fixture.refs)
  const matchingEmissions = emitted.filter((e) => targetRefs.has(e.ref))
  const fired = matchingEmissions.length > 0
  if (fixture.label === "neither") return fired ? "fp" : "tn"
  if (!fired) return "fn"
  // Fired — check sentiment matches label.
  const wrongSentiment = matchingEmissions.some((e) => (e.sentiment === "positive") !== (fixture.label === "positive"))
  return wrongSentiment ? "polarity_flip" : "tp"
}

function summarize(outcomes: Outcome[]) {
  const tp = outcomes.filter((o) => o.result === "tp").length
  const fp = outcomes.filter((o) => o.result === "fp").length
  const fn = outcomes.filter((o) => o.result === "fn").length
  const tn = outcomes.filter((o) => o.result === "tn").length
  const polarity = outcomes.filter((o) => o.result === "polarity_flip").length
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn + polarity)
  return { tp, fp, fn, tn, polarity_flips: polarity, precision, recall }
}

export async function runFeedbackMetric(opts: FeedbackOptions): Promise<MetricResult> {
  const fixtures = loadFixtures(opts.fixturesPath)

  // Claude side — drive `auto-feedback success|failure` per fixture.
  const claudeOutcomes: Outcome[] = []
  for (const f of fixtures) {
    const sandbox = createSandbox({ sourceStash: opts.stashDir })
    try {
      // For "neither", invoke both success and failure to verify the
      // plugin skips both. For positive/negative, just the matching one.
      const sentiments: Array<"success" | "failure"> = f.label === "neither" ? ["success", "failure"] : [f.label === "positive" ? "success" : "failure"]
      for (const s of sentiments) {
        runClaudeHook(["auto-feedback", s], {
          input: JSON.stringify({
            tool: f.tool,
            input: { command: f.command ?? "" },
            output: f.output,
          }),
          env: sandbox.env,
        })
      }
      const emitted = readEmittedFeedback(sandbox.callLog)
      claudeOutcomes.push({ id: f.id, label: f.label, emitted, result: classify(f, emitted) })
    } finally {
      sandbox.cleanup()
    }
  }

  // OpenCode side — drive `tool.execute.after` per fixture. The plugin's
  // queueFeedback path eventually calls execFileSync('akm', ['feedback', ...])
  // which our fake-akm captures in the call log — same measurement
  // surface as Claude.
  const opencodeOutcomes: Outcome[] = []
  let opencodeAvailable = true
  try {
    for (const f of fixtures) {
      const sandbox = createSandbox({ sourceStash: opts.stashDir })
      try {
        const harness = await createOpenCodeHarness(sandbox.env)
        const outputForLabel = (label: string) =>
          label === "negative"
            ? `{"ok":false,"error":"failure","ref":"${f.refs[0] ?? ""}"}`
            : f.output
        const labels: Array<"positive" | "negative" | "neither"> = f.label === "neither" ? ["positive", "negative"] : [f.label]
        for (const label of labels) {
          await harness.toolAfter({
            sessionID: `fb-oc-${f.id}-${label}`,
            tool: f.tool.startsWith("akm_") ? f.tool : "akm_show",
            toolArgs: f.toolArgs ?? {},
            output: outputForLabel(label),
          })
        }
        // OpenCode's queueFeedback uses detached spawn — the akm child
        // runs async after toolAfter returns. Wait for the call log to
        // settle. 250ms is enough on typical hardware for the shim
        // (which is just a node process appending to a file) to land.
        await new Promise((resolve) => setTimeout(resolve, 250))
        const emitted = readEmittedFeedback(sandbox.callLog)
        opencodeOutcomes.push({ id: f.id, label: f.label, emitted, result: classify(f, emitted) })
      } finally {
        sandbox.cleanup()
      }
    }
  } catch (err) {
    opencodeAvailable = false
    console.error(`! OpenCode feedback harness failed: ${(err as Error).message}`)
  }

  const claudeStats = summarize(claudeOutcomes)
  const opencodeStats = opencodeAvailable
    ? summarize(opencodeOutcomes)
    : { tp: 0, fp: 0, fn: 0, tn: 0, polarity_flips: 0, precision: 0, recall: 0 }

  const disagreements: string[] = []
  if (opencodeAvailable) {
    const ocById = new Map(opencodeOutcomes.map((o) => [o.id, o]))
    for (const c of claudeOutcomes) {
      const oc = ocById.get(c.id)
      if (oc && oc.result !== c.result) {
        disagreements.push(`${c.id}: claude=${c.result} opencode=${oc.result} (truth=${c.label})`)
      }
    }
  }

  return {
    name: "feedback",
    values: {
      n: fixtures.length,
      claude_tp: claudeStats.tp,
      claude_fp: claudeStats.fp,
      claude_fn: claudeStats.fn,
      claude_tn: claudeStats.tn,
      claude_precision: claudeStats.precision,
      claude_recall: claudeStats.recall,
      claude_polarity_flips: claudeStats.polarity_flips,
      opencode_available: opencodeAvailable,
      opencode_tp: opencodeStats.tp,
      opencode_fp: opencodeStats.fp,
      opencode_fn: opencodeStats.fn,
      opencode_tn: opencodeStats.tn,
      opencode_precision: opencodeStats.precision,
      opencode_recall: opencodeStats.recall,
      opencode_polarity_flips: opencodeStats.polarity_flips,
      disagreements,
    },
    table: {
      headers: ["plugin", "tp", "fp", "fn", "tn", "precision", "recall", "polarity flips"],
      rows: [
        [
          "claude",
          claudeStats.tp,
          claudeStats.fp,
          claudeStats.fn,
          claudeStats.tn,
          claudeStats.precision.toFixed(4),
          claudeStats.recall.toFixed(4),
          claudeStats.polarity_flips,
        ],
        opencodeAvailable
          ? [
              "opencode",
              opencodeStats.tp,
              opencodeStats.fp,
              opencodeStats.fn,
              opencodeStats.tn,
              opencodeStats.precision.toFixed(4),
              opencodeStats.recall.toFixed(4),
              opencodeStats.polarity_flips,
            ]
          : ["opencode", "—", "—", "—", "—", "—", "—", "skipped"],
      ],
    },
    notes: [
      `Both plugins measured by actual \`akm feedback\` invocations in the call log (NOT in-process classification — that change vs the previous metric exposed an apparent ~18% precision delta on OpenCode that was entirely due to the asymmetric measurement).`,
      `n=${fixtures.length} synthetic tool outputs. "neither"-labeled fixtures verify the plugins correctly skip auto-feedback for memory: and vault: refs.`,
    ],
  }
}
