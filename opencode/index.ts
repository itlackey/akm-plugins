import { type Plugin, tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  type CliError,
  type ResolvedAkmCommand,
  execResolvedAkm,
  formatCliError as formatSharedCliError,
  readVerbToolOutput,
  resolveAkmCommand as resolveSharedAkmCommand,
  runAkm,
} from "../opencode-shared/akm-cli"
import {
  AKM_CURATED_TAIL,
  AKM_HINTS_PREFIX,
  applyContextBudget,
  autoMemoryEnabled,
  buildCurateOptions,
  buildScopedArgs,
  createCuratedFileStore,
  extractMinIntervalMs,
  gatherCwdContext,
  formatWorkflowContext,
  recallCurate,
  renderCuratedJsonResponse,
  spawnSessionExtract,
  summarizeActiveWorkflows,
  truncateLogText,
  unwrapJsonStringPrompt,
} from "../opencode-shared/recall"
import { createBundleDirResolver } from "../opencode-shared/bundle"
import { buildEventScope, opencodeEventLog, writeOpencodeEvent } from "../opencode-shared/events"
import {
  classifyToolFeedback,
  createFeedbackTracker,
  extractAkmRefsFromAllArgs,
  extractToolRefs,
  type NegativeFeedback,
  parseToolOutput,
  spawnPositiveFeedback,
} from "../opencode-shared/feedback"
import {
  type GateDecision,
  type GateHost,
  type GateSearchResponse,
  clearGateSession,
  assetDeclaresFormat,
  extractFormatIdentity,
  formatGateMessage,
  gateDecision,
  noteShownRefs,
  observeFileIdentity,
  resetWriteGateForTests,
  warnIfWriteGateInert,
} from "../opencode-shared/write-gate"
import { createLearning, createPendingProposals } from "../opencode-shared/learning"
import { ASSET_TYPES, TOOL_SPECS, type ToolSpec, buildFeedbackArgs, buildRememberArgs, withProposedWarnings } from "../opencode-shared/tools"
import { shouldRecall } from "../claude/shared/recall-policy"
import { redactObject } from "../claude/shared/redaction"
import { extractAkmRefsFromString, validateRefCandidates } from "../claude/shared/ref-extraction"

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const AKM_AUTO_CURATE = (process.env.AKM_AUTO_CURATE ?? "1") !== "0"
const AKM_PENDING_PROPOSAL_TIMEOUT_MS = Math.max(500, (Number(process.env.AKM_PENDING_PROPOSAL_TIMEOUT ?? "2") || 2) * 1_000)
const AKM_CURATE_MIN_CHARS = Math.max(1, Number(process.env.AKM_CURATE_MIN_CHARS ?? "16") || 16)
const AKM_READ_TOOL_TIMEOUT_MS = Math.max(1_000, (Number(process.env.AKM_READ_TOOL_TIMEOUT ?? "60") || 60) * 1_000)
const AKM_CURATE_TIMEOUT_MS = Math.max(1_000, (Number(process.env.AKM_CURATE_TIMEOUT ?? "8") || 8) * 1_000)
// Exactly the opencode 1.18 write-path tool ids, verified against the installed
// binary's tool schemas: edit -> {filePath, oldString, newString},
// write -> {content, filePath}, apply_patch -> {patchText}. `patch` and
// `multiedit` are NOT opencode tool ids (they are Claude Code's) and listing
// them would be dead weight; apply_patch replaces edit+write on `gpt-*`
// non-oss non-gpt-4 models, so omitting it would make the gate dark for a
// whole model family rather than merely inert.
// The write gate itself is opencode-shared/write-gate.ts; this is the V1 tool vocabulary it is wired to.
const WATCHED_WRITE_TOOLS = new Set(["edit", "write", "apply_patch"])
// 13: "Memory leaks" — the session buffer previously grew without bound for the
// life of a session (a long-running session accumulates one entry per
// observed tool ref / memory intent). The tracker caps it drop-oldest.
const AKM_SESSION_BUFFER_MAX_ENTRIES = Math.max(1, Number(process.env.AKM_SESSION_BUFFER_MAX_ENTRIES ?? "200") || 200)
// Best-effort sweep age for orphaned curated tmp files (os.tmpdir()/akm-opencode/curated).
// A session that ends without ever firing session.deleted (host crash, forced
// kill) would otherwise leak its curated file on disk forever.
const PLUGIN_VERSION = readPackageVersion()
const BUNDLED_AKM_API_VERSION = readBundledAkmVersion()

