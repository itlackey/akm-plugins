// Automatic feedback for the OpenCode plugins (V1 `akm-opencode`, V2
// `akm-opencode-v2`): which asset refs a session touched, what a user message
// says about them, and the `akm feedback` calls that follow. Version-neutral:
// each entrypoint feeds it tool results and user messages from its own hooks
// and logs the outcomes through its own host channel (nothing here logs).
//
// Policy, unchanged from the V1 plugin:
//   - Feedback is only ever the RETROSPECTIVE channel: the user saying it
//     worked ("thanks, that worked") credits the last few refs the session
//     touched; the user saying it was wrong ("that's wrong") blames the last one.
//   - A tool outcome is never feedback. A failed akm call says nothing about the
//     asset's content (akm#999), so failed calls never reach the ref buffer.
//   - memories/env/secrets/lessons never receive automatic feedback.
import { spawn } from "node:child_process"
import {
  classifyFeedbackSignal,
  createExplicitCorrectionRegex,
  createRetrospectiveFeedbackRegex,
  createRetrospectiveNegativeRegex,
  shouldSubmitAutomaticFeedback,
} from "../claude/shared/feedback-signals"
import { extractAkmRefsFromString, validateRefCandidates } from "../claude/shared/ref-extraction"
import { type ResolvedAkmCommand, isCliError, runAkm } from "./akm-cli"
import { type EventWriter, buildEventScope } from "./events"

const RETROSPECTIVE_FEEDBACK_RE = createRetrospectiveFeedbackRegex()
const RETROSPECTIVE_NEGATIVE_RE = createRetrospectiveNegativeRegex()
const EXPLICIT_CORRECTION_RE = createExplicitCorrectionRegex()

/** Read per call: the plugin process outlives many sessions and the operator may flip it. */
export const autoFeedbackEnabled = (): boolean => (process.env.AKM_AUTO_FEEDBACK ?? "1") !== "0"

// Refs that must never receive automatic feedback, in bundle-qualified form
// too (`local//lessons/foo`). Lessons take feedback through the proposal
// queue; memories/env/secrets are not ranked assets at all. Same source as
// NO_AUTO_FEEDBACK_REF_RE in claude/hooks/akm-hook.ts, which applies it to
// both of its auto-feedback paths.
export const NO_AUTO_FEEDBACK_REF_RE = /^(?:.*\/\/)?(?:memories|env|secrets|lessons)\//

// --- reading akm tool results ---------------------------------------------------

export function parseToolOutput(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * The outcome of an akm tool call: "positive" when it returned a result,
 * "negative" when it failed (a CLI error, `ok: false`, an `error` string). It
 * gates the write gate's already-shown credit and labels the observation
 * events; it is NOT feedback on the asset.
 */
export function classifyToolFeedback(value: unknown): "positive" | "negative" | undefined {
  if (!value || typeof value !== "object") return undefined
  if (isCliError(value)) return "negative"
  if ("ok" in value && (value as { ok?: unknown }).ok === false) return "negative"
  if ("error" in value && typeof (value as { error?: unknown }).error === "string") return "negative"
  if ("ok" in value && (value as { ok?: unknown }).ok === true) return "positive"
  if ("type" in value || "hits" in value || "items" in value) return "positive"
  return undefined
}

/** Refs an akm tool call named (its `ref` argument) or returned (`ref`, `hits[]`, `items[]`). */
export function extractToolRefs(toolName: string, args: Record<string, unknown>, output: unknown): string[] {
  const refs = new Set<string>()
  const addMatches = (value: unknown) => {
    if (typeof value !== "string") return
    for (const ref of extractAkmRefsFromString(value)) refs.add(ref)
  }

  for (const key of ["ref", "package_ref"]) addMatches(args[key])

  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>
    addMatches(o.ref)
    if (Array.isArray(o.hits)) {
      for (const hit of o.hits) {
        if (hit && typeof hit === "object") addMatches((hit as Record<string, unknown>).ref)
      }
    }
    // akmCurate returns { query, summary, items } — not `hits` — so without this
    // branch a curate call yields no refs at all and nothing downstream (the
    // write gate's already-shown credit, tool_observation, the feedback buffer)
    // can see what the model was handed.
    if (Array.isArray(o.items)) {
      for (const item of o.items) {
        if (item && typeof item === "object") addMatches((item as Record<string, unknown>).ref)
      }
    }
    if (toolName === "akm_remember" && typeof o.ref === "string") addMatches(o.ref)
  }

  return [...refs]
}

