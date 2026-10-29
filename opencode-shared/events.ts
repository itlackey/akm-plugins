// Structured memory-event ledger shared by the OpenCode plugins (V1 `akm-opencode`,
// V2 `akm-opencode-v2`). Both write the same `opencode` harness ledger, so one
// install's analysis tools read either. No console output: a failed append is a
// returned value the caller logs.
import { type AkmMemoryEvent, appendMemoryEvent, getEventLogPath, getHarnessStateDir } from "../claude/shared/memory-events"

// Resolved per call, not at import: XDG_STATE_HOME is the operator's (and the
// tests') to redirect, and one process may load this module before it does.
export const opencodeEventLog = (): string => getEventLogPath("opencode")
export const opencodeStateDir = (): string => getHarnessStateDir("opencode")

export type MemoryEventInput = Omit<AkmMemoryEvent, "version" | "timestamp" | "harness">
export type EventWriteResult = ReturnType<typeof appendMemoryEvent>
export type EventWriter = (event: MemoryEventInput) => EventWriteResult

export function buildEventScope(sessionID?: string, directory?: string, agent?: string) {
  return {
    user: process.env.AKM_USER_ID,
    agent,
    run: sessionID,
    channel: process.env.AKM_CHANNEL,
    project: directory,
    repo: process.env.AKM_REPO,
    branch: process.env.AKM_BRANCH,
  }
}

export function writeOpencodeEvent(event: MemoryEventInput): EventWriteResult {
  return appendMemoryEvent(opencodeEventLog(), {
    version: 1,
    timestamp: new Date().toISOString(),
    harness: "opencode",
    ...event,
  })
}