// Per-session state that drives the compound-engineering loop.
// These maps are keyed by OpenCode sessionID.
const sessionHints = new Map<string, string>()
const sessionCurated = new Map<string, string>()
const sessionWorkflow = new Map<string, string>()
const sessionCuratedFile = new Map<string, string>()
const sessionCuratedVersion = new Map<string, number>()
const sessionCuratedInjectedVersion = new Map<string, number>()
// Refs touched and the negative-signal window, shared with the V2 plugin.
const feedbackTracker = createFeedbackTracker({ maxBufferEntries: AKM_SESSION_BUFFER_MAX_ENTRIES })
// Event-driven extraction (opencode): opencode has no true "session end" event
// and `session.idle` fires after EVERY turn. To avoid flooding extract while a
// session is actively worked, we min-interval-gate per session — at most one
// extract per AKM_EXTRACT_MIN_INTERVAL_MS. The akm content-hash ledger
// (akm-cli #602 / ≥0.9.0-beta.33) further no-ops unchanged content for free.
// The hourly `akm improve` extract pass (the periodic backstop) catches the
// final delta after the last turn.
const sessionLastExtractAt = new Map<string, number>()
const AKM_EXTRACT_MIN_INTERVAL_MS = extractMinIntervalMs()
// Passive ref observation (narrower than explicit show/search input, so
// ordinary repository paths cannot become automatic feedback targets) lives in
// claude/shared/ref-extraction.ts. This module deliberately keeps no local copy
// of the concept-root regex: a second copy silently drifted from the canonical
// AKM 0.9 root list (it still matched `wikis/` and never matched `facts/`,
// `instructions/`, or `sessions/`). extractAkmRefsFromString() is the shared
// whitespace-token extractor and is the single source of truth here.
function readPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(moduleDir, "package.json"), "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function readBundledAkmVersion(): string {
  try {
    const manifestPath = createRequire(import.meta.url).resolve("akm-cli/package.json")
    const raw = readFileSync(manifestPath, "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    const version = parsed.version
    return typeof version === "string" && version ? version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

type LogLevel = "debug" | "info" | "warn" | "error"

type LogCapableClient = {
  app: {
    log: (options: {
      query?: { directory?: string }
      body: {
        service: string
        level: LogLevel
        message: string
        extra?: Record<string, unknown>
      }
    }) => Promise<unknown>
  }
  // Optional because this type is the narrow view the plugin casts the real
  // SDK client down to, and a non-TUI host (server mode, tests, the eval
  // harness) has no `tui` namespace attached at all. Every call site must
  // therefore probe for the method as well as trap a rejection.
  tui?: {
    showToast?: (options: {
      query?: { directory?: string }
      body: {
        title?: string
        message: string
        variant: "info" | "success" | "warning" | "error"
        duration?: number
      }
    }) => Promise<unknown>
  }
}

type CliLogMeta = {
  toolName: string
  directory?: string
  sessionID?: string
  agent?: string
  userID?: string
  channel?: string
}

function formatCliError(error: unknown): string {
  return formatSharedCliError(error, "akm-opencode")
}

function needsAgentSetup(message: string): boolean {
  return /(agent commands are disabled|agent not configured|no [`'"]?agent[`'"]? block in config\.json)/i.test(message)
}

function addAgentSetupGuidance(message: string): string {
  if (!needsAgentSetup(message)) return message
  if (/\bakm setup\b/i.test(message)) return message
  return `${message}. Ask the user to run akm setup manually when interactive configuration is needed.`
}

function isNotIndexedFeedbackError(message: string): boolean {
  return /not in the current index|run ["'`]?akm index["'`]? and try again/i.test(message)
}

function toLogString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value instanceof Buffer) return value.toString("utf8")
  return undefined
}

function getExecStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : null
}

async function writePluginLog(client: LogCapableClient, level: LogLevel, message: string, extra: Record<string, unknown>) {
  try {
    const redacted = redactObject(extra)
    await client.app.log({
      query: typeof redacted.value.directory === "string" ? { directory: redacted.value.directory as string } : undefined,
      body: {
        service: "akm-opencode",
        level,
        message,
        extra: redacted.value,
      },
    })
  } catch {
    // Avoid breaking the TUI if logging itself fails.
  }
}

const writeStructuredEvent = writeOpencodeEvent

const curatedFiles = createCuratedFileStore(path.join(os.tmpdir(), "akm-opencode", "curated"))
const CURATED_DIR = curatedFiles.dir


async function logHookFailure(
  client: LogCapableClient,
  hook: string,
  error: unknown,
  extra?: Record<string, unknown>,
) {
  await writePluginLog(client, "error", `AKM ${hook} hook failed`, {
    subsystem: "hook",
    hook,
    error: formatCliError(error),
    ...extra,
  })
}

// Opt-OUT (default enabled), matching the Claude hook's INDEX_ON_SESSION_END so
// the same install ends a session with the same stash freshness on either
// harness. It was opt-IN because the call site fired on
// session.compacted/idle/deleted, and `session.idle` fires after EVERY turn —
// enabling it meant a blocking `akm index` between turns. The call site is now
// narrowed to session.deleted, so the default can match Claude's.
function shouldIndexOnSessionEnd(): boolean {
  return (process.env.AKM_INDEX_ON_SESSION_END ?? "1") !== "0"
}

function bumpCuratedVersion(sessionID: string) {
  sessionCuratedVersion.set(sessionID, (sessionCuratedVersion.get(sessionID) ?? 0) + 1)
}

// Provenance banner prepended to the curated stash content this plugin writes
// to disk and then points the model at. Stash content can echo text written by
// earlier, untrusted sessions, so the recalled block is framed as reference
// Returns null when the write failed, so callers that record "this curation
// version is on disk" can tell success from a swallowed ENOSPC/EACCES. Writing
// the file is best-effort — a failure must not take the turn down — but
// remembering it as written when it was not is what makes the failure
// permanent (see the transform hook's injected-version bookkeeping).
function writeCuratedFile(sessionID: string, content: string): string | null {
  const filePath = curatedFiles.write(sessionID, content)
  if (filePath) sessionCuratedFile.set(sessionID, filePath)
  return filePath
}

// 13: "Memory leaks" — session.deleted cleanup only cleared sessionHints,
// sessionCurated, sessionWorkflow, the curated-version tracking pair, and
// sessionBuffer. It missed retrospectiveState and the per-session
// pendingProposalSummaryCache entry
// (cacheKey is the sessionID — see getPendingProposalCount), and never
// deleted the session's curated tmp file. clearSessionState() is the single
// place every session-keyed Map/tmp-file is torn down, so a future new map
// would only need one line added here instead of another hand-maintained list
// at the session.deleted call site.
function clearSessionState(sessionID: string): void {
  sessionHints.delete(sessionID)
  sessionCurated.delete(sessionID)
  curatedFiles.remove(sessionCuratedFile.get(sessionID))
  sessionCuratedFile.delete(sessionID)
  sessionWorkflow.delete(sessionID)
  sessionCuratedVersion.delete(sessionID)
  sessionCuratedInjectedVersion.delete(sessionID)
  feedbackTracker.clear(sessionID)
  sessionLastExtractAt.delete(sessionID)
  pendingProposals.invalidate(sessionID)
  // #99 write gate: four more session-keyed maps, torn down here for the same
  // reason as the rest — a re-created session must not inherit a stale latch
  // (which would silently disable the gate) or a stale file identity, and must
  // not inherit a create record either: a NEW session editing that same path is
  // editing a file it did not write.
  clearGateSession(sessionID)
}

// Test-only: expose the curated tmp-file directory so tests can assert file
// existence/absence without hardcoding os.tmpdir() path construction twice.
function __curatedDirForTests(): string {
  return CURATED_DIR
}

// Best-effort sweep of orphaned curated tmp files (13: "tmp-file cleanup").
// clearSessionState() handles the normal session.deleted path; this covers
// sessions that never fire it (host crash, forced kill). Async and fully
// error-trapped internally so a failed sweep never surfaces as an unhandled
// rejection or blocks the session.created path that triggers it.
async function pruneStaleCuratedFiles(): Promise<void> {
  curatedFiles.pruneStale()
}

// Synchronous CLI invocation used by the lifecycle hooks — the plugin host does
// not await these in a hot path, but we still cap execution time so a slow
// stash never wedges the session loop.
function runCliSyncRaw(args: string[], timeoutMs: number): { ok: true; stdout: string } | { ok: false; error: string } {
  const command = resolveAkmCommand()
  if (typeof command === "object" && "ok" in command) return { ok: false, error: command.error }
  try {
    const stdout = execResolvedAkm(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, stdout }
  } catch (error: unknown) {
    return { ok: false, error: formatCliError(error) }
  }
}


function truncateLine(value: string, maxChars = 220): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}...`
}

function runCurate(args: string[]): string | null {
  const result = runCliSyncRaw(args, AKM_CURATE_TIMEOUT_MS)
  if (!result.ok) return null
  const body = result.stdout.trim()
  return body || null
}

// Automatic recall runs in-process through `akm-cli/api` (opencode-shared/recall.ts);
// a failure, a timeout or an abort degrades to "no recall for this turn", logged.
async function runRecall(
  client: LogCapableClient,
  query: string,
  meta: CliLogMeta & { operation: string },
): Promise<string | null> {
  const outcome = await recallCurate(query, { timeoutMs: AKM_CURATE_TIMEOUT_MS })
  if (outcome.ok) return outcome.text
  await writePluginLog(client, "warn", "AKM recall failed", {
    subsystem: "curation",
    operation: meta.operation,
    toolName: meta.toolName,
    sessionID: meta.sessionID,
    directory: meta.directory,
    error: outcome.error,
  })
  return null
}

async function runCurateForPrompt(client: LogCapableClient, text: string, sessionID: string | undefined, directory: string | undefined): Promise<string | null> {
  if (!text || text.length < AKM_CURATE_MIN_CHARS) return null
  return runRecall(client, text, { toolName: "chat.message", sessionID, directory, operation: "prompt-curate" })
}

async function runCurateForSession(client: LogCapableClient, sessionID: string, directory: string | undefined, query?: string): Promise<string | null> {
  // `akm curate` requires a query and rejects the call without one, so an
  // empty context is nothing to curate — not a curate call with the query
  // left off. Building one anyway spent a subprocess per session start to
  // log a MISSING_REQUIRED_ARGUMENT warning.
  const trimmed = query?.trim()
  if (!trimmed) return null
  return runRecall(client, trimmed, { toolName: "session.start", sessionID, directory, operation: "session-curate" })
}

async function runHintsForSession(client: LogCapableClient, sessionID?: string): Promise<string | null> {
  return runCliSyncBestEffort(client, ["--format", "text", "-q", "hints"], AKM_CURATE_TIMEOUT_MS, {
    toolName: "session.start",
    sessionID,
    subsystem: "hints",
    operation: "session-hints",
  })
}

async function runWorkflowSummaryForSession(client: LogCapableClient, sessionID?: string): Promise<string | null> {
  const raw = await runCliSyncBestEffort(client, ["--format", "json", "-q", "workflow", "list", "--active"], AKM_CURATE_TIMEOUT_MS, {
    toolName: "session.start",
    sessionID,
    subsystem: "workflow",
    operation: "active-workflow-summary",
  })
  if (!raw) return null
  return summarizeActiveWorkflows(raw)
}


const bundleDirResolver = createBundleDirResolver()

async function getAkmBundleDir(client?: LogCapableClient): Promise<string | undefined> {
  return bundleDirResolver.get(async () =>
    client
      ? runCliSyncBestEffort(client, ["info", "--format", "json", "-q"], AKM_CURATE_TIMEOUT_MS, {
        toolName: "shell.env",
        subsystem: "info",
        operation: "get-bundle-dir",
      })
      : runCurate(["info", "--format", "json", "-q"]))
}

// getAkmBundleDir() caches "" on failure and neither of its consumers checks,
// so an unconfigured or deleted stash produced no warning anywhere on the
// OpenCode side — the agent just kept calling verbs that answer with nothing.
// The Claude hook has warned about this since 0.8
// (gatherSessionStartWarnings); this is the same wording, delivered through
// the sessionHints slot so it rides the system transform instead of needing a
// channel of its own.
async function getAkmBundleWarning(client: LogCapableClient): Promise<string> {
  const bundleDir = await getAkmBundleDir(client)
  if (!bundleDir) return "No AKM default bundle is configured. Run `akm setup` or set `AKM_BUNDLE_DIR`."
  if (!existsSync(bundleDir)) {
    return `AKM bundle directory \`${bundleDir}\` does not exist. Run \`akm setup\` or set \`AKM_BUNDLE_DIR\` to an existing bundle.`
  }
  return ""
}

