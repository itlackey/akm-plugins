#!/usr/bin/env bun

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { appendMemoryEvent } from "../shared/memory-events"
import {
  type LearningProposalJob,
  recordLearningProposalStatus,
  removeLearningProposalJob,
} from "../shared/learning-signals"
import { redactSecrets } from "../shared/redaction"
import { chmodSafe, rotateIfOversized } from "../shared/state-files"

const OUTPUT_LIMIT = 8_000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000

function appendWorkerLog(job: LearningProposalJob, status: string, detail: string): void {
  try {
    rotateIfOversized(job.logFile)
    const created = !existsSync(job.logFile)
    const redacted = redactSecrets(detail).text.replace(/[\r\n]+/g, " ").slice(0, OUTPUT_LIMIT)
    appendFileSync(job.logFile, `${new Date().toISOString()}\t${status}\t${job.reservation.key}\t${redacted}\n`)
    if (created) chmodSafe(job.logFile, 0o600)
  } catch {
    // A proposal result must never be turned into a hook/runtime failure by logging.
  }
}

function parseResult(raw: string): { ok?: boolean; ref?: string; proposalId?: string; error?: string } {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: unknown
      ref?: unknown
      error?: unknown
      proposal?: { id?: unknown; ref?: unknown }
    }
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
  } catch {
    return {}
  }
}

function emitOutcome(
  job: LearningProposalJob,
  status: "ok" | "failed",
  result: { ref?: string; proposalId?: string; error?: string },
): void {
  if (!job.eventLog) return
  appendMemoryEvent(job.eventLog, {
    version: 1,
    timestamp: new Date().toISOString(),
    harness: "claude-code",
    event: "learning_proposal",
    sessionId: job.candidate.sessionId,
    project: job.candidate.project,
    scope: {
      run: job.candidate.sessionId,
      project: job.candidate.project,
    },
    input: {
      kind: job.candidate.kind,
      confidence: job.candidate.confidence,
      proposalType: job.reservation.proposalType,
      proposalName: job.reservation.proposalName,
    },
    refs: result.ref ? [result.ref] : undefined,
    outcome: status === "ok"
      ? { status: "ok" }
      : { status: "failed", error: result.error ?? "proposal submission failed" },
  })
}

function run(): void {
  const jobFile = process.argv[2] ?? ""
  if (!jobFile) return
  let job: LearningProposalJob | undefined
  try {
    job = JSON.parse(readFileSync(jobFile, "utf8")) as LearningProposalJob
    if (job.version !== 1 || !job.command || !job.taskFile) return
    const timeoutRaw = Number(process.env.AKM_LEARNING_PROPOSAL_TIMEOUT_MS)
    const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS
    const child = spawnSync(
      job.command,
      [
        ...job.argsPrefix,
        "proposal",
        "new",
        job.reservation.proposalType,
        job.reservation.proposalName,
        "--file",
        job.taskFile,
        "--format",
        "json",
        "-q",
        "--timeout-ms",
        String(timeout),
      ],
      {
        encoding: "utf8",
        timeout,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      },
    )
    const stdout = typeof child.stdout === "string" ? child.stdout.trim() : ""
    const stderr = typeof child.stderr === "string" ? child.stderr.trim() : ""
    const parsed = parseResult(stdout)
    const succeeded = child.status === 0 && parsed.ok === true
    if (succeeded) {
      recordLearningProposalStatus({
        stateDir: job.stateDir,
        candidate: job.candidate,
        reservation: job.reservation,
        status: "submitted",
        ...(parsed.ref ? { ref: parsed.ref } : {}),
        ...(parsed.proposalId ? { proposalId: parsed.proposalId } : {}),
      })
      appendWorkerLog(job, "submitted", parsed.ref ?? parsed.proposalId ?? "proposal queued")
      emitOutcome(job, "ok", parsed)
    } else {
      const error = parsed.error
        ?? ((child.error instanceof Error ? child.error.message : "")
          || stderr
          || `akm proposal new exited with status ${child.status}`)
      recordLearningProposalStatus({
        stateDir: job.stateDir,
        candidate: job.candidate,
        reservation: job.reservation,
        status: "failed",
        error,
      })
      appendWorkerLog(job, "failed", error)
      emitOutcome(job, "failed", { error })
    }
  } catch (error: unknown) {
    if (job) {
      const message = error instanceof Error ? error.message : String(error)
      recordLearningProposalStatus({
        stateDir: job.stateDir,
        candidate: job.candidate,
        reservation: job.reservation,
        status: "failed",
        error: message,
      })
      appendWorkerLog(job, "failed", message)
      emitOutcome(job, "failed", { error: message })
    }
  } finally {
    removeLearningProposalJob(jobFile, job?.taskFile ?? "")
  }
}

run()
