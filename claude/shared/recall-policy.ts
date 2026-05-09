export type RecallDecision = {
  shouldRecall: boolean
  reason:
    | "explicit-akm"
    | "long-prompt"
    | "memory-intent"
    | "workflow-intent"
    | "agent-dispatch"
    | "command-dispatch"
    | "wiki-intent"
    | "proposal-intent"
    | "release-intent"
    | "coding-task"
    | "active-workflow"
    | "recent-asset-failure"
    | "skip-short"
    | "skip-chitchat"
    | "skip-low-signal"
  query: string
  scopeHints?: string[]
}

const REF_RE = /(?:skill|command|agent|knowledge|workflow|lesson|wiki|memory|vault):[A-Za-z0-9._/-]+/i

export function shouldRecall(prompt: string, options?: { activeWorkflow?: boolean; recentAssetFailure?: boolean }): RecallDecision {
  const text = prompt.trim()
  const lower = text.toLowerCase()
  const scopeHints: string[] = []
  if (!text) return { shouldRecall: false, reason: "skip-low-signal", query: "", scopeHints }
  if (options?.activeWorkflow) return { shouldRecall: true, reason: "active-workflow", query: text, scopeHints: ["workflow"] }
  if (options?.recentAssetFailure) return { shouldRecall: true, reason: "recent-asset-failure", query: text, scopeHints }
  if (text.length < 4 || /^(ok|thanks|thank you|yes|no|continue|go ahead|sure|cool)$/i.test(lower)) {
    return { shouldRecall: false, reason: "skip-short", query: text, scopeHints }
  }
  if (/\b(hi|hello|how are you|good morning|good night)\b/i.test(lower) && text.length < 40) {
    return { shouldRecall: false, reason: "skip-chitchat", query: text, scopeHints }
  }
  if (/\bakm\b|\bstash\b/.test(lower) || REF_RE.test(text)) {
    return { shouldRecall: true, reason: "explicit-akm", query: text, scopeHints: ["akm"] }
  }
  if (/\b(remember|memory|prior session|previous decision)\b/.test(lower)) {
    return { shouldRecall: true, reason: "memory-intent", query: text, scopeHints: ["memory"] }
  }
  if (/\b(workflow|resume|complete step|next step|blocked step)\b/.test(lower)) {
    return { shouldRecall: true, reason: "workflow-intent", query: text, scopeHints: ["workflow"] }
  }
  if (/\b(dispatch|agent|subagent|reviewer|planner|curator)\b/.test(lower)) {
    return { shouldRecall: true, reason: "agent-dispatch", query: text, scopeHints: ["agent"] }
  }
  if (/\b(command|slash command|run the stash command)\b/.test(lower)) {
    return { shouldRecall: true, reason: "command-dispatch", query: text, scopeHints: ["command"] }
  }
  if (/\b(wiki|docs|knowledge base|ingest|lint)\b/.test(lower)) {
    return { shouldRecall: true, reason: "wiki-intent", query: text, scopeHints: ["wiki"] }
  }
  if (/\b(proposal|accept|reject|diff proposal|review proposals)\b/.test(lower)) {
    return { shouldRecall: true, reason: "proposal-intent", query: text, scopeHints: ["proposal"] }
  }
  if (/\b(release|publish|semver|version bump|bump version|tag the release|cut a release)\b/.test(lower)) {
    return { shouldRecall: true, reason: "release-intent", query: text, scopeHints: ["workflow", "command"] }
  }
  if (
    text.length >= 16
    && /\b(review|pull request|\bpr\b|diff|refactor|type hints|typing|readability|readable|debug|diagnose|traceback|exception|exceptions|scaffold|unit test|tests|test|changelog|release notes|deployment|deploy|rollback|runbook|error code|healthcheck|linters|lint|format|formatting|naming conventions|convention|style guide|onboarding|new hire|new engineer|api keys|secrets|plan|design|architecture|tradeoffs|build|implement|fix|update)\b/.test(lower)
  ) {
    return { shouldRecall: true, reason: "coding-task", query: text, scopeHints: ["code"] }
  }
  if (text.length >= 120) return { shouldRecall: true, reason: "long-prompt", query: text, scopeHints }
  return { shouldRecall: false, reason: "skip-low-signal", query: text, scopeHints }
}