function warmIndexInBackground(): void {
  const command = resolveAkmCommand()
  if (typeof command === "object" && "ok" in command) return
  try {
    // Fire and forget, no shell: detached + stdio "ignore" + unref() gives the
    // same "start it and walk away" semantics the old `… &` shell string had,
    // without any quoting concerns. (The previous version quoted argv with
    // JSON.stringify, which is not POSIX shell quoting — a resolved bunx/binary
    // path containing a backslash, newline, or embedded quote would have been
    // mis-parsed by the shell.) Matches maybeExtractSessionOnIdle/queueFeedback.
    // Errors here are never surfaced to the session.
    const child = spawn(command.command, [...command.argsPrefix, "index"], {
      detached: true,
      stdio: "ignore",
    })
    // Required: an unhandled 'error' event (e.g. ENOENT) would otherwise throw
    // asynchronously, outside the try/catch below.
    child.on("error", () => {
      // Intentionally ignore — warming is best-effort.
    })
    child.unref()
  } catch {
    // Intentionally ignore — warming is best-effort.
  }
}

function safeJsonParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function emitWorkflowTelemetry(client: LogCapableClient, level: LogLevel, eventType: string, extra: Record<string, unknown>) {
  // Every call site passes an `akm.<surface>.<outcome>` string, so the
  // structured event is always the one literal. This used to map through
  // `eventType as AkmMemoryEvent["event"]` for anything containing
  // "workflow_", which let an arbitrary caller string become an "event" name
  // the union never declared. eventType is not lost — the plugin log below
  // records it verbatim, and it is also in `extra`.
  void writeStructuredEvent({
    event: "workflow_step",
    sessionId: typeof extra.sessionID === "string" ? extra.sessionID : undefined,
    workflowRunId: typeof extra.runId === "string" ? extra.runId : undefined,
    scope: buildEventScope(typeof extra.sessionID === "string" ? extra.sessionID : undefined, typeof extra.directory === "string" ? extra.directory : undefined, typeof extra.toolName === "string" ? extra.toolName : undefined),
    input: redactObject(extra).value as Record<string, unknown>,
    outcome: { status: level === "error" ? "failed" : level === "warn" ? "blocked" : "ok", warnings: typeof extra.reason === "string" ? [extra.reason] : undefined },
  })
  return writePluginLog(client, level, eventType, {
    subsystem: "workflow-compliance",
    eventType,
    pluginVersion: PLUGIN_VERSION,
    ...extra,
  })
}

async function runCliSyncBestEffort(
  client: LogCapableClient,
  args: string[],
  timeoutMs: number,
  meta: CliLogMeta & { subsystem: string; operation: string },
): Promise<string | null> {
  const result = runCliSyncRaw(args, timeoutMs)
  if (!result.ok) {
    await writePluginLog(client, "warn", "AKM synchronous helper failed", {
      subsystem: meta.subsystem,
      operation: meta.operation,
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      args,
      error: result.error,
    })
    return null
  }
  const body = result.stdout.trim()
  return body || null
}

const pendingProposals = createPendingProposals({
  list: async (args) => {
    const command = resolveAkmCommand()
    if (isCliError(command)) throw new Error(command.error)
    return execResolvedAkm(command, args, { encoding: "utf8", timeout: AKM_PENDING_PROPOSAL_TIMEOUT_MS })
  },
  formatError: formatCliError,
})

// An explicit correction (or a repeated negative signal) blames the last ref the
// session touched. The decision is the shared tracker's; the call is ours so it
// keeps this plugin's command logging and telemetry.
async function recordNegativeFeedback(client: LogCapableClient, sessionID: string, negative: NegativeFeedback) {
  const raw = await runCli(client, ["feedback", negative.ref, "--negative", "--reason", negative.reason], {
    toolName: "akm_feedback",
    sessionID,
  })
  const parsed = safeJsonParse<{ ok?: boolean }>(raw)
  if (parsed?.ok === true) {
    await emitWorkflowTelemetry(client, "info", "akm.feedback.recorded", {
      sessionID,
      toolName: "akm_feedback",
      assetRef: negative.ref,
      outcome: "success",
      reason: negative.explicit ? "explicit correction" : "negative retrospective signal",
    })
  }
}

// Positive feedback only. A failed tool call is not feedback on the asset
// (akm#999), and a correction goes through recordNegativeFeedback().
function queueFeedback(client: LogCapableClient, ref: string, note: string, meta: CliLogMeta): boolean {
  const command = resolveAkmCommand()
  const fail = (error: string) => {
    void writePluginLog(client, "warn", isCliError(command) ? "AKM auto-feedback skipped" : "AKM auto-feedback failed", {
      subsystem: "feedback",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      ref,
      error,
    })
  }
  if (isCliError(command)) {
    fail(command.error)
    return false
  }
  return spawnPositiveFeedback(command, ref, note, fail, formatCliError)
}

async function maybeIndexSessionMemory(
  client: LogCapableClient,
  sessionID: string,
  reason: string,
  ref: string,
): Promise<void> {
  if (!shouldIndexOnSessionEnd()) return
  const result = runCliSyncRaw(["index"], AKM_CURATE_TIMEOUT_MS)
  if (result.ok) return
  await writePluginLog(client, "warn", "AKM session indexing failed", {
    subsystem: "memory",
    actor: "system",
    sessionID,
    reason,
    ref,
    error: result.error,
  })
}

// NOTE, recorded so the next author does not re-derive it: `tool.execute.after`
// also offers a result-mutation channel — the object it receives IS the object
// returned as the tool result, so appending to `output.output` on a completed
// edit would deliver the same message non-blockingly. That is the fallback if a
// future opencode build changes how a thrown hook error is surfaced. It is NOT

function extractSessionIdFromEvent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const p = payload as Record<string, unknown>
  const candidates = [
    p.sessionID,
    p.session_id,
    p.session,
    (p.session as Record<string, unknown> | undefined)?.id,
    (p.properties as Record<string, unknown> | undefined)?.sessionID,
    (p.properties as Record<string, unknown> | undefined)?.session_id,
    (p.properties as Record<string, unknown> | undefined)?.id,
    (p.info as Record<string, unknown> | undefined)?.id,
    (p.info as Record<string, unknown> | undefined)?.sessionID,
  ]
  for (const value of candidates) {
    if (typeof value === "string" && value) return value
  }
  return undefined
}

/**
 * Event-driven extraction trigger for opencode (Option #3: min-interval gate).
 * Called on `session.idle` (which fires after every turn). Extracts the session
 * into the proposal queue at most once per AKM_EXTRACT_MIN_INTERVAL_MS, so a
 * burst of turns collapses to a single periodic checkpoint instead of flooding.
 * `extract --session-id` respects the content-hash ledger, so an extract landing
 * on unchanged content is a free no-op. Fire-and-forget (detached + unref'd) so
 * it never stalls the turn; the hourly `akm improve` extract pass remains the backstop for the final delta.
 *
 * The outcome is reported through the normal plugin log + telemetry channels.
 * This is the native-session harvest path in 0.9, and on a default
 * install it does not work: `akm proposal extract` needs an LLM engine, and
 * without one it answers `{ ok: false, code: "LLM_NOT_CONFIGURED", … }`. Real
 * akm prints that envelope on stderr and exits non-zero, but the shape is not
 * guaranteed across builds (the fake in evals/lib/fake-akm.ts models a build
 * that returns the same `ok: false` body while exiting 0). Discarding the
 * child's output — the previous `stdio: "ignore"` — therefore turned the most
 * likely failure in the whole feature into a silent no-op with nothing to
 * grep for. We now capture the envelope and treat `ok: false` as a failure
 * regardless of exit status, so the actionable code/hint reaches the log.
 */
