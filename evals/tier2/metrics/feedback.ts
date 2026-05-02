// Auto-feedback classification metric.
//
// Both plugins inspect tool outputs after they run and classify the
// outcome as positive (success) or negative (failure), then call
// `akm feedback <ref> --positive|--negative` for any asset refs they
// see. We test this by feeding a labeled corpus of synthetic tool
// outputs through:
//   - Claude: `auto-feedback success|failure` shell verb (writes to
//     feedback.log + spawns akm feedback calls)
//   - OpenCode: tool.execute.after hook (queues feedback via the
//     plugin's queueFeedback helper, captured via mock client logs +
//     our fake-akm call log)
//
// We score each plugin's classification with precision/recall vs the
// fixture labels and flag samples where the plugins disagree.

import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook } from "../harness/claude"
import { createOpenCodeHarness } from "../harness/opencode"
import { readCallLog } from "../../lib/fake-akm"
import type { MetricResult } from "../../lib/report"

export type FeedbackFixture = {
  id: string
  // What the plugin should classify as. "neither" means no feedback should fire.
  label: "positive" | "negative" | "neither"
  // The akm refs that appear in the output (used to score "did the plugin fire on the right refs").
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

type Outcome = {
  id: string
  label: "positive" | "negative" | "neither"
  predicted: "positive" | "negative" | "neither"
  refsFiredOn: string[]
}

function confusion(outcomes: Outcome[]) {
  // Treat "any feedback recorded" as the positive class for the
  // precision/recall numbers; the per-class breakdown is included in
  // the values bag for diagnostic purposes.
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  let posAsNeg = 0
  let negAsPos = 0
  for (const o of outcomes) {
    const truthFires = o.label !== "neither"
    const predFires = o.predicted !== "neither"
    if (truthFires && predFires) {
      tp++
      if (o.label === "positive" && o.predicted === "negative") posAsNeg++
      if (o.label === "negative" && o.predicted === "positive") negAsPos++
    } else if (!truthFires && predFires) fp++
    else if (truthFires && !predFires) fn++
    else tn++
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return { tp, fp, fn, tn, precision, recall, polarityFlips: posAsNeg + negAsPos }
}

function classifyClaude(stateDir: string): { predicted: "positive" | "negative" | "neither"; refsFired: string[] } {
  // Claude's auto-feedback verb writes one tab-separated line per ref to
  // feedback.log of the form: <ts>\tsystem\tsuccess|failure\tBash\t<cmd>
  // (and a separate "remember" line). Refs come from the akm CLI calls
  // it makes — we sniff those from the fake-akm call log too.
  const feedbackLog = path.join(stateDir, "akm-claude/feedback.log")
  let predicted: "positive" | "negative" | "neither" = "neither"
  if (existsSync(feedbackLog)) {
    const body = readFileSync(feedbackLog, "utf8")
    if (/system\tsuccess\b/.test(body)) predicted = "positive"
    else if (/system\tfailure\b/.test(body)) predicted = "negative"
  }
  return { predicted, refsFired: [] }
}

function refsFromCallLog(callLog: string, sentiment: "positive" | "negative"): string[] {
  const calls = readCallLog(callLog)
  const refs: string[] = []
  const flag = `--${sentiment}`
  for (const call of calls) {
    if (call.argv.includes("feedback") && call.argv.includes(flag)) {
      // Ref is the argv element that looks like "type:name".
      const ref = call.argv.find((a) => /^(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|script|workflow|vault|wiki|lesson):/.test(a))
      if (ref) refs.push(ref)
    }
  }
  return refs
}

export async function runFeedbackMetric(opts: FeedbackOptions): Promise<MetricResult> {
  const fixtures = loadFixtures(opts.fixturesPath)

  // Claude: each fixture runs in its own sandbox; we invoke `auto-feedback
  // success` for label=positive and `auto-feedback failure` for label=negative.
  // For label=neither we run both and check that no feedback fires.
  const claudeOutcomes: Outcome[] = []
  for (const f of fixtures) {
    const sandbox = createSandbox({ sourceStash: opts.stashDir })
    try {
      const sentiments: Array<"success" | "failure"> = f.label === "neither" ? ["success", "failure"] : [f.label === "positive" ? "success" : "failure"]
      let predicted: "positive" | "negative" | "neither" = "neither"
      const fired: string[] = []
      for (const s of sentiments) {
        const result = runClaudeHook(["auto-feedback", s], {
          input: JSON.stringify({
            tool: f.tool,
            input: { command: f.command ?? "" },
            output: f.output,
          }),
          env: sandbox.env,
        })
        // Inspect call log to see which refs the hook recorded feedback on.
        const refs = refsFromCallLog(sandbox.callLog, s === "success" ? "positive" : "negative")
        if (refs.length > 0) {
          predicted = s === "success" ? "positive" : "negative"
          fired.push(...refs)
        }
        // Suppress the unused result warning — stdout is empty for auto-feedback.
        void result
      }
      claudeOutcomes.push({ id: f.id, label: f.label, predicted, refsFiredOn: [...new Set(fired)] })
    } finally {
      sandbox.cleanup()
    }
  }
  const claudeStats = confusion(claudeOutcomes)

  // OpenCode: drive tool.execute.after with synthetic output. The plugin
  // inspects output, classifies feedback, and records via writePluginLog
  // (captured by mock client). We read the captured logs to determine
  // whether the plugin classified the output as positive/negative.
  const opencodeOutcomes: Outcome[] = []
  let opencodeAvailable = true
  try {
    const sandbox = createSandbox({ sourceStash: opts.stashDir })
    try {
      const harness = await createOpenCodeHarness(sandbox.env)
      for (const f of fixtures) {
        const before = harness.client.__logs.length
        await harness.toolAfter({
          sessionID: `fb-${f.id}`,
          tool: f.tool.startsWith("akm_") ? f.tool : "akm_show",
          toolArgs: f.toolArgs ?? {},
          output: f.output,
        })
        const newLogs = harness.client.__logs.slice(before)
        const fbLog = newLogs.find((l) => l.extra?.subsystem === "feedback")
        let predicted: "positive" | "negative" | "neither" = "neither"
        if (fbLog?.extra?.feedback === "positive") predicted = "positive"
        else if (fbLog?.extra?.feedback === "negative") predicted = "negative"
        opencodeOutcomes.push({ id: f.id, label: f.label, predicted, refsFiredOn: [] })
      }
    } finally {
      sandbox.cleanup()
    }
  } catch (err) {
    opencodeAvailable = false
    console.error(`! OpenCode feedback harness failed: ${(err as Error).message}`)
  }
  const opencodeStats = opencodeAvailable
    ? confusion(opencodeOutcomes)
    : { tp: 0, fp: 0, fn: 0, tn: 0, precision: 0, recall: 0, polarityFlips: 0 }

  // Disagreement: cases where claude and opencode classified differently.
  const disagreements: string[] = []
  if (opencodeAvailable) {
    const ocById = new Map(opencodeOutcomes.map((o) => [o.id, o]))
    for (const c of claudeOutcomes) {
      const oc = ocById.get(c.id)
      if (oc && oc.predicted !== c.predicted) {
        disagreements.push(`${c.id}: claude=${c.predicted} opencode=${oc.predicted} (truth=${c.label})`)
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
      claude_polarity_flips: claudeStats.polarityFlips,
      opencode_available: opencodeAvailable,
      opencode_tp: opencodeStats.tp,
      opencode_fp: opencodeStats.fp,
      opencode_fn: opencodeStats.fn,
      opencode_tn: opencodeStats.tn,
      opencode_precision: opencodeStats.precision,
      opencode_recall: opencodeStats.recall,
      opencode_polarity_flips: opencodeStats.polarityFlips,
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
          claudeStats.polarityFlips,
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
              opencodeStats.polarityFlips,
            ]
          : ["opencode", "—", "—", "—", "—", "—", "—", "skipped"],
      ],
    },
    notes: [
      `n=${fixtures.length} synthetic tool outputs. "Polarity flips" counts cases where the plugin fired feedback with the wrong sign (positive output classified negative or vice versa).`,
    ],
  }
}
