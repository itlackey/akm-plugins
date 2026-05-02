// Judge client: scores scenario runs via the Anthropic API.
//
// Design choices:
//   - Model: claude-sonnet-4-6 (cheaper than Opus, plenty capable for
//     scoring; tier-3 will run many scenarios).
//   - Structured output via tool use forcing — guarantees the verdict
//     parses cleanly into the rubric shape.
//   - Verdict cache keyed on sha256(scenario.id + plugin + transcript)
//     — re-running against an unchanged candidate doesn't pay the API
//     again.
//   - Per-run dollar cap: the runner aborts and reports if the
//     cumulative judge spend exceeds the configured ceiling.
//
// Note on prompt caching: an earlier version of this client placed a
// cache_control marker on the rubric system prompt. With Sonnet 4.6's
// 2048-token minimum cacheable prefix and a ~600-token rubric, the
// marker silently never fired. Removed. If/when the rubric grows
// (e.g. with worked examples), we should re-add the marker.

import Anthropic from "@anthropic-ai/sdk"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { getRubric, type RubricScore } from "./rubric"
import type { Scenario } from "../scenarios"
import type { ScenarioRun } from "../harness/run-scenario"

export type JudgeOptions = {
  // Hard $ cap; runner aborts when reached.
  budgetUsd?: number
  // Where to cache verdicts. Keyed on (scenario.id, sha256(transcript))
  // so re-running the same plugin version is free after the first pass.
  cacheDir?: string
  // Override the model.
  model?: string
}

export type JudgeVerdict = {
  scenarioId: string
  plugin: string
  scores: RubricScore
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  cached: boolean
  durationMs: number
  modelUsed: string
}

// Sonnet 4.6 pricing per million tokens (input/output, cache read at ~10%, cache write at ~125%).
const PRICING = {
  "claude-sonnet-4-6": {
    inputPerM: 3.0,
    outputPerM: 15.0,
    cacheReadPerM: 0.30,
    cacheWritePerM: 3.75,
  },
}

function priceFor(model: string) {
  return PRICING[model as keyof typeof PRICING] ?? PRICING["claude-sonnet-4-6"]
}

function estimateCost(model: string, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): number {
  const p = priceFor(model)
  const inp = (usage.input_tokens ?? 0) / 1_000_000 * p.inputPerM
  const out = (usage.output_tokens ?? 0) / 1_000_000 * p.outputPerM
  const cr = (usage.cache_read_input_tokens ?? 0) / 1_000_000 * p.cacheReadPerM
  const cw = (usage.cache_creation_input_tokens ?? 0) / 1_000_000 * p.cacheWritePerM
  return inp + out + cr + cw
}

function transcriptHash(scenarioId: string, run: ScenarioRun): string {
  const sorted = JSON.stringify({
    scenarioId,
    plugin: run.plugin,
    transcript: run.transcript,
  })
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16)
}