function maybeExtractSessionOnIdle(client: LogCapableClient, sid: string, directory: string | undefined): void {
  // AKM_AUTO_MEMORY=0 turns native-transcript extraction off, matching the
  // Claude hook's SessionEnd behavior. Prompt-time correction/preference
  // proposals use AKM_AUTO_LEARNING. Read per call rather than at import, like
  // shouldIndexOnSessionEnd(), because the plugin process outlives many
  // sessions.
  if (!autoMemoryEnabled()) return
  const now = Date.now()
  const last = sessionLastExtractAt.get(sid) ?? 0
  if (now - last < AKM_EXTRACT_MIN_INTERVAL_MS) return
  const command = resolveAkmCommand()
  if (typeof command === "object" && "ok" in command) return // akm unavailable — cron backstop covers it
  sessionLastExtractAt.set(sid, now)

  const reportExtractFailure = (error: string, extra?: Record<string, unknown>): void => {
    void writePluginLog(client, "warn", "AKM extract failed", {
      subsystem: "extract",
      sessionID: sid,
      directory,
      error,
      ...extra,
    })
    void emitWorkflowTelemetry(client, "warn", "akm.extract.failed", {
      sessionID: sid,
      directory,
      toolName: "session.idle",
      outcome: "error",
      reason: error,
      ...extra,
    })
  }

  spawnSessionExtract(command, sid, (outcome) => {
    if (!outcome.ok) {
      reportExtractFailure(outcome.error, {
        akmCode: outcome.akmCode,
        hint: outcome.hint,
        exitCode: outcome.exitCode,
        output: outcome.output,
      })
      return
    }
    void writePluginLog(client, "info", "AKM extract completed", {
      subsystem: "extract",
      sessionID: sid,
      directory,
    })
  }, formatCliError)
}

function resolveAkmCommand(): ResolvedAkmCommand | CliError {
  return resolveSharedAkmCommand(import.meta.url, "akm-opencode")
}

async function runCli(client: LogCapableClient, args: string[], meta: CliLogMeta): Promise<string> {
  const command = resolveAkmCommand()
  if (typeof command === "object" && "ok" in command) {
    await writePluginLog(client, "error", "AKM command resolution failed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      command: "akm-cli",
      args,
      exitCode: null,
      stdout: "",
      stderr: command.error,
    })
    return JSON.stringify(command)
  }

  // --format is a global flag on every 0.9.0 verb (the 0.8.0-era `akm improve`
  // hard-reject is gone), so it is safe to auto-inject unconditionally.
  const fullArgs = args.includes("--format") ? [...args] : [...args, "--format", "json"]
  const proposalId = args[0] === "proposal" && typeof args[2] === "string" ? args[2] : null

  const recordSuccess = async (stdout: string): Promise<string> => {
    await writePluginLog(client, "info", "AKM command completed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      command,
      args: fullArgs,
      exitCode: 0,
      stdout,
      stderr: "",
    })
    const parsed = safeJsonParse<SearchResponse>(stdout)
    const refs = args[0] === "search" || args[0] === "curate"
      ? [...new Set([...(parsed?.hits?.flatMap((hit) => hit.ref ? [hit.ref] : []) ?? []), ...extractAkmRefsFromString(stdout)])]
      : extractAkmRefsFromString(stdout)
    feedbackTracker.noteRecentRefs(meta.sessionID, refs)
    if (meta.toolName === "akm_search") {
      await emitWorkflowTelemetry(client, "info", "akm.search.invoked", {
        sessionID: meta.sessionID,
        toolName: meta.toolName,
        assetRef: refs[0] ?? null,
        proposalId: null,
        outcome: "success",
        directory: meta.directory,
      })
    }
    if (meta.toolName === "akm_curate") {
      await emitWorkflowTelemetry(client, "info", "akm.curate.invoked", {
        sessionID: meta.sessionID,
        toolName: meta.toolName,
        assetRef: refs[0] ?? null,
        proposalId: null,
        outcome: "success",
        directory: meta.directory,
      })
    }
    if (meta.toolName === "akm_show") {
      await emitWorkflowTelemetry(client, "info", "akm.show.invoked", {
        sessionID: meta.sessionID,
        toolName: meta.toolName,
        assetRef: args[1] ?? refs[0] ?? null,
        proposalId,
        outcome: "success",
        directory: meta.directory,
      })
    }
    if (args[0] === "proposal" && ["show", "diff"].includes(args[1] ?? "")) {
      await emitWorkflowTelemetry(client, "info", "akm.proposal.reviewed", {
        sessionID: meta.sessionID,
        toolName: meta.toolName,
        proposalId,
        outcome: "requested",
        directory: meta.directory,
      })
    }
    if (args[0] === "proposal" && ["accept", "reject", "drain"].includes(args[1] ?? "")) {
      await emitWorkflowTelemetry(client, "info", args[1] === "accept" ? "akm.proposal.accept.requested" : args[1] === "drain" ? "akm.proposal.drain.requested" : "akm.proposal.reject.requested", {
        sessionID: meta.sessionID,
        toolName: meta.toolName,
        proposalId,
        outcome: "requested",
        directory: meta.directory,
      })
    }
    return stdout
  }

  try {
      const stdout = execResolvedAkm(command, fullArgs, {
        encoding: "utf8",
        timeout: 60_000,
      })
    return recordSuccess(stdout)
  } catch (error: unknown) {
    let message = formatCliError(error)
    message = addAgentSetupGuidance(message)
    await writePluginLog(client, "error", "AKM command failed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
        command: command.displayCommand,
        args: fullArgs,
      exitCode: getExecStatus(error),
      stdout: toLogString((error as { stdout?: unknown }).stdout) ?? "",
      stderr: toLogString((error as { stderr?: unknown }).stderr) ?? message,
    })
    if (meta.toolName.startsWith("akm_")) {
      await emitWorkflowTelemetry(client, "warn", `${meta.toolName}.failed`, {
        sessionID: meta.sessionID,
        toolName: meta.toolName,
        proposalId,
        outcome: "error",
        reason: message,
        directory: meta.directory,
      })
    }
    return JSON.stringify({ ok: false, error: message })
  }
}

async function runInProcess(
  client: LogCapableClient,
  operation: "search" | "show" | "curate",
  input: Record<string, unknown>,
  meta: CliLogMeta,
): Promise<string> {
  // The three read tools go through the public `akm` CLI (`--format json`)
  // via the shared helper, never through akm-cli internals. (The name is a
  // leftover from when this called the library in-process.)
  try {
    const result = await readVerbToolOutput(resolveAkmCommand(), operation, input, {
      timeoutMs: AKM_READ_TOOL_TIMEOUT_MS,
      cwd: meta.directory,
      packageName: "akm-opencode",
    })
    if (!result.ok) {
      const message = result.error ?? "akm call failed"
      await writePluginLog(client, "error", "AKM read call failed", {
        subsystem: "akm",
        toolName: meta.toolName,
        sessionID: meta.sessionID,
        directory: meta.directory,
        operation,
        error: message,
      })
      await emitWorkflowTelemetry(client, "warn", `${meta.toolName}.failed`, {
        sessionID: meta.sessionID,
        toolName: meta.toolName,
        outcome: "error",
        reason: message,
        directory: meta.directory,
      })
      return result.output
    }
    const output = result.output
    const refs = extractAkmRefsFromString(output)
    feedbackTracker.noteRecentRefs(meta.sessionID, refs)
    await writePluginLog(client, "info", "AKM read call completed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      operation,
      refs,
    })
    await emitWorkflowTelemetry(client, "info", `akm.${operation}.invoked`, {
      sessionID: meta.sessionID,
      toolName: meta.toolName,
      assetRef: operation === "show" ? String(input.ref ?? refs[0] ?? "") || null : refs[0] ?? null,
      outcome: "success",
      directory: meta.directory,
    })
    return output
  } catch (error: unknown) {
    const message = formatCliError(error)
    await writePluginLog(client, "error", "AKM read call failed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      operation,
      error: message,
    })
    return JSON.stringify({ ok: false, error: message })
  }
}


// The AKM 0.9 asset-type vocabulary, in the singular form `--type` accepts.
// This is exactly `akm info --format json` -> .assetTypes, sorted; keep the two
// in step when akm adds a type. Note there is no `wiki` type in 0.9 — the entry
// that used to be here made `type: "wiki"` a selectable enum value that akm
// answers with an empty hit list rather than an error, i.e. a silent dead end,
// while `instruction`, `session`, and `fact` could not be filtered for at all.
// `any` is a tool-surface sentinel, not an akm type: it means "no filter" and is
// stripped before the value reaches akm, so it sorts last.

