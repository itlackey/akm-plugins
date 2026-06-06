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
