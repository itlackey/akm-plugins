import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { redactObject } from "./redaction"
// Memory events log session activity (refs touched, outcomes, scope). Even
// post-redaction this is a privileged record, so the directory + file are
// locked to owner-only and events.jsonl is size-capped like every other
// append-only state file. Both primitives live in ./state-files so the Claude
// hook, this module and ./memory-candidates share one implementation.
import { chmodSafe, rotateIfOversized } from "./state-files"

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