// Derived from ASSET_TYPES so the enum published on the akm_search/akm_curate
// tool surface and the type carried by search hits cannot drift apart again.
type AssetType = Exclude<(typeof ASSET_TYPES)[number], "any">

type SearchHit = {
  type: AssetType | "registry" | "registry-asset"
  ref?: string
  id?: string
  installRef?: string
  editable?: boolean
  name?: string
  description?: string
  score?: number
  estimatedTokens?: number
  whyMatched?: string[]
  matchStage?: "exact" | "prefix" | "relaxed"
  run?: string
  origin?: string | null
  size?: string
  action?: string
  editHint?: string
  curated?: boolean
  quality?: string
  selectedRef?: string
  parentRef?: string
  fragmentOrdinal?: number
  fragmentCount?: number
  startLine?: number
  endLine?: number
  previousRef?: string
  nextRef?: string
  fragmentChars?: number
  fragmentEstimatedTokens?: number
  parentChars?: number
  parentEstimatedTokens?: number
}

type SearchResponse = {
  schemaVersion?: number
  bundleDir?: string
  hits?: SearchHit[]
  registryHits?: SearchHit[]
  source?: "local" | "registry" | "all"
  timing?: { totalMs?: number; rankMs?: number; embedMs?: number }
  warnings?: string[]
  tip?: string
}

function isCliError(value: unknown): value is CliError {
  return !!value
    && typeof value === "object"
    && "ok" in value
    && (value as { ok?: unknown }).ok === false
    && "error" in value
}

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const segments: string[] = []
  for (const part of parts as Array<Record<string, unknown>>) {
    // `synthetic` parts are text OpenCode injected beside the prompt (an
    // attached file's contents, the Read call that fetched it, an @agent
    // mention's instructions), not what the user typed.
    if (part?.type === "text" && !part.synthetic && typeof part.text === "string") {
      const text = unwrapJsonStringPrompt(part.text)
      if (text) segments.push(text)
    }
  }
  return segments.join("\n\n")
}

function extractMemoryRefs(toolName: string, args: Record<string, unknown>, value: unknown): string[] {
  const refs = new Set<string>()
  const parsed = value && typeof value === "object" ? value as {
    type?: unknown
    ref?: unknown
    name?: unknown
    hits?: unknown
  } : undefined

  if (toolName === "akm_remember" && typeof parsed?.ref === "string" && parsed.ref) {
    refs.add(parsed.ref)
  }

  if (parsed?.type === "memory") {
    if (typeof parsed.ref === "string" && parsed.ref) refs.add(parsed.ref)
    if (typeof args.ref === "string" && args.ref) refs.add(args.ref)
    if (refs.size === 0 && typeof parsed.name === "string" && parsed.name) refs.add(`memories/${parsed.name}`)
  }

  if (Array.isArray(parsed?.hits)) {
    for (const hit of parsed.hits) {
      if (!hit || typeof hit !== "object") continue
      if ((hit as { type?: unknown }).type !== "memory") continue
      const ref = (hit as { ref?: unknown }).ref
      if (typeof ref === "string" && ref) refs.add(ref)
    }
  }

  return [...refs]
}

// Turn a shared tool spec into this host's `tool.schema` argument map.
function v1Args(spec: ToolSpec): Record<string, any> {
  const schema = tool.schema
  const args: Record<string, any> = {}
  for (const [key, param] of Object.entries(spec.params)) {
    let field: any
    if (param.kind === "string") field = schema.string()
    else if (param.kind === "number") field = schema.number()
    else if (param.kind === "boolean") field = schema.boolean()
    else if (param.kind === "enum") field = schema.enum(param.values as unknown as [string, ...string[]])
    else field = schema.array(schema.string())
    field = field.describe(param.describe)
    args[key] = param.optional ? field.optional() : field
  }
  return args
}

