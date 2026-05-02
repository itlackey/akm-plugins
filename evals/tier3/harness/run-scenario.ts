// Tier-3 scenario harness.
//
// Runs a scenario against either plugin and produces a structured
// transcript. The transcript is then handed to the LLM judge for
// scoring.
//
// Two agent modes:
//   - "real" (default when ANTHROPIC_API_KEY is set): drives a real
//     Claude API loop with a Bash tool whose `akm ...` invocations are
//     routed through the sandbox PATH (so they hit the same fake-akm
//     shim the rest of the framework uses). The agent can hallucinate,
//     skip feedback, pick wrong refs — all the failure modes a real
//     plugin user would encounter.
//   - "stub" (when no API key, or --agent stub): a deterministic
//     projection of the scenario expectations. USEFUL ONLY for
//     validating the harness pipeline itself — the judge's score is
//     near-meaningless because the transcript is mechanically derived
//     from `must_curate_refs`. Reports are tagged with `agent: "stub"`
//     so consumers can see when they're looking at a smoke run vs a
//     real eval.

import path from "node:path"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook, parseInjectedRefs } from "../../tier2/harness/claude"
import { createOpenCodeHarness } from "../../tier2/harness/opencode"
import type { Scenario, ScenarioPlugin } from "../scenarios"

// Lazy import: claude-agent.ts statically imports node:child_process
// via ESM. If we eagerly import it here, that ESM binding is captured
// BEFORE the OpenCode harness gets a chance to patch the underlying
// CJS module to inject our sandbox env, and the OpenCode plugin's own
// child_process spawns end up bypassing fake-akm. Loading lazily means
// the patch is in place by the time anything uses child_process.
type ClaudeAgentModule = typeof import("./claude-agent")
let claudeAgentModule: ClaudeAgentModule | null = null
async function loadClaudeAgent(): Promise<ClaudeAgentModule> {
  if (!claudeAgentModule) claudeAgentModule = await import("./claude-agent")
  return claudeAgentModule
}

export type TranscriptTurn =
  | { type: "user"; content: string }
  | { type: "injected_context"; plugin: ScenarioPlugin; chars: number; refs: string[]; body: string }
  | { type: "tool_use"; tool: string; ref?: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; ok: boolean; output: string }
  | { type: "feedback"; ref: string; sentiment: "positive" | "negative"; note: string }
  | { type: "agent_summary"; text: string }

export type AgentMode = "real" | "stub"

export type ScenarioRun = {
  scenarioId: string
  plugin: ScenarioPlugin
  agentMode: AgentMode
  startedAt: string
  durationMs: number
  transcript: TranscriptTurn[]
  injectedContextChars: number
  curatedRefs: string[]
  feedbackEmitted: Array<{ ref: string; sentiment: "positive" | "negative" }>
  // Set on real-agent runs so the runner can roll up agent-side cost.
  agentCostUsd?: number
  agentTokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  agentTurns?: number
  agentStopReason?: string
  error?: string
}

export type RunScenarioOptions = {
  // Force a specific agent mode. If undefined, real if API key set.
  agentMode?: AgentMode
  // Per-scenario agent budget cap.
  agentBudgetUsd?: number
  // Override the agent model.
  agentModel?: string
}

const EVALS_ROOT = path.resolve(import.meta.dir, "../..")

function pickAgentMode(forced?: AgentMode): AgentMode {
  if (forced) return forced
  return process.env.ANTHROPIC_API_KEY ? "real" : "stub"
}

// Get the curated context the way the plugin would inject it on the
// first user turn. Returns the joined context string and the refs
// extracted from it.
async function curateForTurn(
  plugin: ScenarioPlugin,
  scenario: Scenario,
  prompt: string,
  sandbox: ReturnType<typeof createSandbox>,
  opencodeHarness: Awaited<ReturnType<typeof createOpenCodeHarness>> | null,
): Promise<{ context: string; refs: string[] }> {
  if (plugin === "claude") {
    const result = runClaudeHook(["curate-prompt"], {
      input: JSON.stringify({ session_id: `t3-${scenario.id}`, prompt }),
      env: sandbox.env,
    })
    return parseInjectedRefs(result.stdout)
  }
  if (!opencodeHarness) throw new Error("opencode harness not initialized")
  const r = await opencodeHarness.curateAndExtract({
    sessionID: `t3-oc-${scenario.id}`,
    prompt,
  })
  return { context: r.context, refs: r.refs }
}

