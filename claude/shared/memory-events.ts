import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { redactObject } from "./redaction"

// Memory events log session activity (refs touched, outcomes, scope). Even
// post-redaction this is a privileged record; lock the directory + file down
// to owner-only access. Mirrors memory-candidates' chmodSafe helper.
function chmodSafe(target: string, mode: number): void {
  try {
    chmodSync(target, mode)
  } catch {
    // Best-effort; see memory-candidates.ts for rationale.
  }
}

// State-file rotation/caps (release-0.9.0 review §2 "Unbounded state
// growth"): events.jsonl is append-only from both the Claude hook and the
// OpenCode plugin and previously had no cap. Mirrors the mechanism in
// claude/hooks/akm-hook.ts's rotateLogIfOversized(): before an append, if the
// file already exceeds AKM_PLUGIN_MAX_LOG_BYTES (default 1 MiB), rewrite it
// down to its newest half (by line count) via write-temp-then-rename so a
// concurrent reader/writer never observes a truncated file.
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
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmpPath, keep.length > 0 ? `${keep.join("\n")}\n` : "")
    chmodSafe(tmpPath, 0o600)
    renameSync(tmpPath, filePath)
  } catch {
    // Rotation is best-effort and must never throw: a failed attempt just
    // means the file keeps growing until the next successful append/rotate.
  }
}

export type AkmMemoryEventType =
  | "session_started"
  | "prompt_recall"
  | "tool_observation"
  | "tool_batch_observation"
  | "tool_ref_observed"
  | "workflow_step"
  | "workflow_started"
  | "workflow_next_loaded"
  | "workflow_step_completed"
  | "workflow_step_blocked"
  | "workflow_step_failed"
  | "workflow_step_skipped"
  | "workflow_evidence_attached"
  | "workflow_drift_detected"
  | "workflow_resumed"
  | "workflow_abandoned"
  | "task_created"
  | "task_completed"
  | "subagent_started"
  | "subagent_completed"
  | "pre_compact_checkpoint"
  | "post_compact_summary"
  | "session_ended"
  | "candidate_extracted"
  | "candidate_promoted"
  | "candidate_rejected"
  | "durable_memory_written"
  | "feedback_recorded"
  | "safety_blocked"

export type AkmMemoryEvent = {
  version: 1
  timestamp: string
  harness: "claude-code" | "opencode"
  event: AkmMemoryEventType
  eventId?: string
  sessionId?: string
  project?: string
  agent?: string
  workflowRunId?: string
  scope?: {
    user?: string
    agent?: string
    run?: string
    channel?: string
    project?: string
    repo?: string
    branch?: string
  }
  input?: Record<string, unknown>
  memory?: Record<string, unknown>
  refs?: string[]
  outcome?: {
    status: "ok" | "skipped" | "blocked" | "failed"
    warnings?: string[]
    error?: string
  }
  redaction?: {
    redacted: boolean
    categories: string[]
  }
}

export function getHarnessStateDir(harness: "claude-code" | "opencode"): string {
  const root = process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? ".", ".local", "state")
  return path.join(root, harness === "claude-code" ? "akm-claude" : "akm-opencode")
}

export function getEventLogPath(harness: "claude-code" | "opencode"): string {
  return path.join(getHarnessStateDir(harness), "events.jsonl")
}

export function appendMemoryEvent(filePath: string, event: AkmMemoryEvent): { ok: true; redacted: boolean; categories: string[] } | { ok: false; error: string } {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    chmodSafe(path.dirname(filePath), 0o700)
    rotateIfOversized(filePath)
    const redacted = redactObject(event)
    const enriched = {
      ...redacted.value,
      redaction: {
        redacted: redacted.redacted,
        categories: redacted.categories,
      },
    }
    const created = !existsSync(filePath)
    appendFileSync(filePath, `${JSON.stringify(enriched)}\n`)
    if (created) chmodSafe(filePath, 0o600)
    return { ok: true, redacted: redacted.redacted, categories: redacted.categories }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}