/** Refs mentioned anywhere in a tool call's arguments (any tool, not only akm's). */
export function extractAkmRefsFromAllArgs(args: Record<string, unknown>): string[] {
  if (!args || typeof args !== "object") return []
  const refs = new Set<string>()
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      for (const ref of extractAkmRefsFromString(value)) refs.add(ref)
    } else if (typeof value === "object" && value !== null) {
      for (const ref of extractAkmRefsFromString(JSON.stringify(value))) refs.add(ref)
    }
  }
  return [...refs]
}

// --- per-session state ----------------------------------------------------------

export type SessionBufferEntry = {
  timestamp: string
  kind: "memory-intent" | "tool-ref" | "learning-signal"
  toolName?: string
  ref?: string
  status?: "positive" | "negative" | "unknown"
  note?: string
  checkpointed?: boolean
}

type RetrospectiveState = { recentRefs: string[]; lastNegativeSignalAt?: number }

export type PositiveFeedback = { ref: string; note: string }
export type NegativeFeedback = { ref: string; reason: string; explicit: boolean }

export type FeedbackPlan = {
  positive: PositiveFeedback[]
  negative?: NegativeFeedback
}

export type FeedbackTracker = ReturnType<typeof createFeedbackTracker>

/**
 * Per-session record of the refs a session touched and the retrospective
 * negative-signal window. Torn down with the session via `clear()`.
 */
