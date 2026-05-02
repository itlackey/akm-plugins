// Tier-3 scenario harness.
//
// Runs a scenario against either plugin and produces a structured
// transcript: the full sequence of user turns, hook-injected context,
// curation refs, tool calls (synthesized from the curated content), and
// any feedback emitted. The transcript is what the judge scores.
//
// We do NOT actually drive a real LLM through the plugin in tier 2 — the
// "agent" inside the harness is a deterministic stub that:
//   - reads the curated context
//   - issues `akm show <ref>` for each "must use" expected ref
//   - records feedback on success
//
// This is intentionally narrow. The point of tier 3 is to score the
// **plugin's behavior surface as observed by an agent** — what context did
// it inject, did the right refs surface, did the agent get the data it
// needed to fire the expected feedback. A future iteration can swap the
// stub for a real Claude API loop; the transcript shape is the same.

import path from "node:path"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook, parseInjectedRefs } from "../../tier2/harness/claude"
import { createOpenCodeHarness } from "../../tier2/harness/opencode"
import type { Scenario, ScenarioPlugin } from "../scenarios"

export type TranscriptTurn =
  | { type: "user"; content: string }
  | { type: "injected_context"; plugin: ScenarioPlugin; chars: number; refs: string[]; body: string }
  | { type: "tool_use"; tool: string; ref?: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; ok: boolean; output: string }
  | { type: "feedback"; ref: string; sentiment: "positive" | "negative"; note: string }
  | { type: "agent_summary"; text: string }

export type ScenarioRun = {
  scenarioId: string
  plugin: ScenarioPlugin
  startedAt: string
  durationMs: number
  transcript: TranscriptTurn[]
  injectedContextChars: number
  curatedRefs: string[]
  feedbackEmitted: Array<{ ref: string; sentiment: "positive" | "negative" }>
  // Errors that aborted the run; the judge will see this and score the run as failed.
  error?: string
}

const EVALS_ROOT = path.resolve(import.meta.dir, "../..")

export async function runScenario(scenario: Scenario, plugin: ScenarioPlugin): Promise<ScenarioRun> {
  const stashDir = path.join(EVALS_ROOT, "fixtures/stash")
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const transcript: TranscriptTurn[] = []
  const feedbackEmitted: Array<{ ref: string; sentiment: "positive" | "negative" }> = []
  let injectedContextChars = 0
  let curatedRefs: string[] = []
  let error: string | undefined

  if (plugin === "claude") {
    for (const turn of scenario.user_turns) {
      transcript.push({ type: "user", content: turn.content })
      const sandbox = createSandbox({ sourceStash: stashDir })
      try {
        const curate = runClaudeHook(["curate-prompt"], {
          input: JSON.stringify({ session_id: `t3-${scenario.id}`, prompt: turn.content }),
          env: sandbox.env,
        })
        const { context, refs } = parseInjectedRefs(curate.stdout)
        injectedContextChars += context.length
        curatedRefs = [...new Set([...curatedRefs, ...refs])]
        transcript.push({ type: "injected_context", plugin: "claude", chars: context.length, refs, body: context })

        // The "agent" stub: for each must-curate ref, simulate a show + positive feedback if it surfaced.
        for (const expectedRef of scenario.expectations.must_curate_refs ?? []) {
          if (refs.includes(expectedRef)) {
            transcript.push({ type: "tool_use", tool: "Bash", ref: expectedRef, args: { command: `akm show ${expectedRef}` } })
            transcript.push({ type: "tool_result", tool: "Bash", ok: true, output: `{"ok":true,"ref":"${expectedRef}"}` })
            // Drive auto-feedback through the hook so the call hits fake-akm and the harness can attest.
            runClaudeHook(["auto-feedback", "success"], {
              input: JSON.stringify({
                tool: "Bash",
                input: { command: `akm show ${expectedRef}` },
                output: `{"ok":true,"ref":"${expectedRef}"}`,
              }),
              env: sandbox.env,
            })
            feedbackEmitted.push({ ref: expectedRef, sentiment: "positive" })
            transcript.push({ type: "feedback", ref: expectedRef, sentiment: "positive", note: "stub: showed ref" })
          }
        }
        // Synthesize a brief agent summary so the judge has something to score the response on.
        transcript.push({
          type: "agent_summary",
          text: `Used curated assets: ${refs.join(", ") || "none"}.`,
        })
      } catch (err) {
        error = (err as Error).message
        break
      } finally {
        sandbox.cleanup()
      }
    }
  } else {
    // OpenCode: drive in-process, share one harness across the scenario.
    let sandbox: ReturnType<typeof createSandbox> | null = null
    try {
      sandbox = createSandbox({ sourceStash: stashDir })
      const harness = await createOpenCodeHarness(sandbox.env)
      const sid = `t3-oc-${scenario.id}`
      for (const turn of scenario.user_turns) {
        transcript.push({ type: "user", content: turn.content })
        const result = await harness.curateAndExtract({ sessionID: sid, prompt: turn.content })
        injectedContextChars += result.context.length
        curatedRefs = [...new Set([...curatedRefs, ...result.refs])]
        transcript.push({
          type: "injected_context",
          plugin: "opencode",
          chars: result.context.length,
          refs: result.refs,
          body: result.context,
        })
        for (const expectedRef of scenario.expectations.must_curate_refs ?? []) {
          if (result.refs.includes(expectedRef)) {
            transcript.push({ type: "tool_use", tool: "akm_show", ref: expectedRef, args: { ref: expectedRef } })
            transcript.push({ type: "tool_result", tool: "akm_show", ok: true, output: `{"ok":true,"ref":"${expectedRef}"}` })
            // Drive the after-hook so feedback gets recorded.
            await harness.toolAfter({
              sessionID: sid,
              tool: "akm_show",
              toolArgs: { ref: expectedRef },
              output: `{"ok":true,"ref":"${expectedRef}"}`,
            })
            feedbackEmitted.push({ ref: expectedRef, sentiment: "positive" })
            transcript.push({ type: "feedback", ref: expectedRef, sentiment: "positive", note: "stub: showed ref" })
          }
        }
        transcript.push({
          type: "agent_summary",
          text: `Used curated assets: ${result.refs.join(", ") || "none"}.`,
        })
      }
    } catch (err) {
      error = (err as Error).message
    } finally {
      if (sandbox) sandbox.cleanup()
    }
  }

  return {
    scenarioId: scenario.id,
    plugin,
    startedAt,
    durationMs: Math.round(performance.now() - start),
    transcript,
    injectedContextChars,
    curatedRefs,
    feedbackEmitted,
    error,
  }
}
