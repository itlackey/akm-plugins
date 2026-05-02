// Judge rubric. Defines the dimensions the LLM judge scores each
// scenario run on, and the JSON schema the judge must populate via
// structured outputs.

export type RubricScore = {
  asset_use: number       // 0-3: did the agent reference/invoke the curated assets?
  on_task: number         // 0-3: did the agent complete the user's stated request?
  feedback_loop: number   // 0-3: did it record akm feedback when warranted?
  hallucination: number   // 0-3 (3=no hallucinations, 0=many invented refs)
  conciseness: number     // 0-3: token efficiency vs minimum needed
  overall: number         // 0-3: judge's holistic score
  justification: string   // ≤200 chars
}

export type Rubric = {
  name: "default" | "strict"
  systemPrompt: string
  responseSchema: {
    name: string
    description: string
    input_schema: Record<string, unknown>
  }
}

const baseSchema = {
  type: "object",
  properties: {
    asset_use: { type: "integer", minimum: 0, maximum: 3, description: "Did the agent reference/invoke curated assets?" },
    on_task: { type: "integer", minimum: 0, maximum: 3, description: "Did the agent complete the user's stated request?" },
    feedback_loop: { type: "integer", minimum: 0, maximum: 3, description: "Did it record akm feedback when warranted?" },
    hallucination: { type: "integer", minimum: 0, maximum: 3, description: "3=no hallucinations, 0=many invented refs" },
    conciseness: { type: "integer", minimum: 0, maximum: 3, description: "Token efficiency vs the minimum needed." },
    overall: { type: "integer", minimum: 0, maximum: 3, description: "Holistic score." },
    justification: { type: "string", maxLength: 200, description: "One-line rationale." },
  },
  required: ["asset_use", "on_task", "feedback_loop", "hallucination", "conciseness", "overall", "justification"],
}

const DEFAULT_SYSTEM = `You are an objective evaluator scoring an agent's behavior on a tool-augmented task.

You are given:
1. The scenario's user goal and the expected behavior (must-curate refs, must-record feedback, forbidden refs).
2. The full transcript of one run, including injected context, tool uses, tool results, and feedback signals.

Score the run on each rubric dimension on a 0–3 scale:
- 0 = absent / wrong
- 1 = partial / weak
- 2 = good with minor gaps
- 3 = excellent

Be strict. Do not award partial credit for behaviors that are clearly absent. The goal is to detect regressions across plugin versions, so noise must be minimized.

Use the score_run tool to record your verdict. Always populate every field. The justification must be ≤200 chars and reference concrete behaviors (e.g., "surfaced skill:code-review and recorded positive feedback").`

const STRICT_SYSTEM = `${DEFAULT_SYSTEM}

In strict mode, additionally penalize:
- Any forbidden ref appearing in the injected context (subtract 1 from overall).
- Any expected feedback that was not recorded (cap feedback_loop at 1).
- Token usage that exceeds max_total_tokens by more than 25% (cap conciseness at 1).`

export const RUBRICS: Record<string, Rubric> = {
  default: {
    name: "default",
    systemPrompt: DEFAULT_SYSTEM,
    responseSchema: {
      name: "score_run",
      description: "Record the rubric scores for the scenario run.",
      input_schema: baseSchema,
    },
  },
  strict: {
    name: "strict",
    systemPrompt: STRICT_SYSTEM,
    responseSchema: {
      name: "score_run",
      description: "Record the rubric scores for the scenario run, with strict penalties.",
      input_schema: baseSchema,
    },
  },
}

export function getRubric(name: "default" | "strict"): Rubric {
  return RUBRICS[name] ?? RUBRICS.default
}