export function createFeedbackTracker(options: { maxBufferEntries: number; now?: () => number }) {
  const now = options.now ?? Date.now
  const buffers = new Map<string, SessionBufferEntry[]>()
  const retrospective = new Map<string, RetrospectiveState>()

  function addBufferEntry(sessionID: string | undefined, entry: Omit<SessionBufferEntry, "timestamp">): void {
    if (!sessionID) return
    const buffer = buffers.get(sessionID) ?? []
    buffer.push({ timestamp: new Date(now()).toISOString(), ...entry })
    // Drop-oldest cap: a long session accumulates one entry per observed ref.
    if (buffer.length > options.maxBufferEntries) buffer.splice(0, buffer.length - options.maxBufferEntries)
    buffers.set(sessionID, buffer)
  }

  function noteRecentRefs(sessionID: string | undefined, refs: string[]): void {
    if (!sessionID || refs.length === 0) return
    const state = retrospective.get(sessionID) ?? { recentRefs: [] }
    state.recentRefs = [...new Set([...state.recentRefs, ...refs])].slice(-8)
    retrospective.set(sessionID, state)
  }

  /** The three most recently touched distinct refs eligible for automatic feedback. */
  function recentToolRefs(sessionID: string): string[] {
    return (buffers.get(sessionID) ?? [])
      .filter((entry) => entry.kind === "tool-ref" && !!entry.ref)
      .map((entry) => entry.ref!)
      // Keep each ref's LAST occurrence, so `slice(-3)` really means "the three
      // most recently touched distinct refs" — first-occurrence order drops a ref
      // that was touched early and again just now.
      .filter((ref, index, refs) => !NO_AUTO_FEEDBACK_REF_RE.test(ref) && refs.lastIndexOf(ref) === index)
      .slice(-3)
  }

  /**
   * What a user message says about the refs this session touched. Pure policy
   * plus the negative-signal window bookkeeping; running the feedback is the
   * caller's job (`spawnPositiveFeedback` / `submitNegativeFeedback`).
   *
   * Positive: the loose "thanks|perfect|worked" matcher must not fire on
   * `thanks, but it didn't work`, so a message that also reads as negative or as
   * a correction is ambiguous and skipped. Refs go through the shared confidence
   * gate so Claude and OpenCode reach the same verdict for the same signal.
   *
   * Negative: an explicit correction blames the last touched ref at once; a
   * softer negative signal needs a second one within two minutes.
   */
  function planFeedback(sessionID: string, text: string): FeedbackPlan {
    const plan: FeedbackPlan = { positive: [] }
    const explicitCorrection = EXPLICIT_CORRECTION_RE.test(text)
    const negativeSignal = RETROSPECTIVE_NEGATIVE_RE.test(text)

    if (autoFeedbackEnabled() && RETROSPECTIVE_FEEDBACK_RE.test(text) && !negativeSignal && !explicitCorrection) {
      const seen = new Set<string>()
      for (const ref of recentToolRefs(sessionID)) {
        if (seen.has(ref)) continue
        const signal = classifyFeedbackSignal({
          ref,
          polarity: "positive",
          harness: "opencode",
          sessionId: sessionID,
          retrospective: true,
          note: "opencode retrospective: user confirmed it worked",
        })
        if (!shouldSubmitAutomaticFeedback(signal)) continue
        seen.add(ref)
        plan.positive.push({ ref, note: signal.note })
      }
    }

    const state = retrospective.get(sessionID)
    const recentRefs = state?.recentRefs ?? []
    if (recentRefs.length > 0 && (explicitCorrection || negativeSignal)) {
      if (!explicitCorrection && (!state?.lastNegativeSignalAt || now() - state.lastNegativeSignalAt > 2 * 60 * 1000)) {
        retrospective.set(sessionID, { recentRefs, lastNegativeSignalAt: now() })
      } else {
        retrospective.set(sessionID, { recentRefs })
        plan.negative = { ref: recentRefs[recentRefs.length - 1]!, reason: text.slice(0, 280), explicit: explicitCorrection }
      }
    }
    return plan
  }

  /**
   * Step one for ANY tool call: note the akm refs it named or returned. An akm
   * tool's own result is read exactly; any other tool's refs are only believed
   * when they exist in the bundle (`bundleDir`), so ordinary repository paths
   * cannot become automatic feedback targets.
   *
   * The ref of a failed akm call is only the one the model asked for, an asset
   * akm never returned, and the failure says nothing about its content (akm#999):
   * it is observed and logged, never remembered as a ref the session used.
   */
  async function observeToolRefs(input: {
    sessionID?: string
    tool: string
    callID?: string
    args: Record<string, unknown>
    outputText: string
    /** Only awaited for a tool that is not akm's own. */
    getBundleDir: () => Promise<string | undefined>
    directory?: string
    writeEvent: EventWriter
  }): Promise<{ refs: string[]; failedCall: boolean }> {
    const isAkmTool = input.tool.startsWith("akm_")
    const candidateRefs = [...new Set([...extractAkmRefsFromAllArgs(input.args), ...extractAkmRefsFromString(input.outputText)])]
    const parsed = isAkmTool ? parseToolOutput(input.outputText) : null
    const refs = isAkmTool && parsed
      ? extractToolRefs(input.tool, input.args, parsed)
      : validateRefCandidates(candidateRefs, [(await input.getBundleDir()) ?? ""])
    const failedCall = classifyToolFeedback(parsed) === "negative"
    if (refs.length > 0) {
      input.writeEvent({
        event: "tool_ref_observed",
        sessionId: input.sessionID,
        scope: buildEventScope(input.sessionID, input.directory, input.tool),
        input: { tool: input.tool, callID: input.callID },
        refs,
        outcome: { status: "ok" },
      })
      if (!failedCall) {
        for (const ref of refs) addBufferEntry(input.sessionID, { kind: "tool-ref", toolName: input.tool, ref, status: "unknown" })
      }
    }
    return { refs, failedCall }
  }

  /**
   * Step two, akm tools only: the outcome of the call, the refs it returned, and
   * the observation event. No feedback is submitted from a tool outcome: a
   * successful search/show/curate only inspected a concept (viewing is not
   * using), and a failed one says nothing about the asset (akm#999).
   */
  function observeAkmToolResult(input: {
    sessionID?: string
    tool: string
    callID?: string
    args: Record<string, unknown>
    parsed: object
    directory?: string
    writeEvent: EventWriter
  }): { outcome: "positive" | "negative" | undefined; refs: string[]; failedCall: boolean } {
    const outcome = classifyToolFeedback(input.parsed)
    const refs = extractToolRefs(input.tool, input.args, input.parsed)
    const failedCall = outcome === "negative"
    if (!failedCall) noteRecentRefs(input.sessionID, refs)
    input.writeEvent({
      event: "tool_observation",
      sessionId: input.sessionID,
      scope: buildEventScope(input.sessionID, input.directory, input.tool),
      input: { tool: input.tool, callID: input.callID, args: input.args, output: input.parsed as Record<string, unknown> },
      refs,
      outcome: { status: failedCall ? "failed" : "ok" },
    })
    if (refs.length > 0 && input.sessionID && !failedCall) {
      for (const ref of refs) addBufferEntry(input.sessionID, { kind: "tool-ref", toolName: input.tool, ref, status: outcome ?? "unknown" })
    }
    return { outcome, refs, failedCall }
  }

  return {
    addBufferEntry,
    noteRecentRefs,
    observeToolRefs,
    observeAkmToolResult,
    planFeedback,
    /** True while a softer negative signal is waiting for its confirming second one. */
    hasRecentNegativeSignal: (sessionID: string): boolean => retrospective.get(sessionID)?.lastNegativeSignalAt != null,
    clear(sessionID: string): void {
      buffers.delete(sessionID)
      retrospective.delete(sessionID)
    },
  }
}