const akmPlugin: Plugin = async ({ client, worktree, directory }) => {
  const logClient = client as unknown as LogCapableClient
  const gateHost: GateHost = {
    log: (level, message, extra) => void writePluginLog(logClient, level, message, extra),
    writeEvent: writeStructuredEvent,
    formatError: formatCliError,
    pathKey: "filePath",
    patchTool: "apply_patch",
    search: async (token) => {
      const command = resolveAkmCommand()
      if (isCliError(command)) throw new Error(command.error)
      // This search is the PLUGIN's, not the model's: attribute it to a non-user event
      // source so akm's utility scores and feedback ranking do not count it as demand.
      const result = await runAkm(command, ["search", token, "--limit", "5", "--from", "local", "--detail", "agent", "--format", "json"], {
        timeoutMs: 8_000,
        env: { AKM_EVENT_SOURCE: "audit" },
        packageName: "akm-opencode",
      })
      if (!result.ok) throw new Error(result.error)
      return safeJsonParse<GateSearchResponse>(result.stdout)
    },
  }
  const learning = createLearning({
    log: (level, message, extra) => void writePluginLog(logClient, level, message, extra),
    writeEvent: writeStructuredEvent,
    resolveCommand: resolveAkmCommand,
    formatError: formatCliError,
    addBufferEntry: feedbackTracker.addBufferEntry,
    onSubmitted: (sessionID) => pendingProposals.invalidate(sessionID),
  })
  return {
    // Events cover the lifecycle boundaries that Claude Code exposes as
    // SessionStart / Stop / PreCompact. We use them to warm the stash, capture
    // hints for the next system transform, and flush per-session memories.
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      try {
        const type = event?.type
        if (!type) return
        const sid = extractSessionIdFromEvent(event) ?? extractSessionIdFromEvent((event as { properties?: unknown }).properties)
        if (type === "session.created" || type === "session.updated") {
          if (!sid) return
          writeStructuredEvent({
            event: "session_started",
            sessionId: sid,
            scope: buildEventScope(sid, directory),
            input: { type },
            outcome: { status: "ok" },
          })
          if (type === "session.created") {
            // Best-effort, fire-and-forget, fully error-trapped internally —
            // must never block or fail session.created (13: "tmp-file cleanup").
            void pruneStaleCuratedFiles()
            warmIndexInBackground()
            if (AKM_AUTO_CURATE && !sessionCurated.has(sid)) {
              const cwdContext = gatherCwdContext(directory)
              const curated = await runCurateForSession(logClient, sid, directory, cwdContext || undefined)
              if (curated) {
                bumpCuratedVersion(sid)
                sessionCurated.set(sid, curated)
                writeCuratedFile(sid, curated)
              }
            }
          }
          if (!sessionHints.has(sid)) {
            const bundleWarning = await getAkmBundleWarning(logClient)
            const hints = await runHintsForSession(logClient, sid)
            const body = [bundleWarning, hints].filter(Boolean).join("\n\n")
            if (body) sessionHints.set(sid, body)
          }
          if (!sessionWorkflow.has(sid)) {
            sessionWorkflow.set(sid, await runWorkflowSummaryForSession(logClient, sid) ?? "")
          }
        } else if (type === "session.compacted" || type === "session.idle" || type === "session.deleted") {
          if (!sid) return
          // 03-R1/06-M1: the session_checkpoint `remember --force` write is
          // removed. Keep the freshness reindex so upstream inference/graph
          // passes still run — but ONLY on session.deleted. `akm index` is a
          // blocking execFileSync, and this branch also covers session.idle,
          // which OpenCode fires after EVERY turn (see the min-interval gate on
          // the extract path); running it there put a synchronous index between
          // every pair of turns. The Claude hook can index unconditionally
          // because it hangs off SessionEnd, which fires once; OpenCode has no
          // true session-end event, so session.deleted is the closest analogue.
          if (type === "session.deleted") {
            await maybeIndexSessionMemory(logClient, sid, type, "")
          }
          // Nothing prunes sessionBuffer here. It used to be swept on every
          // event in this branch once it held two entries, which is a bug now
          // that the memory-candidate harvest (whose de-dup that sweep was) is
          // gone: session.idle fires at EVERY turn's quiescence, so the sweep
          // emptied the buffer between turns in exactly the sessions that
          // touched the most assets — and the retrospective auto-feedback path
          // in chat.message reads that buffer to decide what a later "thanks,
          // that worked" credits. The buffer is bounded by
          // AKM_SESSION_BUFFER_MAX_ENTRIES and torn down by clearSessionState()
          // on the terminal session.deleted below; nothing else may discard it.

          // Event-driven extraction: only on session.idle (per-turn quiescence),
          // min-interval-gated so it doesn't flood. Not on compacted/deleted.
          if (type === "session.idle") {
            maybeExtractSessionOnIdle(logClient, sid, directory)
          }
          if (type === "session.compacted") {
            // 03-R1/06-M1: the session_checkpoint capture that used to feed
            // `memory.ref` here was removed along with the `remember --force`
            // write. Record the event as an explicit no-capture so
            // post_compact_summary consumers see a skipped outcome instead of
            // a dangling/undefined ref.
            writeStructuredEvent({
              event: "post_compact_summary",
              sessionId: sid,
              scope: buildEventScope(sid, directory),
              memory: { ref: null, reason: type },
              outcome: { status: "skipped" },
            })
          }
          // Drop per-session state (every session-keyed Map, plus the curated
          // tmp file) so a re-created session does not inherit stale
          // hints/curation and the tmp file does not leak (13: "Memory leaks").
          if (type === "session.deleted") {
            // #99: the gate is the one akm feature whose total failure looks
            // exactly like normal operation in the ledger, so say so out loud.
            warnIfWriteGateInert(gateHost)
            clearSessionState(sid)
          }
        }
      } catch (error: unknown) {
        await logHookFailure(logClient, "event", error)
      }
    },
    // experimental.chat.system.transform is how OpenCode exposes the
    // additionalContext channel. The host rebuilds output.system from scratch
    // on every request, so the cached blocks are pushed on EVERY transform.
    // They used to be gated behind a per-session epoch that was marked
    // "injected" the first time this ran, which meant the common
    // no-pending-proposal session got AKM's framing on turn one and never
    // again — including after a compaction, exactly when it is needed most.
    // The block set is stable turn to turn (prompt-cache friendly, unlike the
    // sporadic push it replaces) and AKM_CONTEXT_BUDGET_CHARS still caps it.
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; session_id?: string } | undefined,
      output: { system?: string[] } | undefined,
    ) => {
      try {
        if (!output || !Array.isArray(output.system)) return
        const sid = extractSessionIdFromEvent(input) ?? ""
        if (!sid) return
        // The pointer to the curated file rides every transform, but the file
        // itself is only re-materialized when the curation actually changed —
        // that is what the curated-version pair tracks.
        const curated = sessionCurated.get(sid)
        const curatedVersion = sessionCuratedVersion.get(sid) ?? 0
        if (curated && sessionCuratedInjectedVersion.get(sid) !== curatedVersion) {
          // Only mark the version as materialized when the write landed —
          // otherwise a single failed write retires the version forever and the
          // pointer line never appears again for this session.
          if (writeCuratedFile(sid, curated)) sessionCuratedInjectedVersion.set(sid, curatedVersion)
        }
        const curatedFile = sessionCuratedFile.get(sid)
        const hints = sessionHints.get(sid)
        // 60s-cached, so reading it once per transform costs nothing; it was
        // previously awaited three times inside a single expression.
        const pendingBlock = await pendingProposals.contextBlock(sid)
        const blocks = [
          // Payload before framing. applyContextBudget() truncates the first
          // block that overflows and then stops, so whatever leads this array
          // is the thing that cannot be starved: `akm hints` output is
          // unbounded stash-authored text, and a large one must not drop the
          // curated-stash pointer, the plugin's actual deliverable.
          curatedFile
            ? `AKM bundle curation written to \`${curatedFile}\`. Read that file to discover assets relevant to this session. ${AKM_CURATED_TAIL}`
            : "",
          // The rules go in with or without `akm hints` output, which is empty on a fresh stash.
          hints ? `${AKM_HINTS_PREFIX}\n\n${hints}` : AKM_HINTS_PREFIX,
          sessionWorkflow.get(sid) ? formatWorkflowContext(sessionWorkflow.get(sid)!) : "",
          pendingBlock,
        ]
        // ONE entry, not N (#96), and merged into the host's LAST existing
        // entry rather than pushed as a new one (#121). OpenCode maps each
        // `system` entry to its own system message, and chat templates that
        // require a single leading system message reject a second one
        // outright — "Jinja Exception: System message must be at the
        // beginning", surfacing as an opaque provider HTTP 500 that hits only
        // sessions with the plugin installed. Merging into the LAST entry
        // (never prepended to output.system[0]) keeps the host's own first
        // entry a stable prompt-cache prefix, since AKM's blocks change from
        // turn to turn while the host's leading entry does not. Pushing a new
        // entry only when the array is empty preserves the number of system
        // entries the host built, except for that one case where the model
        // would otherwise have no system message at all. Budgeting is
        // unchanged and still happens per block, so joining can only re-seam
        // blocks applyContextBudget already kept.
        const budgeted = applyContextBudget(blocks)
        if (budgeted.length > 0) {
          const block = budgeted.join("\n\n")
          const last = output.system.length - 1
          if (last >= 0) output.system[last] = `${output.system[last]}\n\n${block}`
          else output.system.push(block)
        }
      } catch (error: unknown) {
        await logHookFailure(logClient, "experimental.chat.system.transform", error)
      }
    },
    "shell.env": async (_input, output) => {
      try {
        output.env.AKM_PROJECT = worktree
        output.env.AKM_PLUGIN_VERSION = PLUGIN_VERSION
        const bundleDir = await getAkmBundleDir(logClient)
        if (bundleDir) output.env.AKM_BUNDLE_DIR = bundleDir
      } catch (error: unknown) {
        await logHookFailure(logClient, "shell.env", error)
      }
    },
    "chat.message": async (input, output) => {
      try {
        const text = extractText(output.parts).trim()
        if (!text) return
        await writePluginLog(logClient, "info", "AKM user feedback recorded", {
          subsystem: "feedback",
          actor: "user",
          sessionID: input.sessionID,
          messageID: input.messageID,
          agent: input.agent,
          text: truncateLogText(text),
        })
        learning.capturePromptLearning(text, input.sessionID, directory || worktree, directory)

        if (AKM_AUTO_CURATE && input.sessionID) {
          const decision = shouldRecall(text, { activeWorkflow: !!sessionWorkflow.get(input.sessionID), recentAssetFailure: feedbackTracker.hasRecentNegativeSignal(input.sessionID) })
          if (decision.shouldRecall) {
            // Do NOT block the model on `akm curate` — previously this awaited
            // an 8s-timeout sync curate on every user message, adding up to 8s
            // to the time-to-first-token of every turn. Fire-and-forget the
            // curate; when it completes, store the result in `sessionCurated`
            // which gets picked up by `experimental.chat.system.transform` on
            // the NEXT message. The current message proceeds with whatever
            // curated context (if any) was cached from previous turns.
            const sessionID = input.sessionID
            const directorySnapshot = directory
            const agentSnapshot = input.agent
            const previewText = text
            void (async () => {
              try {
                const curated = await runCurateForPrompt(logClient, decision.query, sessionID, directorySnapshot)
                // Shared 0.9 concept-ID extractor. The inline regex this
                // replaced still matched the pre-0.9 `type:slug` ref form
                // (`skill:code-review`, plus a `wiki:` type that no longer
                // exists), so against real 0.9 curate output it matched nothing
                // and the prompt_recall event recorded an empty ref list on
                // every turn.
                const refs = extractAkmRefsFromString(curated ?? "")
                writeStructuredEvent({
                  event: "prompt_recall",
                  sessionId: sessionID,
                  scope: buildEventScope(sessionID, directorySnapshot, agentSnapshot),
                  input: { promptPreview: previewText.slice(0, 280), query: decision.query, reason: decision.reason },
                  refs,
                  outcome: { status: curated ? "ok" : "skipped" },
                })
                if (curated) {
                  sessionCurated.set(sessionID, curated)
                  writeCuratedFile(sessionID, curated)
                  bumpCuratedVersion(sessionID)
                }
              } catch (error: unknown) {
                await writePluginLog(logClient, "warn", "AKM background curate failed", {
                  subsystem: "curation",
                  sessionID,
                  directory: directorySnapshot,
                  error: formatCliError(error),
                })
              }
            })()
          } else {
            const hint = "Need more AKM context? Use `akm_search` or `akm_curate` before writing or editing a file whose exact syntax you are not certain of."
            writeStructuredEvent({
              event: "prompt_recall",
              sessionId: input.sessionID,
              scope: buildEventScope(input.sessionID, directory, input.agent),
              input: { promptPreview: text.slice(0, 280), query: decision.query, reason: decision.reason },
              outcome: { status: "skipped" },
            })
            const current = sessionCurated.get(input.sessionID) ?? ""
            if (!current.includes(hint)) {
              const updated = current ? `${current}\n\n${hint}` : hint
              sessionCurated.set(input.sessionID, updated)
              writeCuratedFile(input.sessionID, updated)
              bumpCuratedVersion(input.sessionID)
            }
          }
        }

        // Track explicit memory intents so capture-memory has something durable
        // to flush when the session ends.
        if (/\b(remember|memory|memories)\b/i.test(text)) {
          feedbackTracker.addBufferEntry(input.sessionID, {
            kind: "memory-intent",
            note: truncateLogText(text, 500),
          })
        }

        // Retrospective feedback (positive: the user confirmed it worked; negative:
        // an explicit correction). What counts, and the mixed-signal rule that
        // keeps `thanks, but it didn't work` from crediting anything, live in
        // opencode-shared/feedback.ts, which the V2 plugin uses as well.
        if (input.sessionID) {
          const plan = feedbackTracker.planFeedback(input.sessionID, text)
          for (const positive of plan.positive) {
            queueFeedback(logClient, positive.ref, positive.note, {
              toolName: "chat.message",
              sessionID: input.sessionID,
              agent: input.agent,
            })
          }
          if (plan.negative) await recordNegativeFeedback(logClient, input.sessionID, plan.negative)
        }
      } catch (error: unknown) {
        await writePluginLog(logClient, "error", "AKM chat.message hook failed", {
          subsystem: "hook",
          hook: "chat.message",
          sessionID: input?.sessionID,
          messageID: input?.messageID,
          agent: input?.agent,
          error: formatCliError(error),
        })
      }
    },
    // #99: the format-declaration write gate. This is the first akm hook that
    // changes what the agent DOES rather than only what it knows, and the
    // structure below is the load-bearing part.
    //
    // Facts re-verified here against the installed opencode 1.18 binary, banked
    // so nobody re-derives them:
    //   - `Plugin.trigger` is `for (const h of hooks) yield* Effect.promise(async () => h(input, output))`,
    //     called from inside the tool's own `Effect.runPromise(Effect.gen(...))`.
    //     A rejection therefore reaches the model as a `tool-error` part
    //     (`case"tool-error":{yield*N(c.id,c.error??Error(c.message))}`), with
    //     `error.message` intact — reproduced end to end against effect
    //     4.0.0-beta.83. "A plugin hook cannot block a tool call" is FALSE.
    //   - Arg names: edit `{filePath, oldString, newString}`, write
    //     `{content, filePath}`, read `{filePath, offset, limit}`, apply_patch
    //     `{patchText}`. It is `filePath`, never `path`.
    //   - The tool registry filter is
    //     `k = modelID.includes("gpt-") && !includes("oss") && !includes("gpt-4")`;
    //     apply_patch is registered when `k`, edit and write when `!k`. So on
    //     that model family apply_patch is the ONLY write tool.
    //   - `read` returns `<path>…</path>\n<type>file</type>\n<content>\n` with
    //     every line prefixed `N: `.
    //   - The CLI's default `search` shape drops `description` and `tags`;
    //     `--detail full` and `--detail agent` keep them, so the gate uses the latter.
    //
    // The throw sits OUTSIDE the try/catch on purpose. Every other hook body in
    // this file wraps itself in `try { … } catch { logHookFailure }` by
    // convention; a throw placed inside that wrapper would be swallowed, the
    // gate would never fire, and the ledger would stay perfectly clean while
    // the feature did nothing. Verified end to end against the installed
    // opencode 1.18 / effect 4.0.0-beta.83: Plugin.trigger runs each hook as
    // `Effect.promise(async () => hook(input, output))` inside the tool's own
    // `Effect.runPromise(Effect.gen(...))`, and a rejection there surfaces with
    // `error.message` verbatim, which the session turns into a `tool-error`
    // part the model reads. (Recorded because the opposite — "a hook cannot
    // block a tool call" — was asserted as verified during design and is false.)
    //
    // A plugin-internal fault must NOT block a user's edit, so everything that
    // can throw for our own reasons stays inside the catch and returns.
    "tool.execute.before": async (input, output) => {
      let decision: GateDecision | null = null
      try {
        if (!WATCHED_WRITE_TOOLS.has(input.tool)) return
        decision = await gateDecision(gateHost, input, output)
      } catch (error: unknown) {
        await logHookFailure(logClient, "tool.execute.before", error, {
          toolName: input?.tool,
          sessionID: input?.sessionID,
          callID: input?.callID,
        })
        return
      }
      if (decision) {
        throw new Error(formatGateMessage(decision.filePath, decision.token, decision.ref, decision.description))
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        const isAkmTool = input.tool.startsWith("akm_")
        // The SDK type for `tool.execute.after` input does not expose `directory`,
        // but the OpenCode runtime does provide it for tool-scoped hooks. Read
        // it via a structural cast so we get the value when present without
        // accepting `any` everywhere it's used.
        const inputDirectory = (input as { directory?: unknown }).directory
        const directory = typeof inputDirectory === "string" ? inputDirectory : undefined

        const toolArgs = (input.args ?? {}) as Record<string, unknown>
        const { refs: allRefs } = await feedbackTracker.observeToolRefs({
          sessionID: input.sessionID,
          tool: input.tool,
          callID: input.callID,
          args: toolArgs,
          outputText: output.output,
          getBundleDir: () => getAkmBundleDir(logClient),
          directory,
          writeEvent: writeStructuredEvent,
        })

        // #99 write gate, read side. `read` is the tool that precedes every
        // trajectory in the failing cell: the model reads /app/service.yaml,
        // then edits it from guesswork. Recording what the file declares about
        // itself here is what lets the gate on the NEXT edit be file-anchored
        // instead of another sentence asking the model to go looking.
        if (input.tool === "read") {
          observeFileIdentity(gateHost, input.sessionID, directory, (input.args as Record<string, unknown>)?.filePath, output.output)
        }
        // `write` is deliberately NOT an identity source. It used to be, on a
        // "write a file, then edit it" argument, and that shape is a CREATE: the
        // content the model would be gated on is content it just invented, so
        // the gate would have reached into the two create cells (#99 review).
        // See observeFileIdentity() for the full reasoning. The create is
        // instead RECORDED on the write's `tool.execute.before` pass, which the
        // runtime always runs for a watched tool — see isSessionCreate().

        if (!isAkmTool) return

        const parsed = parseToolOutput(output.output)
        if (!parsed) return

        const feedback = classifyToolFeedback(parsed)
        if (feedback) {
          await writePluginLog(logClient, feedback === "negative" ? "warn" : "info", "AKM tool call result", {
            subsystem: "akm",
            outcome: feedback === "negative" ? "failed" : "ok",
            toolName: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
            title: output.title,
            refs: allRefs,
            error: typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error?: string }).error : undefined,
          })
        }

        const memoryRefs = extractMemoryRefs(input.tool, input.args as Record<string, unknown>, parsed)
        if (memoryRefs.length > 0) {
          await writePluginLog(logClient, "info", "AKM memory usage recorded", {
            subsystem: "memory",
            toolName: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
            refs: memoryRefs,
          })
        }

        const observed = feedbackTracker.observeAkmToolResult({
          sessionID: input.sessionID,
          tool: input.tool,
          callID: input.callID,
          args: toolArgs,
          parsed,
          directory,
          writeEvent: writeStructuredEvent,
        })
        // #99: a ref the model has already opened must never buy it a blocked
        // edit. Without this the compliant model gets re-blocked for doing
        // exactly what the gate asked.
        //
        // akm_curate counts as well as akm_show (#99 review). Curate is the
        // PRIMARY lookup command this plugin's own guidance tells the model to
        // reach for, and its result carries the ref and the one-line
        // description the gate message would have handed over — a model that
        // curated has already done the lookup. Crediting only akm_show made the
        // gate fire on the compliant create-shaped trajectory, which is one of
        // the cells whose movement has to stay readable as noise.
        //
        // ...and only when the lookup SUCCEEDED. extractToolRefs() reads
        // `args.ref` as well as the output, so an akm_show for a ref that does
        // not exist — `{ok:false,error:"not found"}` — used to credit the model
        // with having opened it. That put a row in the ledger asserting an
        // outcome that did not happen, and it is precisely the row an analyst
        // reads as "the model complied" (#99 review). classifyToolFeedback()
        // already types a failed akm call as negative; reuse it rather than
        // inventing a second notion of failure.
        if ((input.tool === "akm_show" || input.tool === "akm_curate") && !observed.failedCall) {
          noteShownRefs(input.sessionID, observed.refs)
        }

        // No feedback is submitted from a tool outcome. A successful akm_show /
        // akm_search / akm_curate only inspected a concept (viewing is not
        // using), the other akm tools write memories or are feedback themselves,
        // and a FAILED akm call says nothing about the asset's content (akm#999):
        // submitting `--negative` for it made akm's distill write lessons about
        // the error. The failure is logged above as a warning that names its
        // refs. OpenCode's automatic feedback is the retrospective channel in
        // chat.message — the user saying it worked.
      } catch (error: unknown) {
        await writePluginLog(logClient, "error", "AKM tool.execute.after hook failed", {
          subsystem: "hook",
          hook: "tool.execute.after",
          toolName: input?.tool,
          sessionID: input?.sessionID,
          callID: input?.callID,
          error: formatCliError(error),
        })
      }
    },
    tool: {
      akm_search: tool({
        // Tool descriptions are the only AKM channel that survives every
        // request (the system transform's doctrine block can be budget-trimmed
        // and the README is never in context), so the discovery doctrine —
        // curate first, show before relying, feedback after — is restated here
        // rather than living only in AKM_HINTS_PREFIX.
        description: TOOL_SPECS.akm_search.description,
        args: v1Args(TOOL_SPECS.akm_search),
        async execute({ query, type, limit, source, include_proposed }: { query?: string; type?: string; limit?: number; source?: string; include_proposed?: boolean }, context) {
          const raw = await runInProcess(
            client as unknown as LogCapableClient,
            "search",
            {
              query: query ?? "",
              type: type === "any" ? undefined : type,
              limit,
              source,
              includeProposed: include_proposed,
            },
            { toolName: "akm_search", sessionID: context.sessionID, directory: context.directory },
          )
          return withProposedWarnings(raw)
        },
      }),
      akm_show: tool({
        description: TOOL_SPECS.akm_show.description,
        args: v1Args(TOOL_SPECS.akm_show),
        async execute({ ref, detail }: { ref: string; detail?: string }, toolContext) {
          return runInProcess(
            client as unknown as LogCapableClient,
            "show",
            { ref, detail },
            { toolName: "akm_show", sessionID: toolContext.sessionID, directory: toolContext.directory },
          )
        },
      }),
      akm_remember: tool({
        description: TOOL_SPECS.akm_remember.description,
        args: v1Args(TOOL_SPECS.akm_remember),
        async execute({ content, name, force }: { content: string; name?: string; force?: boolean }, context) {
          const args = buildRememberArgs({ content, name, force }, context as unknown as Record<string, unknown>)
          return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_remember", sessionID: context.sessionID, directory: context.directory })
        },
      }),
      akm_feedback: tool({
        description: TOOL_SPECS.akm_feedback.description,
        args: v1Args(TOOL_SPECS.akm_feedback),
        async execute({ ref, sentiment, note, replace, with: corrections, source }: { ref: string; sentiment: "positive" | "negative"; note?: string; replace?: string[]; with?: string[]; source?: string }, context) {
          const built = buildFeedbackArgs({ ref, sentiment, note, replace, with: corrections, source })
          if ("refusal" in built) {
            await writePluginLog(logClient, "warn", "AKM feedback refused", {
              subsystem: "feedback",
              toolName: "akm_feedback",
              sessionID: context.sessionID,
              directory: context.directory,
              ref,
              sentiment,
              error: built.refusal,
            })
            return JSON.stringify({ ok: false, error: built.refusal })
          }
          const args = built.args
          const raw = await runCli(client as unknown as LogCapableClient, args, { toolName: "akm_feedback", sessionID: context.sessionID, directory: context.directory })
          const parsed = safeJsonParse<{ ok?: boolean; error?: string }>(raw)
          if (parsed?.ok === false) {
            const error = parsed.error ?? "Unknown akm feedback error"
            if (isNotIndexedFeedbackError(error)) {
              await writePluginLog(logClient, "warn", "AKM feedback skipped", {
                subsystem: "feedback",
                toolName: "akm_feedback",
                sessionID: context.sessionID,
                directory: context.directory,
                ref,
                sentiment,
                reason: "ref_not_indexed",
                error,
              })
              await emitWorkflowTelemetry(logClient, "warn", "akm.feedback.skipped", {
                sessionID: context.sessionID,
                toolName: "akm_feedback",
                assetRef: ref,
                outcome: "skipped",
                reason: "ref not indexed",
                directory: context.directory,
              })
              return JSON.stringify({ ok: true, skipped: true, reason: "ref_not_indexed", ref, sentiment })
            }
            return raw
          }
          await emitWorkflowTelemetry(logClient, "info", "akm.feedback.recorded", {
            sessionID: context.sessionID,
            toolName: "akm_feedback",
            assetRef: ref,
            outcome: "success",
            reason: sentiment,
            directory: context.directory,
          })
          return raw
        },
      }),
      akm_curate: tool({
        // Led with the mechanism ("describe the task in natural language and
        // this returns the top matches"), which reads as project/asset
        // discovery and lost to built-in read/glob/skill on edit-shaped tasks:
        // across seven models screened on one akm-relevant task, five made
        // zero akm_* calls while curation was demonstrably available (#95).
        // Leading with the decision — when to reach for this instead of just
        // reading the file — is what it has to win on.
        description: TOOL_SPECS.akm_curate.description,
        args: v1Args(TOOL_SPECS.akm_curate),
        async execute({ query, type, limit, source, pack }: { query: string; type?: string; limit?: number; source?: string; pack?: number }, context) {
          return runInProcess(
            client as unknown as LogCapableClient,
            "curate",
            { query, type: type === "any" ? undefined : type, limit, source, pack },
            { toolName: "akm_curate", sessionID: context.sessionID, directory: context.directory },
          )
        },
      }),
    },
  }
}

