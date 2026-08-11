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
//   - "neither"-labeled fixtures cover the documented skip list. As of
//     AKM 0.9 that list is `memories/`, `env/`, `secrets/`, and `lessons/`
//     (claude/hooks/akm-hook.ts, autoFeedback()); refs under those concept
//     roots MUST NOT receive auto-feedback. `lessons/` is new in this
//     release. There are no `vault:`/`wiki:` types in 0.9 — the fixtures
//     that used them were repointed at roots that actually exist.
//
// A fixture is driven on success, on failure, or on both. "neither" defaults
// to both (the skip must hold either way) and positive/negative to the one
// matching their label; the optional `drive` field overrides that. `drive`
// exists for the read-only-verb rule added in 0.9: a SUCCESSFUL
// `akm show|search|curate` must emit nothing, while a FAILING one must still
// emit negative, and that is two different truths about one fixture. The
// read-only fixtures are therefore labeled "neither" and driven on success
// only — their failure half is covered by the `akm show` failures in fb-004
// and fb-005. Do not "fix" a read-only regression by re-labeling these.
//
// The two plugins are driven through different positive channels because they
// HAVE different ones. Claude observes arbitrary Bash `akm <verb>` calls, so a
// use-shaped verb (`agent`, `run`, `workflow start`) is a positive on the tool
// path. Every OpenCode tool that yields a ref is read-only, so after the same
// rule OpenCode's tool path can never produce a positive by construction: its
// positive channel is the retrospective one, and that is what the OpenCode arm
// drives for positive fixtures (observe the ref, then say "thanks, that
// worked"). Both arms are still scored on the same emissions in the same call
// log, and both must agree on every fixture.
//
// Refs throughout are AKM 0.9 concept IDs (`skills/code-review`), not the
// pre-0.9 `type:slug` form (`skill:code-review`).

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
  drive?: Array<"success" | "failure">
  // OpenCode only: also deliver a "thanks, that worked" after observing the
  // ref, so the fixture is scored on the retrospective channel and not just on
  // the tool path. Implied for positive fixtures (that IS OpenCode's positive
  // channel). Set it on skip-list fixtures, whose rule has to hold on BOTH
  // channels — the two filters had drifted, and only the tool path excluded
  // `lessons/`.
  retrospective?: boolean
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

// Which tool outcomes this fixture is driven with. Shared by both arms so the
// two plugins are always asked the same question about the same fixture.
function drivesFor(fixture: FeedbackFixture): Array<"success" | "failure"> {
  if (fixture.drive?.length) return fixture.drive
  if (fixture.label === "neither") return ["success", "failure"]
  return [fixture.label === "positive" ? "success" : "failure"]
}

// AKM 0.9 ref grammar: [bundle//]conceptId[#fragment], where conceptId is the
// asset's own path inside the bundle. Anchored, because this is tested against
// a single argv element. Keep the concept-root list in lockstep with
// claude/shared/ref-extraction.ts and opencode/index.ts — `env` is singular,
// `facts`/`instructions`/`sessions` are new in 0.9, and there is no `wikis`.
const REF_RE =
  /^(?:[A-Za-z0-9@._+-]+\/\/)?(?:agents|commands|env|facts|instructions|knowledge|lessons|memories|scripts|secrets|sessions|skills|tasks|workflows)\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+)?$/

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
      for (const s of drivesFor(f)) {
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
        // Per-prompt curation is off for this metric: chat.message is used
        // below only to deliver a retrospective confirmation, and the
        // fire-and-forget `akm curate` it would otherwise schedule is unrelated
        // background noise in the same call log.
        const harness = await createOpenCodeHarness({ ...sandbox.env, AKM_AUTO_CURATE: "0" })
        const outputForDrive = (drive: string) =>
          drive === "failure"
            ? `{"ok":false,"error":"failure","ref":"${f.refs[0] ?? ""}"}`
            : f.output
        for (const drive of drivesFor(f)) {
          const sessionID = `fb-oc-${f.id}-${drive}`
          await harness.toolAfter({
            sessionID,
            tool: f.tool.startsWith("akm_") ? f.tool : "akm_show",
            toolArgs: f.toolArgs ?? {},
            output: outputForDrive(drive),
          })
          // OpenCode's every ref-yielding tool is read-only, so a successful
          // tool call is never a positive on its own (see the header). The
          // channel that DOES credit an asset is the user confirming it
          // afterwards, against the refs this session already observed.
          // Skip-list fixtures opt in with `retrospective` so the roots that
          // must never receive auto-feedback are measured on that channel too.
          if (f.label === "positive" || f.retrospective) {
            await harness.hooks["chat.message"](
              { sessionID, messageID: `msg-${f.id}`, agent: "build" },
              { parts: [{ type: "text", text: "thanks, that worked" }] },
            )
          }
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
      `n=${fixtures.length} synthetic tool outputs, all using AKM 0.9 concept-ID refs. "neither"-labeled fixtures verify the plugins correctly skip auto-feedback for the documented skip list (memories/, env/, secrets/, lessons/) and, for the success-only ones, for a read-only \`show\`/\`search\`/\`curate\` that succeeded.`,
      `Positive fixtures are driven through each plugin's real positive channel: a use-shaped \`akm\` verb on Claude, a retrospective "thanks, that worked" on OpenCode, whose ref-yielding tools are all read-only.`,
    ],
  }
}
