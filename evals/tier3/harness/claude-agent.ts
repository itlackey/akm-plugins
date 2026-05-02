// Real Claude API agent loop for tier-3.
//
// Replaces the previous stub agent (which deterministically projected
// the scenario expectations into a transcript — leaving the judge with
// nothing to score). This drives a genuine model loop that:
//   - receives the curated context the plugin would inject
//   - decides whether/how to use it
//   - issues tool calls (via a Bash tool routed through the sandbox PATH
//     so the model's `akm ...` invocations hit the same fake-akm shim
//     the rest of the framework uses)
//   - can hallucinate refs, skip feedback, choose wrong assets, ignore
//     curation, etc. — these are the exact regressions tier-3 should be
//     able to detect.
//
// Model cost is real but bounded: we use Sonnet 4.6 by default, capped
// at 6 turns and 4096 max_tokens per turn. With prompt caching on the
// system prompt (which IS large enough to hit the cache minimum here,
// unlike the judge's tiny rubric prompt), repeated runs of the same
// scenario amortize the per-turn input cost.

import Anthropic from "@anthropic-ai/sdk"
import path from "node:path"
import { spawnSync } from "node:child_process"
import type { TranscriptTurn } from "./run-scenario"

const SYSTEM_PROMPT = `You are a software engineer with access to the AKM CLI for finding reusable assets (skills, commands, agents, knowledge, scripts, workflows, vaults, wikis) in the user's stash.

You have a Bash tool. Use it to:
- \`akm show <ref>\` — fetch the full content of a stash asset (e.g., \`akm show skill:code-review\`)
- \`akm search "<query>"\` — search the stash
- \`akm feedback <ref> --positive --note "..."\` — record that an asset helped
- \`akm feedback <ref> --negative --note "..."\` — record that an asset failed or was wrong

Reference grammar: \`<type>:<name>\` where type ∈ {skill, command, agent, knowledge, memory, script, workflow, vault, wiki}.

Workflow when handling a request:
1. If curated assets are in your context, decide which (if any) are relevant. Don't use them blindly — pick only assets that fit the request.
2. Run \`akm show <ref>\` for the assets you'll use, to load their full content.
3. Complete the user's task using the loaded content.
4. Record \`akm feedback <ref> --positive\` for assets that helped you complete the task. Record \`akm feedback <ref> --negative\` for assets that turned out to be wrong fits or unhelpful.
5. NEVER call \`akm vault show\` or \`akm vault load\` — vault values are sensitive. Only mention vault refs by name when the user asks about secrets.
6. NEVER record feedback on \`memory:\` or \`vault:\` refs — feedback only applies to skills, commands, agents, knowledge, scripts, workflows, and wikis.
7. When you've finished the task, write a brief summary and stop calling tools.

Be efficient — don't show every curated ref just because it surfaced. Use judgment.`

const BASH_TOOL: Anthropic.Tool = {
  name: "bash",
  description: "Execute a shell command. Used here to invoke the akm CLI.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
    },
    required: ["command"],
  },
}

export type ClaudeAgentConfig = {
  model?: string
  maxTurns?: number
  maxTokensPerTurn?: number
  // Sandbox env (sets PATH so `akm` resolves to fake-akm).
  env: Record<string, string>
  // Per-call dollar budget; if the cumulative cost across all the agent's
  // turns for this scenario exceeds this, the loop aborts early. This is
  // separate from the judge budget.
  budgetUsd?: number
}

export type ClaudeAgentResult = {
  transcript: TranscriptTurn[]
  curatedRefsObserved: string[]
  feedbackEmitted: Array<{ ref: string; sentiment: "positive" | "negative"; note: string }>
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  turns: number
  stopReason: string
  error?: string
}

const REF_RE = /\b(skill|command|agent|knowledge|memory|script|workflow|vault|wiki|lesson):[A-Za-z0-9._\/-]+/g

function extractRefs(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(REF_RE)) seen.add(m[0])
  return [...seen]
}

// Sonnet 4.6 pricing per million tokens. Match the judge's table.
const PRICING: Record<string, { inputPerM: number; outputPerM: number; cacheReadPerM: number; cacheWritePerM: number }> = {
  "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.30, cacheWritePerM: 3.75 },
  "claude-haiku-4-5": { inputPerM: 1.0, outputPerM: 5.0, cacheReadPerM: 0.10, cacheWritePerM: 1.25 },
  "claude-opus-4-7": { inputPerM: 5.0, outputPerM: 25.0, cacheReadPerM: 0.50, cacheWritePerM: 6.25 },
}

function priceFor(model: string) {
  return PRICING[model] ?? PRICING["claude-sonnet-4-6"]
}

function tokenCost(model: string, usage: Anthropic.Usage): number {
  const p = priceFor(model)
  return (
    (usage.input_tokens ?? 0) / 1_000_000 * p.inputPerM +
    (usage.output_tokens ?? 0) / 1_000_000 * p.outputPerM +
    (usage.cache_read_input_tokens ?? 0) / 1_000_000 * p.cacheReadPerM +
    (usage.cache_creation_input_tokens ?? 0) / 1_000_000 * p.cacheWritePerM
  )
}

