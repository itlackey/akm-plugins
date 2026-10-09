// Automatic learning proposals for the OpenCode plugins (V1 `akm-opencode`, V2
// `akm-opencode-v2`): a user message that is a correction, preference or standing
// instruction, or a workflow they keep repeating, becomes a PROPOSAL in akm's
// review queue (`akm proposal new`). Nothing here writes a memory or accepts
// anything: AKM owns the proposal and its review, and accepting one needs the
// user's explicit approval. Also the pending-proposal nag shown to the model.
//
// The detection and consent policy lives in claude/shared/learning-signals.ts and
// is shared with the Claude hook; this module is the OpenCode wiring around it.
// Version-neutral: the entrypoint passes its log sink, its resolved `akm`, and
// the session-buffer hook, and nothing here writes to the console.
import { spawn } from "node:child_process"
import path from "node:path"
import {
  type ProposalCandidate,
  appendCapturedLearningSignal,
  captureLearningSignal,
  createLearningProposalJob,
  observeRecurringWorkflow,
  recordLearningProposalStatus,
  removeLearningProposalJob,
  reserveLearningProposal,
} from "../claude/shared/learning-signals"
import { type CliError, type ResolvedAkmCommand, isCliError } from "./akm-cli"
import { type EventWriter, buildEventScope, opencodeEventLog, opencodeStateDir } from "./events"
import { parseToolOutput, type SessionBufferEntry } from "./feedback"
import { AKM_EXTRACT_OUTPUT_MAX_CHARS, truncateLogText, unrefChildStream } from "./recall"

export type LearningLog = (level: "debug" | "info" | "warn" | "error", message: string, extra: Record<string, unknown>) => void

const autoLearningEnabled = (): boolean => (process.env.AKM_AUTO_LEARNING ?? "1") !== "0"
const autoSkillProposalsEnabled = (): boolean => (process.env.AKM_AUTO_SKILL_PROPOSALS ?? "1") !== "0"
const proposalTimeoutMs = (): number => Math.max(1_000, Number(process.env.AKM_LEARNING_PROPOSAL_TIMEOUT_MS ?? "600000") || 600_000)

function learningProposalMinConfidence(): number {
  const raw = Number(process.env.AKM_LEARNING_PROPOSAL_MIN_CONFIDENCE ?? "0.75")
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.75
}

function parseLearningProposalEnvelope(raw: string): {
  ok?: boolean
  ref?: string
  proposalId?: string
  error?: string
} {
  const parsed = parseToolOutput(raw) as {
    ok?: unknown
    ref?: unknown
    error?: unknown
    proposal?: { id?: unknown; ref?: unknown }
  } | undefined
  if (!parsed || typeof parsed !== "object") return {}
  return {
    ...(typeof parsed.ok === "boolean" ? { ok: parsed.ok } : {}),
    ...(typeof parsed.ref === "string"
      ? { ref: parsed.ref }
      : typeof parsed.proposal?.ref === "string"
        ? { ref: parsed.proposal.ref }
        : {}),
    ...(typeof parsed.proposal?.id === "string" ? { proposalId: parsed.proposal.id } : {}),
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
  }
}

export type LearningHost = {
  log: LearningLog
  writeEvent: EventWriter
  resolveCommand: () => ResolvedAkmCommand | CliError
  formatError: (error: unknown) => string
  /** Records the captured signal in the session buffer (same buffer the feedback tracker keeps). */
  addBufferEntry: (sessionID: string | undefined, entry: Omit<SessionBufferEntry, "timestamp">) => void
  /** A proposal was queued: the pending-proposal count for this session is stale. */
  onSubmitted?: (sessionID: string | undefined) => void
}