function loadCachedVerdict(cacheDir: string, key: string): JudgeVerdict | null {
  const p = path.join(cacheDir, `${key}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8")) as JudgeVerdict
  } catch {
    return null
  }
}

function writeCachedVerdict(cacheDir: string, key: string, verdict: JudgeVerdict) {
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(verdict, null, 2) + "\n")
}

function buildJudgeUserPrompt(scenario: Scenario, run: ScenarioRun): string {
  // The transcript is rendered as compact text the model can scan
  // quickly. We trim very long context bodies — the refs are what
  // actually inform the score, not the full text.
  const lines: string[] = []
  lines.push(`# Scenario: ${scenario.id}`)
  lines.push(`Plugin under test: ${run.plugin}`)
  lines.push(`Description: ${scenario.description}`)
  lines.push("")
  lines.push("## Expectations")
  lines.push(`- must_curate_refs: ${(scenario.expectations.must_curate_refs ?? []).join(", ") || "(none)"}`)
  lines.push(`- may_curate_refs: ${(scenario.expectations.may_curate_refs ?? []).join(", ") || "(none)"}`)
  lines.push(`- must_record_feedback_for: ${(scenario.expectations.must_record_feedback_for ?? []).join(", ") || "(none)"}`)
  lines.push(`- forbid_refs: ${(scenario.expectations.forbid_refs ?? []).join(", ") || "(none)"}`)
  lines.push(`- max_total_tokens: ${scenario.expectations.max_total_tokens ?? "(unset)"}`)
  lines.push("")
  lines.push("## Transcript")
  for (const t of run.transcript) {
    if (t.type === "user") lines.push(`USER: ${t.content}`)
    else if (t.type === "injected_context") {
      const trimmed = t.body.length > 600 ? t.body.slice(0, 600) + "…" : t.body
      lines.push(`INJECTED_CONTEXT (plugin=${t.plugin}, chars=${t.chars}, refs=[${t.refs.join(",")}]):\n${trimmed}`)
    }
    else if (t.type === "tool_use") lines.push(`TOOL_USE: ${t.tool} ${t.ref ?? ""} args=${JSON.stringify(t.args)}`)
    else if (t.type === "tool_result") lines.push(`TOOL_RESULT: ${t.tool} ok=${t.ok} output=${t.output.slice(0, 200)}`)
    else if (t.type === "feedback") lines.push(`FEEDBACK: ${t.ref} ${t.sentiment} (${t.note})`)
    else if (t.type === "agent_summary") lines.push(`AGENT: ${t.text}`)
  }
  if (run.error) {
    lines.push("")
    lines.push(`## ERROR\n${run.error}`)
  }
  lines.push("")
  lines.push("Score this run using the score_run tool. Be objective and concise.")
  return lines.join("\n")
}

export class Judge {
  private client: Anthropic
  private model: string
  private budgetUsd: number
  private cacheDir: string | null
  private spent = 0

  constructor(opts: JudgeOptions = {}) {
    this.client = new Anthropic()
    this.model = opts.model ?? "claude-sonnet-4-6"
    this.budgetUsd = opts.budgetUsd ?? 5.0
    this.cacheDir = opts.cacheDir ?? null
  }

  totalSpent(): number {
    return this.spent
  }

  async score(scenario: Scenario, run: ScenarioRun): Promise<JudgeVerdict> {
    if (this.cacheDir) {
      const key = `${scenario.id}-${run.plugin}-${transcriptHash(scenario.id, run)}`
      const cached = loadCachedVerdict(this.cacheDir, key)
      if (cached) return { ...cached, cached: true }
    }
    if (this.spent >= this.budgetUsd) {
      throw new Error(`Judge budget exhausted: $${this.spent.toFixed(4)} / $${this.budgetUsd.toFixed(4)}`)
    }

    const rubric = getRubric(scenario.judge_rubric)
    const userPrompt = buildJudgeUserPrompt(scenario, run)
    const start = performance.now()
    // System prompt is split: the rubric (frozen, cacheable) goes in the
    // first text block with cache_control. The scenario expectations are
    // already in the user prompt, so the system stays prefix-stable
    // across all runs of the same scenario.
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: rubric.systemPrompt,
      tools: [
        {
          name: rubric.responseSchema.name,
          description: rubric.responseSchema.description,
          input_schema: rubric.responseSchema.input_schema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: rubric.responseSchema.name },
      messages: [{ role: "user", content: userPrompt }],
    })
    const durationMs = Math.round(performance.now() - start)

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    if (!toolUse) {
      throw new Error("Judge returned no tool_use block")
    }
    const scores = toolUse.input as RubricScore
    const costUsd = estimateCost(response.model, response.usage)
    this.spent += costUsd

    const verdict: JudgeVerdict = {
      scenarioId: scenario.id,
      plugin: run.plugin,
      scores,
      costUsd,
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cached: false,
      durationMs,
      modelUsed: response.model,
    }

    if (this.cacheDir) {
      const key = `${scenario.id}-${run.plugin}-${transcriptHash(scenario.id, run)}`
      writeCachedVerdict(this.cacheDir, key, verdict)
    }

    return verdict
  }
}
