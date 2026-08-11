export type AkmFeedbackSignal = {
  ref: string
  polarity: "positive" | "negative"
  confidence: number
  source:
    | "explicit_user_feedback"
    | "tool_success"
    | "tool_failure"
    | "retrospective_positive"
    | "retrospective_negative"
    | "workflow_completion"
    | "proposal_acceptance"
    | "proposal_rejection"
    | "curator_assessment"
  note: string
  sessionId?: string
  harness: "claude-code" | "opencode"
}

/**
 * Retrospective feedback matchers. Both plugins classify a user message as
 * after-the-fact praise or complaint about assets the session already touched,
 * so the grammar lives here rather than in one harness: the two sides must
 * agree on what counts as a signal, or the same message produces opposite
 * verdicts depending on the harness.
 *
 * AKM_RETROSPECTIVE_FEEDBACK_PATTERN / AKM_RETROSPECTIVE_NEGATIVE_PATTERN let
 * an operator retune the vocabulary (other languages, project jargon). A
 * user-supplied pattern is untrusted input, so an invalid one falls back to the
 * default instead of throwing at module load and taking the plugin down with
 * it.
 */
export function createRetrospectiveFeedbackRegex(): RegExp {
  const pattern = process.env.AKM_RETROSPECTIVE_FEEDBACK_PATTERN ?? "\\b(thanks|perfect|worked)\\b"
  try {
    return new RegExp(pattern, "i")
  } catch {
    return /\b(thanks|perfect|worked)\b/i
  }
}

export function createRetrospectiveNegativeRegex(): RegExp {
  const pattern = process.env.AKM_RETROSPECTIVE_NEGATIVE_PATTERN ?? "\\b(wrong|failed|broken|didn't work|did not work|bad)\\b"
  try {
    return new RegExp(pattern, "i")
  } catch {
    return /\b(wrong|failed|broken|didn't work|did not work|bad)\b/i
  }
}

/**
 * Explicit corrections ("that was wrong") are a stronger, narrower signal than
 * the tunable negative matcher, so this one is deliberately not overridable.
 */
export function createExplicitCorrectionRegex(): RegExp {
  return /\b(this was wrong|that was wrong|you were wrong|incorrect|not correct)\b/i
}

export function getAutoFeedbackMinConfidence(): number {
  const raw = Number(process.env.AKM_AUTO_FEEDBACK_MIN_CONFIDENCE ?? "0.6")
  return Number.isFinite(raw) ? raw : 0.6
}

export function classifyFeedbackSignal(input: {
  ref: string
  polarity: "positive" | "negative"
  harness: "claude-code" | "opencode"
  sessionId?: string
  directInput?: boolean
  explicitUser?: boolean
  retrospective?: boolean
  workflowCompletion?: boolean
  proposalAction?: "accept" | "reject"
  curatorAssessment?: boolean
  note?: string
}): AkmFeedbackSignal {
  let source: AkmFeedbackSignal["source"] = input.polarity === "positive" ? "tool_success" : "tool_failure"
  let confidence = input.directInput ? 0.65 : 0.25

  if (input.explicitUser) {
    source = "explicit_user_feedback"
    confidence = 0.95
  } else if (input.retrospective) {
    source = input.polarity === "positive" ? "retrospective_positive" : "retrospective_negative"
    confidence = input.polarity === "positive" ? 0.7 : 0.8
  } else if (input.workflowCompletion) {
    source = "workflow_completion"
    confidence = 0.85
  } else if (input.proposalAction === "accept") {
    source = "proposal_acceptance"
    confidence = 0.95
  } else if (input.proposalAction === "reject") {
    source = "proposal_rejection"
    confidence = 0.85
  } else if (input.curatorAssessment) {
    source = "curator_assessment"
    confidence = 0.75
  }

  return {
    ref: input.ref,
    polarity: input.polarity,
    confidence,
    source,
    note: input.note ?? `${input.harness} auto: source=${source}; confidence=${confidence.toFixed(2)}`,
    sessionId: input.sessionId,
    harness: input.harness,
  }
}

export function shouldSubmitAutomaticFeedback(signal: AkmFeedbackSignal): boolean {
  return signal.confidence >= getAutoFeedbackMinConfidence()
}