export function createLearning(host: LearningHost) {
  /** Fire-and-forget semantic authoring; AKM owns the proposal and its review. */
  function submitLearningProposal(candidate: ProposalCandidate, directory: string | undefined): void {
    if (!autoLearningEnabled() || candidate.confidence < learningProposalMinConfidence()) return
    const command = host.resolveCommand()
    if (isCliError(command)) {
      host.log("warn", "AKM learning proposal skipped", {
        subsystem: "learning",
        sessionID: candidate.sessionId,
        directory,
        kind: candidate.kind,
        error: command.error,
      })
      return
    }
    const stateDir = opencodeStateDir()
    const reservation = reserveLearningProposal(stateDir, candidate)
    if (!reservation) return
    let jobFile = ""
    let taskFile = ""
    let settled = false
    const finish = (
      status: "submitted" | "failed",
      result: { ref?: string; proposalId?: string; error?: string },
    ): void => {
      if (settled) return
      settled = true
      recordLearningProposalStatus({
        stateDir,
        candidate,
        reservation,
        status,
        ...(result.ref ? { ref: result.ref } : {}),
        ...(result.proposalId ? { proposalId: result.proposalId } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
      removeLearningProposalJob(jobFile, taskFile)
      if (status === "submitted") host.onSubmitted?.(candidate.sessionId)
      host.writeEvent({
        event: "learning_proposal",
        sessionId: candidate.sessionId,
        project: candidate.project,
        scope: buildEventScope(candidate.sessionId, directory),
        input: {
          kind: candidate.kind,
          confidence: candidate.confidence,
          proposalType: reservation.proposalType,
          proposalName: reservation.proposalName,
        },
        refs: result.ref ? [result.ref] : undefined,
        outcome: status === "submitted"
          ? { status: "ok" }
          : { status: "failed", error: result.error ?? "proposal submission failed" },
      })
      host.log(status === "submitted" ? "info" : "warn", `AKM learning proposal ${status}`, {
        subsystem: "learning",
        sessionID: candidate.sessionId,
        directory,
        kind: candidate.kind,
        proposalType: reservation.proposalType,
        proposalName: reservation.proposalName,
        ref: result.ref,
        proposalId: result.proposalId,
        error: result.error,
      })
    }

    try {
      const created = createLearningProposalJob({
        stateDir,
        command: command.command,
        argsPrefix: command.argsPrefix,
        candidate,
        reservation,
        logFile: path.join(stateDir, "learning-proposals.log"),
        eventLog: opencodeEventLog(),
      })
      jobFile = created.jobFile
      taskFile = created.job.taskFile
      const timeoutMs = proposalTimeoutMs()
      const child = spawn(
        command.command,
        [
          ...command.argsPrefix,
          "proposal",
          "new",
          reservation.proposalType,
          reservation.proposalName,
          "--file",
          taskFile,
          "--format",
          "json",
          "-q",
          "--timeout-ms",
          String(timeoutMs),
        ],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
        },
      )
      let stdout = ""
      let stderr = ""
      for (const [stream, channel] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) {
        if (!stream) continue
        unrefChildStream(stream)
        stream.setEncoding("utf8")
        stream.on("data", (chunk: string) => {
          if (channel === "stdout" && stdout.length < AKM_EXTRACT_OUTPUT_MAX_CHARS) stdout += chunk
          if (channel === "stderr" && stderr.length < AKM_EXTRACT_OUTPUT_MAX_CHARS) stderr += chunk
        })
        stream.on("error", () => {})
      }
      child.on("close", (code, signal) => {
        const stdoutBody = stdout.trim().slice(0, AKM_EXTRACT_OUTPUT_MAX_CHARS)
        const stderrBody = stderr.trim().slice(0, AKM_EXTRACT_OUTPUT_MAX_CHARS)
        const stdoutEnvelope = parseLearningProposalEnvelope(stdoutBody)
        const envelope = stdoutEnvelope.ok === undefined && !stdoutEnvelope.error
          ? parseLearningProposalEnvelope(stderrBody)
          : stdoutEnvelope
        const failed = envelope.ok !== true || (typeof code === "number" && code !== 0) || !!signal
        if (failed) {
          finish("failed", {
            error: envelope.error
              || stderrBody
              || (signal ? `akm proposal new exited via signal ${signal}` : `akm proposal new exited with code ${code}`),
          })
        } else {
          finish("submitted", envelope)
        }
      })
      child.on("error", (error) => finish("failed", { error: host.formatError(error) }))
      child.unref()
    } catch (error: unknown) {
      finish("failed", { error: host.formatError(error) })
    }
  }

  /**
   * One user message: record a learning signal if it is one, queue a proposal
   * for it when it is confident enough, and watch for a recurring workflow.
   * Never throws.
   */
  function capturePromptLearning(
    text: string,
    sessionID: string | undefined,
    project: string,
    directory: string | undefined,
  ): void {
    if (!autoLearningEnabled()) return
    const stateDir = opencodeStateDir()
    const signal = captureLearningSignal({
      text,
      harness: "opencode",
      project,
      ...(sessionID ? { sessionId: sessionID } : {}),
    })
    if (signal) {
      try {
        appendCapturedLearningSignal(stateDir, signal)
        host.addBufferEntry(sessionID, {
          kind: "learning-signal",
          status: signal.sentiment === "positive" ? "positive" : "negative",
          note: truncateLogText(signal.message, 500),
        })
        host.writeEvent({
          event: "learning_signal",
          sessionId: sessionID,
          project,
          scope: buildEventScope(sessionID, directory),
          input: {
            kind: signal.kind,
            confidence: signal.confidence,
            patterns: signal.patterns,
            proposalType: signal.proposalType ?? null,
            evidence: signal.message,
          },
          outcome: { status: signal.proposalType ? "ok" : "skipped" },
        })
      } catch (error: unknown) {
        host.log("warn", "AKM learning signal capture failed", {
          subsystem: "learning",
          sessionID,
          directory,
          error: host.formatError(error),
        })
      }
      if (signal.proposalType) submitLearningProposal(signal, directory)
    }

    if (!autoSkillProposalsEnabled()) return
    try {
      const workflow = observeRecurringWorkflow({
        stateDir,
        text,
        harness: "opencode",
        project,
        ...(sessionID ? { sessionId: sessionID } : {}),
        ...(signal ? { signal } : {}),
      })
      if (workflow) submitLearningProposal(workflow, directory)
    } catch (error: unknown) {
      host.log("warn", "AKM recurring-workflow capture failed", {
        subsystem: "learning",
        sessionID,
        directory,
        error: host.formatError(error),
      })
    }
  }

  return { capturePromptLearning }
}

// --- the pending-proposal nag ---------------------------------------------------

const PROPOSED_QUALITY_WARNING = "Do not treat proposed assets as curated until accepted."
const PENDING_CACHE_MS = 60_000

export function formatPendingProposalContext(count: number): string {
  const summaryLine = count === 1 ? "There is 1 pending AKM proposal." : `There are ${count} pending AKM proposals.`
  return [
    "# AKM pending proposals",
    "",
    summaryLine,
    "Use the AKM CLI to review them; mutating proposal actions require explicit user approval.",
    PROPOSED_QUALITY_WARNING,
  ].join("\n")
}

export type PendingProposals = ReturnType<typeof createPendingProposals>

/**
 * How many proposals await review, cached for a minute per session. `list` runs
 * `akm proposal list --status pending --format json` (the host picks sync or
 * async) and returns its stdout; a failure caches "none" so a broken or old akm
 * costs one attempt a minute, and an error that reads as an unsupported verb
 * switches the nag off.
 */
export function createPendingProposals(options: {
  list: (args: string[]) => Promise<string>
  formatError: (error: unknown) => string
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const cache = new Map<string, { count: number; expiresAt: number; unsupported?: boolean }>()

  async function count(sessionID?: string): Promise<{ count: number; unsupported?: boolean }> {
    const cacheKey = sessionID ?? "global"
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt > now()) return cached
    try {
      // AKM 0.9.14 canonical proposal-queue listing path: `akm proposal list`.
      const stdout = await options.list(["proposal", "list", "--status", "pending", "--format", "json"])
      const parsed = parseToolOutput(stdout) as { proposals?: unknown[] } | undefined
      const result = { count: Array.isArray(parsed?.proposals) ? parsed.proposals.length : 0, expiresAt: now() + PENDING_CACHE_MS }
      cache.set(cacheKey, result)
      return result
    } catch (error: unknown) {
      const unsupported = /unknown|unsupported|not found|invalid/i.test(options.formatError(error))
      const result = { count: 0, unsupported, expiresAt: now() + PENDING_CACHE_MS }
      cache.set(cacheKey, result)
      return result
    }
  }

  return {
    count,
    /** Text for the system context, or "" when nothing is pending. */
    async contextBlock(sessionID?: string): Promise<string> {
      const summary = await count(sessionID)
      return !summary.unsupported && summary.count > 0 ? formatPendingProposalContext(summary.count) : ""
    },
    invalidate: (sessionID: string | undefined): void => void cache.delete(sessionID ?? "global"),
  }
}
