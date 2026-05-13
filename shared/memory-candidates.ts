import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { redactObject } from "./redaction"

export type AkmMemoryCandidate = {
  id: string
  createdAt: string
  harness: "claude-code" | "opencode"
  sessionId?: string
  sourceEventIds?: string[]
  sourcePaths?: string[]
  type:
    | "preference"
    | "constraint"
    | "decision"
    | "lesson"
    | "workflow_state"
    | "asset_feedback"
    | "coverage_gap"
    | "stale_memory"
    | "unknown"
  scope: "user" | "project" | "repo" | "branch" | "session" | "agent" | "workflow"
  content: string
  evidence: string[]
  confidence: number
  recommendedAction: "remember" | "distill" | "propose" | "feedback" | "ignore"
  targetRef?: string
  status: "pending" | "promoted" | "rejected"
  reason?: string
}

const AKM_REF_RE = /(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|script|workflow|vault|wiki|lesson):[A-Za-z0-9._/-]+/g

function uniq(values: string[]): string[] {
  return [...new Set(values)]
}

function pickTargetRef(refs: string[]): string | undefined {
  return refs.find((ref) => !ref.startsWith("memory:") && !ref.startsWith("vault:")) ?? refs[0]
}

function extractRefs(value: string): string[] {
  return uniq(value.match(AKM_REF_RE) ?? [])
}

export function getCandidateLogPath(harness: "claude-code" | "opencode"): string {
  const root = process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? ".", ".local", "state")
  const dir = path.join(root, harness === "claude-code" ? "akm-claude" : "akm-opencode")
  return path.join(dir, "memory-candidates.jsonl")
}

function makeCandidateId(harness: string, sessionId: string | undefined, index: number): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
  const sid = (sessionId ?? "session").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 12) || "session"
  return `${harness}-${sid}-${stamp}-${index}`
}

function classifyCandidate(
  content: string,
  refs: string[],
): Pick<AkmMemoryCandidate, "type" | "scope" | "confidence" | "recommendedAction" | "targetRef"> {
  const text = content.toLowerCase()
  const targetRef = pickTargetRef(refs)
  if (targetRef && /\b(worked|helped|useful|failed|broken|wrong|didn't work|did not work)\b/.test(text)) {
    return { type: "asset_feedback", scope: "project", confidence: 0.72, recommendedAction: "feedback", targetRef }
  }
  if (/\b(always|never|must|should not|cannot|can't|do not|required)\b/.test(text)) {
    return { type: "constraint", scope: "project", confidence: 0.8, recommendedAction: "remember" }
  }
  if (/\b(prefer|likes|dislikes|wants|remember)\b/.test(text)) {
    return { type: "preference", scope: "user", confidence: 0.8, recommendedAction: "remember" }
  }
  if (/\b(decided|decision|use |chosen|architecture|approach)\b/.test(text)) {
    return { type: "decision", scope: "project", confidence: 0.75, recommendedAction: "remember" }
  }
  if (/\b(blocked|failed|workflow|next step|resume)\b/.test(text)) {
    return { type: "workflow_state", scope: "workflow", confidence: 0.7, recommendedAction: "remember" }
  }
  if (/\b(missing|coverage gap|todo|follow-up|followup)\b/.test(text)) {
    return { type: "coverage_gap", scope: "project", confidence: 0.65, recommendedAction: "propose" }
  }
  if (/\b(lesson|fix|worked|resolved|solution)\b/.test(text)) {
    return { type: "lesson", scope: "project", confidence: 0.7, recommendedAction: "distill", targetRef }
  }
  return { type: "unknown", scope: "session", confidence: 0.4, recommendedAction: "ignore" }
}

export function extractCandidatesFromText(input: {
  harness: "claude-code" | "opencode"
  sessionId?: string
  text: string
  evidence?: string[]
  sourceEventIds?: string[]
  sourcePaths?: string[]
  targetRefHints?: string[]
}): AkmMemoryCandidate[] {
  const lines = input.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 20)
    .filter((line) => !line.startsWith("#") && !line.startsWith("## "))

  const selected = lines.filter((line) => /\b(always|never|must|should|prefer|remember|decision|decided|workflow|blocked|failed|worked|fix|missing|follow-up|followup)\b/i.test(line))
  return selected.slice(0, 12).map((content, index) => {
    const contentRefs = extractRefs(content)
    const evidenceRefs = (input.evidence ?? []).flatMap(extractRefs)
    const hintedRefs = input.targetRefHints ?? []
    const refs = uniq([
      ...contentRefs,
      ...hintedRefs,
      ...evidenceRefs,
    ])
    const details = classifyCandidate(content, refs)
    const targetRef = details.targetRef ?? pickTargetRef([...contentRefs, ...hintedRefs, ...evidenceRefs])
    return {
      id: makeCandidateId(input.harness, input.sessionId, index + 1),
      createdAt: new Date().toISOString(),
      harness: input.harness,
      sessionId: input.sessionId,
      sourceEventIds: input.sourceEventIds,
      sourcePaths: input.sourcePaths ? uniq(input.sourcePaths) : undefined,
      type: details.type,
      scope: details.scope,
      content,
      evidence: uniq([...(input.evidence ?? []), content]),
      confidence: details.confidence,
      recommendedAction: details.recommendedAction,
      targetRef,
      status: "pending",
    }
  })
}

export function appendCandidates(filePath: string, candidates: AkmMemoryCandidate[]): { ok: true; count: number; categories: string[] } | { ok: false; error: string } {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const categories: string[] = []
    for (const candidate of candidates) {
      const redacted = redactObject(candidate)
      categories.push(...redacted.categories)
      appendFileSync(filePath, `${JSON.stringify(redacted.value)}\n`)
    }
    return { ok: true, count: candidates.length, categories: [...new Set(categories)] }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function readCandidates(filePath: string): AkmMemoryCandidate[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AkmMemoryCandidate]
      } catch {
        return []
      }
    })
}

export function replaceCandidates(filePath: string, candidates: AkmMemoryCandidate[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, candidates.map((candidate) => `${JSON.stringify(candidate)}\n`).join(""))
}

export function updateCandidateStatus(filePath: string, id: string, status: "promoted" | "rejected", reason?: string): AkmMemoryCandidate | undefined {
  const candidates = readCandidates(filePath)
  const index = candidates.findIndex((candidate) => candidate.id === id)
  if (index === -1) return undefined
  const updated = { ...candidates[index], status, reason }
  candidates[index] = updated
  replaceCandidates(filePath, candidates)
  return updated
}