// A single named export only. The @opencode-ai/plugin loader initializes
// every exported plugin function it finds in this module, so exporting the
// same function again under a second name (`server`) or bundled into a
// default export risks the host registering — and running — the plugin's
// hooks twice (double auto-feedback, double session-start curates, etc.).
// The SDK's own example plugin (dist/example.js) exports exactly one named
// const with no default export; that is the blessed shape.
//
// "Only" means ONLY, including test helpers — issue #86. Two `__*ForTests`
// functions were exported alongside this one, and the loader dutifully called
// them as plugin factories. Those helpers return void, so the host then read
// `.config` off `undefined` and every OpenCode session using akm-opencode@0.9.0
// died at startup with "undefined is not an object (evaluating 'N.config')".
//
// Hanging the helpers off the plugin function keeps them reachable from tests
// while leaving exactly one module export for the loader to find. The guard is
// in tests/opencode-plugin.test.ts and asserts the whole export list, not a
// denylist of names that have already burned us once.
export const AkmPlugin = Object.assign(akmPlugin, {
  __curatedDirForTests,
  // #110 — AKM_CURATE_MIN_SCORE / AKM_CURATE_TYPE are read into module-level
  // consts at import, so the only way to cover the env -> behaviour wiring is
  // to import this module afresh under a chosen environment. bun:test's
  // `mock.module` is process-global for a whole `bun test tests/` run (see
  // tests/fake-akm-contract.test.ts's header), so a second in-process test
  // file that re-imports here would leak into tests/opencode-plugin.test.ts.
  // tests/opencode-curate-floor.test.ts therefore drives these two seams from
  // a subprocess instead, which shares no module registry with anything.
  __buildCurateOptionsForTests: buildCurateOptions,
  __renderCuratedJsonResponseForTests: renderCuratedJsonResponse,
  __resetWriteGateForTests: resetWriteGateForTests,
  __extractFormatIdentity: extractFormatIdentity,
  __assetDeclaresFormat: assetDeclaresFormat,
  __formatGateMessage: formatGateMessage,
  __watchedWriteTools: WATCHED_WRITE_TOOLS,
})