export async function runScenario(
  scenario: Scenario,
  plugin: ScenarioPlugin,
  options: RunScenarioOptions = {},
): Promise<ScenarioRun> {
  const stashDir = path.join(EVALS_ROOT, "fixtures/stash")
  const agentMode = pickAgentMode(options.agentMode)
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const transcript: TranscriptTurn[] = []
  const feedbackEmitted: Array<{ ref: string; sentiment: "positive" | "negative" }> = []
  let injectedContextChars = 0
  let curatedRefs: string[] = []
  let error: string | undefined
  let agentCostUsd: number | undefined
  let agentTokens: ScenarioRun["agentTokens"] | undefined
  let agentTurns: number | undefined
  let agentStopReason: string | undefined

  const sandbox = createSandbox({ sourceStash: stashDir })
  let opencodeHarness: Awaited<ReturnType<typeof createOpenCodeHarness>> | null = null
  try {
    if (plugin === "opencode") {
      opencodeHarness = await createOpenCodeHarness(sandbox.env)
    }

    for (const turn of scenario.user_turns) {
      transcript.push({ type: "user", content: turn.content })
      const { context, refs } = await curateForTurn(plugin, scenario, turn.content, sandbox, opencodeHarness)
      injectedContextChars += context.length
      curatedRefs = [...new Set([...curatedRefs, ...refs])]

      if (agentMode === "real") {
        const { runClaudeAgent } = await loadClaudeAgent()
        const agentResult = await runClaudeAgent(context, turn.content, {
          env: sandbox.env,
          budgetUsd: options.agentBudgetUsd ?? 0.50,
          model: options.agentModel,
        })
        // The agent already emits its own injected_context turn — drop
        // it to avoid duplicating, then merge the rest of its
        // transcript.
        const agentExtra = agentResult.transcript.filter((t) => t.type !== "user" && t.type !== "injected_context")
        // Re-stamp injected_context with the actual plugin name (the
        // agent always emits "claude" since it doesn't know which
        // plugin produced the context).
        transcript.push({ type: "injected_context", plugin, chars: context.length, refs, body: context })
        for (const t of agentExtra) transcript.push(t)
        for (const fb of agentResult.feedbackEmitted) feedbackEmitted.push({ ref: fb.ref, sentiment: fb.sentiment })
        agentCostUsd = (agentCostUsd ?? 0) + agentResult.costUsd
        agentTokens = {
          input: (agentTokens?.input ?? 0) + agentResult.inputTokens,
          output: (agentTokens?.output ?? 0) + agentResult.outputTokens,
          cacheRead: (agentTokens?.cacheRead ?? 0) + agentResult.cacheReadInputTokens,
          cacheWrite: (agentTokens?.cacheWrite ?? 0) + agentResult.cacheCreationInputTokens,
        }
        agentTurns = (agentTurns ?? 0) + agentResult.turns
        agentStopReason = agentResult.stopReason
        if (agentResult.error) {
          error = agentResult.error
          break
        }
      } else {
        // Stub agent — labeled clearly. This is a smoke-test fallback;
        // it mechanically projects the scenario expectations into a
        // transcript and is NOT a substitute for the real-agent loop.
        transcript.push({ type: "injected_context", plugin, chars: context.length, refs, body: context })
        for (const expectedRef of scenario.expectations.must_curate_refs ?? []) {
          if (!refs.includes(expectedRef)) continue
          transcript.push({ type: "tool_use", tool: "bash", ref: expectedRef, args: { command: `akm show ${expectedRef}` } })
          transcript.push({ type: "tool_result", tool: "bash", ok: true, output: `{"ok":true,"ref":"${expectedRef}"}` })
          // Honor the same skip rule the plugins enforce: no auto-feedback
          // on memory: or vault: refs. (Real agent learns this from its
          // system prompt; stub gets it hardcoded so the transcript
          // matches what the real plugins would actually emit.)
          const skipFeedback = expectedRef.startsWith("memory:") || expectedRef.startsWith("vault:")
          if (skipFeedback) continue
          if (plugin === "claude") {
            runClaudeHook(["auto-feedback", "success"], {
              input: JSON.stringify({
                tool: "Bash",
                input: { command: `akm show ${expectedRef}` },
                output: `{"ok":true,"ref":"${expectedRef}"}`,
              }),
              env: sandbox.env,
            })
          } else if (opencodeHarness) {
            await opencodeHarness.toolAfter({
              sessionID: `t3-oc-${scenario.id}`,
              tool: "akm_show",
              toolArgs: { ref: expectedRef },
              output: `{"ok":true,"ref":"${expectedRef}"}`,
            })
          }
          feedbackEmitted.push({ ref: expectedRef, sentiment: "positive" })
          transcript.push({ type: "feedback", ref: expectedRef, sentiment: "positive", note: "stub: showed ref" })
        }
        transcript.push({
          type: "agent_summary",
          text: `[stub agent] Curated refs available: ${refs.join(", ") || "none"}.`,
        })
      }
    }
  } catch (err) {
    error = (err as Error).message
  } finally {
    sandbox.cleanup()
  }

  return {
    scenarioId: scenario.id,
    plugin,
    agentMode,
    startedAt,
    durationMs: Math.round(performance.now() - start),
    transcript,
    injectedContextChars,
    curatedRefs,
    feedbackEmitted,
    agentCostUsd,
    agentTokens,
    agentTurns,
    agentStopReason,
    error,
  }
}
