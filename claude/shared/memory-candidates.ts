import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { redactObject } from "./redaction"

// Memory candidates can contain prompt fragments, ref names, and (despite
// redaction) potentially sensitive contextual data harvested from session
// activity. Lock the on-disk file down to user-only read/write so multi-user
// hosts (CI runners, shared VMs, dev sandboxes) cannot side-read another
// user's stash signals.
function chmodSafe(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode)
  } catch {
    // Best-effort: filesystems without POSIX mode (FAT, some FUSE mounts) or
    // platforms where chmod is a no-op (Windows) silently skip. Don't crash
    // the hook over a hardening attempt.
  }
}

// Write a file atomically: temp file in the same directory, then rename over
// the target. rename(2) is atomic on POSIX (and on Windows via Node's
// implementation), so a concurrent reader always observes either the old
// content in full or the new content in full — never a torn/partial write.
// Used both by the size-cap rotation below and by replaceCandidates() (13:
// "Non-atomic candidate updates" — updateCandidateStatus() used to
// read-modify-write straight over the target file with no temp+rename,
// so a concurrent hook process's appendCandidates() write landing mid-rewrite
// could be silently dropped).
function atomicWriteFileSync(filePath: string, content: string, mode?: number): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, content)
  if (mode !== undefined) chmodSafe(tmpPath, mode)
  renameSync(tmpPath, filePath)
}

// State-file rotation/caps (release-0.9.0 review §2 "Unbounded state
// growth"): memory-candidates.jsonl is append-only from both plugins and
// previously had no cap. Mirrors the mechanism in claude/hooks/akm-hook.ts's
// rotateLogIfOversized(): before an append, if the file already exceeds
// AKM_PLUGIN_MAX_LOG_BYTES (default 1 MiB), rewrite it down to its newest
// half (by line count) atomically.
const MAX_LOG_BYTES = (() => {
  const raw = Number(process.env.AKM_PLUGIN_MAX_LOG_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : 1024 * 1024
})()

function rotateIfOversized(filePath: string): void {
  try {
    const stat = statSync(filePath)
    if (stat.size <= MAX_LOG_BYTES) return
    const lines = readFileSync(filePath, "utf8").split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    const keep = lines.slice(Math.ceil(lines.length / 2))
    atomicWriteFileSync(filePath, keep.length > 0 ? `${keep.join("\n")}\n` : "", 0o600)
  } catch {
    // Rotation is best-effort and must never throw: a failed attempt just
    // means the file keeps growing until the next successful append/rotate.
  }
}

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

const AKM_REF_RE = /(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|script|workflow|env|secret|wiki|lesson):[A-Za-z0-9._/-]+/g

function uniq(values: string[]): string[] {
  return [...new Set(values)]
}

function pickTargetRef(refs: string[]): string | undefined {
  return refs.find((ref) => !ref.startsWith("memory:") && !ref.startsWith("env:") && !ref.startsWith("secret:")) ?? refs[0]
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
    chmodSafe(path.dirname(filePath), 0o700)
    rotateIfOversized(filePath)
    const categories: string[] = []
    const created = !existsSync(filePath)
    for (const candidate of candidates) {
      const redacted = redactObject(candidate)
      categories.push(...redacted.categories)
      appendFileSync(filePath, `${JSON.stringify(redacted.value)}\n`)
    }
    if (created) chmodSafe(filePath, 0o600)
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
  chmodSafe(path.dirname(filePath), 0o700)
  // Atomic rewrite (13: "Non-atomic candidate updates" — see
  // atomicWriteFileSync above). updateCandidateStatus() is a
  // read-modify-write over the whole file; without temp+rename, a second
  // hook process's appendCandidates() (a plain appendFileSync) landing
  // between this read and this write would be silently overwritten by this
  // rewrite once it lands, because writeFileSync truncates in place.
  // temp+rename doesn't fully eliminate that read-modify-write race (true
  // fix would need a lock), but it does guarantee the file itself is never
  // observed half-written / truncated by a concurrent reader.
  atomicWriteFileSync(filePath, candidates.map((candidate) => `${JSON.stringify(candidate)}\n`).join(""), 0o600)
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