// --- running feedback -----------------------------------------------------------

/**
 * Fire-and-forget `akm feedback <ref> --positive --reason <note>` (detached,
 * unref'd, so it never stalls a turn). `onFailure` receives the reason; returns
 * false when nothing could be started. Never throws.
 */
export function spawnPositiveFeedback(
  command: ResolvedAkmCommand,
  ref: string,
  note: string,
  onFailure: (error: string) => void,
  formatError: (error: unknown) => string,
): boolean {
  try {
    const child = spawn(
      command.command,
      [...command.argsPrefix, "feedback", ref, "--positive", "--reason", note, "--format", "json", "-q"],
      { detached: true, stdio: "ignore" },
    )
    child.on("exit", (code, signal) => {
      if ((typeof code === "number" && code !== 0) || signal) {
        onFailure(signal ? `akm feedback exited via signal ${signal}` : `akm feedback exited with code ${code}`)
      }
    })
    child.on("error", (error) => onFailure(formatError(error)))
    child.unref()
    return true
  } catch (error: unknown) {
    onFailure(formatError(error))
    return false
  }
}

/** `akm feedback <ref> --negative --reason <reason>`; `ok` is the CLI's own `{ok:true}` envelope. */
export async function submitNegativeFeedback(
  command: ResolvedAkmCommand,
  feedback: NegativeFeedback,
  options: { timeoutMs?: number; cwd?: string; packageName?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const result = await runAkm(command, ["feedback", feedback.ref, "--negative", "--reason", feedback.reason, "--format", "json"], options)
  if (!result.ok) return { ok: false, error: result.error }
  const envelope = parseToolOutput(result.stdout) as { ok?: unknown } | undefined
  return { ok: envelope?.ok === true }
}