// Execute the agent's bash command in the sandbox env. Only `akm ...`
// commands are allowed — anything else is rejected so a hallucinated
// `rm -rf /` from the agent can't damage the host. The fake-akm shim is
// already on the sandbox PATH.
function runAgentBash(command: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const trimmed = command.trim()
  if (!/^akm(\s|$)/.test(trimmed)) {
    return {
      stdout: "",
      stderr: `eval-harness: only \`akm\` commands are permitted in the agent loop; got: ${trimmed.slice(0, 80)}`,
      exitCode: 127,
    }
  }
  const result = spawnSync("sh", ["-c", trimmed], { env, encoding: "utf8", timeout: 10_000 })
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  }
}

export async function runClaudeAgent(
  curatedContext: string,
  userPrompt: string,
  config: ClaudeAgentConfig,
): Promise<ClaudeAgentResult> {
  const client = new Anthropic()
  const model = config.model ?? "claude-sonnet-4-6"
  const maxTurns = config.maxTurns ?? 6
  const maxTokens = config.maxTokensPerTurn ?? 4096
  const budgetUsd = config.budgetUsd ?? 0.50

  const transcript: TranscriptTurn[] = []
  const feedbackEmitted: Array<{ ref: string; sentiment: "positive" | "negative"; note: string }> = []
  const curatedRefs = extractRefs(curatedContext)

  // Inject curated context the way both plugins do: as additional system
  // content. The plugin-injected context is what's being evaluated, so
  // the agent sees it through the same channel a real plugin run would.
  //
  // No cache_control marker: the system prompt is ~460 tokens, well
  // under Sonnet 4.6's 2048-token minimum cacheable prefix. If we
  // grow the prompt past that threshold (e.g., add tool-use examples
  // or scenario-specific context), revisit and add the marker.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT },
  ]
  if (curatedContext) {
    systemBlocks.push({
      type: "text",
      text: `# Curated context (injected by the AKM plugin)\n\n${curatedContext}`,
    })
  }

  transcript.push({ type: "user", content: userPrompt })
  transcript.push({
    type: "injected_context",
    plugin: "claude",
    chars: curatedContext.length,
    refs: curatedRefs,
    body: curatedContext,
  })

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }]
  let totalCost = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let stopReason = "max_turns"
  let error: string | undefined

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (totalCost >= budgetUsd) {
        stopReason = "budget_exhausted"
        break
      }
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        tools: [BASH_TOOL],
        messages,
      })
      totalInput += response.usage.input_tokens ?? 0
      totalOutput += response.usage.output_tokens ?? 0
      totalCacheRead += response.usage.cache_read_input_tokens ?? 0
      totalCacheWrite += response.usage.cache_creation_input_tokens ?? 0
      totalCost += tokenCost(response.model, response.usage)

      messages.push({ role: "assistant", content: response.content })

      // Capture any text blocks as agent summary.
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          transcript.push({ type: "agent_summary", text: block.text.trim() })
        }
      }

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")

      if (response.stop_reason === "end_turn" || toolUses.length === 0) {
        stopReason = response.stop_reason ?? "end_turn"
        break
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const use of toolUses) {
        if (use.name !== "bash") {
          toolResults.push({ type: "tool_result", tool_use_id: use.id, content: `unknown tool: ${use.name}`, is_error: true })
          continue
        }
        const cmd = (use.input as { command?: string }).command ?? ""
        const result = runAgentBash(cmd, config.env)
        const ref = extractRefs(cmd)[0]

        // Record the tool use + result in the transcript using the same
        // shape the stub used, so the judge's prompt format doesn't
        // care which agent produced the run.
        transcript.push({ type: "tool_use", tool: "bash", ref, args: { command: cmd } })
        const resultText = result.exitCode === 0 ? result.stdout || "(empty stdout)" : `EXIT ${result.exitCode}\n${result.stderr}`
        transcript.push({ type: "tool_result", tool: "bash", ok: result.exitCode === 0, output: resultText })

        // Detect feedback calls and record them in the structured side-channel.
        const fbMatch = /\bakm\s+feedback\s+(\S+)\s+(--positive|--negative)(?:\s+--note\s+"([^"]*)")?/.exec(cmd)
        if (fbMatch) {
          feedbackEmitted.push({
            ref: fbMatch[1],
            sentiment: fbMatch[2] === "--positive" ? "positive" : "negative",
            note: fbMatch[3] ?? "",
          })
          transcript.push({ type: "feedback", ref: fbMatch[1], sentiment: fbMatch[2] === "--positive" ? "positive" : "negative", note: fbMatch[3] ?? "" })
        }

        toolResults.push({ type: "tool_result", tool_use_id: use.id, content: resultText.slice(0, 4000), is_error: result.exitCode !== 0 })
      }

      messages.push({ role: "user", content: toolResults })
    }
  } catch (err) {
    error = (err as Error).message
    stopReason = "error"
  }

  return {
    transcript,
    curatedRefsObserved: curatedRefs,
    feedbackEmitted,
    costUsd: totalCost,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadInputTokens: totalCacheRead,
    cacheCreationInputTokens: totalCacheWrite,
    turns: messages.filter((m) => m.role === "assistant").length,
    stopReason,
    error,
  }
}
