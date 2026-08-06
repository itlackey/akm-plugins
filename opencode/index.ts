import { type Plugin, tool } from "@opencode-ai/plugin"
// @ts-expect-error akm-cli does not publish declarations for this in-process entrypoint.
import { akmCurate } from "akm-cli/dist/commands/read/curate.js"
// @ts-expect-error akm-cli does not publish declarations for this in-process entrypoint.
import { akmSearch } from "akm-cli/dist/commands/read/search.js"
// @ts-expect-error akm-cli does not publish declarations for this in-process entrypoint.
import { akmShowUnified } from "akm-cli/dist/commands/read/show.js"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { classifyFeedbackSignal, shouldSubmitAutomaticFeedback } from "../claude/shared/feedback-signals"
import { appendCandidates, extractCandidatesFromText, getCandidateLogPath } from "../claude/shared/memory-candidates"
import { appendMemoryEvent, getEventLogPath, type AkmMemoryEvent } from "../claude/shared/memory-events"
import { AKM_VERSION_RANGE, satisfiesAkmVersionRange } from "../claude/shared/akm-version"
import { shouldRecall } from "../claude/shared/recall-policy"
import { redactObject } from "../claude/shared/redaction"
import { extractAkmRefsFromString, validateRefCandidates } from "../claude/shared/ref-extraction"

let resolvedAkmCommand = "akm"

// Test-only: reset the module-level resolved-CLI cache so each test resolves
// the akm command fresh under its own sandboxed env (HOME / AKM_OPENCODE_*).
// Without this, the first test to resolve pins `resolvedAkmCommand` for the
// rest of the process (resolveAkmCommand short-circuits on a still-valid
// cached command), making later resolution tests order-dependent.
export function __resetResolvedAkmForTests(): void {
  resolvedAkmCommand = "akm"
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const SEMVER_PATTERN = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/
// The version contract lives in the shared module (also used by the Claude
// hook). satisfiesAkmVersionRange() routes through the same vendored semver
// matcher; AKM_REQUIRED_VERSION_RANGE is just the display alias used in the
// diagnostics below.
const AKM_REQUIRED_VERSION_RANGE = AKM_VERSION_RANGE
// The consent banner's "install this" recommendation is deliberately a single
// version floor rather than the full AKM_VERSION_RANGE (which is an
// OR-list of accepted ranges, not a valid single npm install specifier).
// Keep it in sync with the lowest currently-recommended stable 0.9.x release.
const AKM_RECOMMENDED_INSTALL_REF = "akm-cli@^0.9.0"

const AKM_AUTO_FEEDBACK = (process.env.AKM_AUTO_FEEDBACK ?? "1") !== "0"
const AKM_AUTO_MEMORY = (process.env.AKM_AUTO_MEMORY ?? "1") !== "0"
const AKM_AUTO_CURATE = (process.env.AKM_AUTO_CURATE ?? "1") !== "0"
const AKM_AUTO_HINTS = (process.env.AKM_AUTO_HINTS ?? "1") !== "0"
const AKM_PENDING_PROPOSAL_TIMEOUT_MS = Math.max(500, (Number(process.env.AKM_PENDING_PROPOSAL_TIMEOUT ?? "2") || 2) * 1_000)
const AKM_CURATE_LIMIT = Math.max(1, Number(process.env.AKM_CURATE_LIMIT ?? "5") || 5)
const AKM_CURATE_MIN_CHARS = Math.max(1, Number(process.env.AKM_CURATE_MIN_CHARS ?? "16") || 16)
const AKM_CURATE_TIMEOUT_MS = Math.max(1_000, (Number(process.env.AKM_CURATE_TIMEOUT ?? "8") || 8) * 1_000)
// 13: "Memory leaks" — sessionBuffer previously grew without bound for the
// life of a session (a long-running session accumulates one entry per
// observed tool ref / memory intent). Cap it drop-oldest, matching the
// `.slice(-8)` cap style already used by retrospectiveState.recentRefs.
const AKM_SESSION_BUFFER_MAX_ENTRIES = Math.max(1, Number(process.env.AKM_SESSION_BUFFER_MAX_ENTRIES ?? "200") || 200)
// Best-effort sweep age for orphaned curated tmp files (os.tmpdir()/akm-opencode/curated).
// A session that ends without ever firing session.deleted (host crash, forced
// kill) would otherwise leak its curated file on disk forever.
const CURATED_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const AKM_RETROSPECTIVE_FEEDBACK_RE = createRetrospectiveFeedbackRegex()
const AKM_RETROSPECTIVE_NEGATIVE_RE = createRetrospectiveNegativeRegex()
const AKM_EXPLICIT_CORRECTION_RE = createExplicitCorrectionRegex()
const PLUGIN_VERSION = readPackageVersion()
const OPENCODE_EVENT_LOG = getEventLogPath("opencode")
const OPENCODE_CANDIDATE_LOG = getCandidateLogPath("opencode")

// Per-session state that drives the compound-engineering loop.
// These maps are keyed by OpenCode sessionID.
const sessionHints = new Map<string, string>()
const sessionCurated = new Map<string, string>()
const sessionWorkflow = new Map<string, string>()
const sessionCuratorReport = new Map<string, string>()
const sessionContextEpoch = new Map<string, number>()
const sessionContextInjectedEpoch = new Map<string, number>()
const sessionCuratedFile = new Map<string, string>()
const sessionCuratedVersion = new Map<string, number>()
const sessionCuratedInjectedVersion = new Map<string, number>()
const sessionRecallAudit = new Map<string, { shouldRecall: boolean; reason: string; query: string; injectedRefs: string[]; injectedChars: number; warnings: string[] }>()
type SessionBufferEntry = {
  timestamp: string
  kind: "memory-intent" | "tool-ref"
  toolName?: string
  ref?: string
  status?: "positive" | "negative" | "unknown"
  note?: string
  checkpointed?: boolean
}
const sessionBuffer = new Map<string, SessionBufferEntry[]>()
// Event-driven extraction (opencode): opencode has no true "session end" event
// and `session.idle` fires after EVERY turn. To avoid flooding extract while a
// session is actively worked, we min-interval-gate per session — at most one
// extract per AKM_EXTRACT_MIN_INTERVAL_MS. The akm content-hash ledger
// (akm-cli #602 / ≥0.9.0-beta.33) further no-ops unchanged content for free.
// The hourly `akm improve` extract pass (the periodic backstop) catches the
// final delta after the last turn.
const sessionLastExtractAt = new Map<string, number>()
const AKM_EXTRACT_MIN_INTERVAL_MS = (() => {
  const raw = Number(process.env.AKM_EXTRACT_MIN_INTERVAL_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60 * 1000 // default 10 min
})()
const pendingProposalSummaryCache = new Map<string, { count: number; expiresAt: number; unsupported?: boolean }>()
const retrospectiveState = new Map<string, { recentRefs: string[]; lastNegativeSignalAt?: number }>()
let cachedAkmBundleDir: string | undefined

// Passive ref observation (narrower than explicit show/search input, so
// ordinary repository paths cannot become automatic feedback targets) lives in
// claude/shared/ref-extraction.ts. This module deliberately keeps no local copy
// of the concept-root regex: a second copy silently drifted from the canonical
// AKM 0.9 root list (it still matched `wikis/` and never matched `facts/`,
// `instructions/`, or `sessions/`). extractAkmRefsFromString() is the shared
// whitespace-token extractor and is the single source of truth here.
const PROPOSED_QUALITY_WARNING = "Do not treat proposed assets as curated until accepted."
const AKM_WORKFLOW_INSTRUCTION = [
  "# AKM workflow (v0.9)",
  "",
  "Use AKM as a reusable knowledge and workflow stash.",
  "",
  "Before writing from scratch:",
  "1. Use `akm_curate` with a query that includes the current project name/domain (primary discovery). Fall back to `akm_search` only when you already know an asset exists and need its exact ref.",
  "2. Use `akm_show <ref>` before relying on an asset.",
  "3. Record `akm_feedback` after the result is known.",
  "4. Use `akm_remember` to preserve durable project knowledge.",
  `5. ${PROPOSED_QUALITY_WARNING}`,
].join("\n")

function readPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(moduleDir, "package.json"), "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function createRetrospectiveFeedbackRegex(): RegExp {
  const pattern = process.env.AKM_RETROSPECTIVE_FEEDBACK_PATTERN ?? "\\b(thanks|perfect|worked)\\b"
  try {
    return new RegExp(pattern, "i")
  } catch {
    return /\b(thanks|perfect|worked)\b/i
  }
}

function createRetrospectiveNegativeRegex(): RegExp {
  const pattern = process.env.AKM_RETROSPECTIVE_NEGATIVE_PATTERN ?? "\\b(wrong|failed|broken|didn't work|did not work|bad)\\b"
  try {
    return new RegExp(pattern, "i")
  } catch {
    return /\b(wrong|failed|broken|didn't work|did not work|bad)\b/i
  }
}

function createExplicitCorrectionRegex(): RegExp {
  return /\b(this was wrong|that was wrong|you were wrong|incorrect|not correct)\b/i
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
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return "The 'akm' CLI was not found on PATH. Install it first from https://github.com/itlackey/akm."
  }
  return error instanceof Error ? error.message : String(error)
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

function buildEventScope(sessionID?: string, directory?: string, agent?: string) {
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

function writeStructuredEvent(event: Omit<AkmMemoryEvent, "version" | "timestamp" | "harness">) {
  return appendMemoryEvent(OPENCODE_EVENT_LOG, {
    version: 1,
    timestamp: nowIso(),
    harness: "opencode",
    ...event,
  })
}

const CURATED_DIR = path.join(os.tmpdir(), "akm-opencode", "curated")
mkdirSync(CURATED_DIR, { recursive: true })

function gatherCwdContext(directory: string): string {
  const parts: string[] = []
  const indicators: Array<{ file: string; label: string }> = [
    { file: "package.json", label: "Node" },
    { file: "Cargo.toml", label: "Rust" },
    { file: "pyproject.toml", label: "Python" },
    { file: "go.mod", label: "Go" },
    { file: "Gemfile", label: "Ruby" },
    { file: "Makefile", label: "Make" },
    { file: "Dockerfile", label: "Docker" },
    { file: "docker-compose.yml", label: "Docker Compose" },
    { file: ".github/workflows", label: "GitHub Actions" },
    { file: "composer.json", label: "PHP" },
  ]
  for (const indicator of indicators) {
    try {
      if (existsSync(path.join(directory, indicator.file))) parts.push(indicator.label)
    } catch {}
  }
  try {
    const pkgPath = path.join(directory, "package.json")
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
      if (pkg.name) parts.push(pkg.name)
      if (pkg.description) parts.push(String(pkg.description).slice(0, 120))
    }
  } catch {}
  try {
    const readme = path.join(directory, "README.md")
    if (existsSync(readme)) {
      const firstContent = readFileSync(readme, "utf8").split("\n").find((l) => l.trim() && !l.startsWith("#"))
      if (firstContent) parts.push(firstContent.trim().slice(0, 100))
    }
  } catch {}
  return parts.join(", ")
}

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

function nowIso(): string {
  return new Date().toISOString()
}

function shouldIndexOnSessionEnd(): boolean {
  return (process.env.AKM_INDEX_ON_SESSION_END ?? "0") === "1"
}

function addBufferEntry(sessionID: string | undefined, entry: Omit<SessionBufferEntry, "timestamp">) {
  if (!sessionID) return
  const buf = sessionBuffer.get(sessionID) ?? []
  buf.push({ timestamp: nowIso(), ...entry })
  // Drop-oldest cap (13: "Memory leaks" — sessionBuffer was uncapped).
  if (buf.length > AKM_SESSION_BUFFER_MAX_ENTRIES) buf.splice(0, buf.length - AKM_SESSION_BUFFER_MAX_ENTRIES)
  sessionBuffer.set(sessionID, buf)
}

function markContextEpochDirty(sessionID: string) {
  sessionContextEpoch.set(sessionID, (sessionContextEpoch.get(sessionID) ?? 0) + 1)
}

function bumpCuratedVersion(sessionID: string) {
  sessionCuratedVersion.set(sessionID, (sessionCuratedVersion.get(sessionID) ?? 0) + 1)
}

function writeCuratedFile(sessionID: string, content: string): string {
  const sanitized = sessionID.replace(/[^A-Za-z0-9._-]/g, "_")
  const filePath = path.join(CURATED_DIR, `${sanitized}.md`)
  try {
    writeFileSync(filePath, content)
    sessionCuratedFile.set(sessionID, filePath)
  } catch {}
  return filePath
}

// 13: "Memory leaks" — session.deleted cleanup only cleared sessionHints,
// sessionCurated, sessionWorkflow, sessionCuratorReport, the epoch/version
// tracking pairs, and sessionBuffer. It missed retrospectiveState,
// sessionRecallAudit, and the per-session pendingProposalSummaryCache entry
// (cacheKey is the sessionID — see getPendingProposalCount), and never
// deleted the session's curated tmp file. clearSessionState() is the single
// place every session-keyed Map/tmp-file is torn down, so a future new map
// would only need one line added here instead of another hand-maintained list
// at the session.deleted call site.
function clearSessionState(sessionID: string): void {
  sessionHints.delete(sessionID)
  sessionCurated.delete(sessionID)
  const curatedFile = sessionCuratedFile.get(sessionID)
  if (curatedFile) {
    try {
      rmSync(curatedFile, { force: true })
    } catch {
      // Best-effort: a failed tmp-file cleanup must not block session teardown.
    }
  }
  sessionCuratedFile.delete(sessionID)
  sessionWorkflow.delete(sessionID)
  sessionCuratorReport.delete(sessionID)
  sessionContextEpoch.delete(sessionID)
  sessionContextInjectedEpoch.delete(sessionID)
  sessionCuratedVersion.delete(sessionID)
  sessionCuratedInjectedVersion.delete(sessionID)
  sessionBuffer.delete(sessionID)
  sessionLastExtractAt.delete(sessionID)
  sessionRecallAudit.delete(sessionID)
  pendingProposalSummaryCache.delete(sessionID)
  retrospectiveState.delete(sessionID)
}

// Test-only: snapshot which session-keyed Maps still hold an entry for `sid`,
// plus the current sessionBuffer contents. Lets tests assert clearSessionState()
// actually emptied every map (13: "Memory leaks") without exporting the maps
// themselves. Mirrors the __resetResolvedAkmForTests test-only export above.
export function __sessionStateSnapshotForTests(sessionID: string): {
  sessionHints: boolean
  sessionCurated: boolean
  sessionCuratedFile: boolean
  sessionWorkflow: boolean
  sessionCuratorReport: boolean
  sessionContextEpoch: boolean
  sessionContextInjectedEpoch: boolean
  sessionCuratedVersion: boolean
  sessionCuratedInjectedVersion: boolean
  sessionBuffer: boolean
  sessionBufferLength: number
  sessionBufferRefs: string[]
  sessionLastExtractAt: boolean
  sessionRecallAudit: boolean
  pendingProposalSummaryCache: boolean
  retrospectiveState: boolean
} {
  return {
    sessionHints: sessionHints.has(sessionID),
    sessionCurated: sessionCurated.has(sessionID),
    sessionCuratedFile: sessionCuratedFile.has(sessionID),
    sessionWorkflow: sessionWorkflow.has(sessionID),
    sessionCuratorReport: sessionCuratorReport.has(sessionID),
    sessionContextEpoch: sessionContextEpoch.has(sessionID),
    sessionContextInjectedEpoch: sessionContextInjectedEpoch.has(sessionID),
    sessionCuratedVersion: sessionCuratedVersion.has(sessionID),
    sessionCuratedInjectedVersion: sessionCuratedInjectedVersion.has(sessionID),
    sessionBuffer: sessionBuffer.has(sessionID),
    sessionBufferLength: sessionBuffer.get(sessionID)?.length ?? 0,
    sessionBufferRefs: (sessionBuffer.get(sessionID) ?? []).flatMap((entry) => (entry.ref ? [entry.ref] : [])),
    sessionLastExtractAt: sessionLastExtractAt.has(sessionID),
    sessionRecallAudit: sessionRecallAudit.has(sessionID),
    pendingProposalSummaryCache: pendingProposalSummaryCache.has(sessionID),
    retrospectiveState: retrospectiveState.has(sessionID),
  }
}

// Test-only: expose the curated tmp-file directory so tests can assert file
// existence/absence without hardcoding os.tmpdir() path construction twice.
export function __curatedDirForTests(): string {
  return CURATED_DIR
}

// Best-effort sweep of orphaned curated tmp files (13: "tmp-file cleanup").
// clearSessionState() handles the normal session.deleted path; this covers
// sessions that never fire it (host crash, forced kill). Async and fully
// error-trapped internally so a failed sweep never surfaces as an unhandled
// rejection or blocks the session.created path that triggers it.
async function pruneStaleCuratedFiles(): Promise<void> {
  let entries: string[]
  try {
    entries = readdirSync(CURATED_DIR)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    try {
      const filePath = path.join(CURATED_DIR, name)
      const info = statSync(filePath)
      if (now - info.mtimeMs > CURATED_FILE_MAX_AGE_MS) rmSync(filePath, { force: true })
    } catch {
      // Best-effort per-file: a single stat/rm failure must not abort the sweep.
    }
  }
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
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

function getScopeFields(): Array<"user" | "agent" | "run" | "channel"> {
  const configured = process.env.AKM_SCOPE_KEYS?.split(",").map((part) => part.trim()).filter(Boolean)
  const values = configured && configured.length > 0 ? configured : ["user", "agent", "run", "channel"]
  return values.filter((value): value is "user" | "agent" | "run" | "channel" =>
    value === "user" || value === "agent" || value === "run" || value === "channel",
  )
}

function buildScopedArgs(context: Record<string, unknown> | undefined): string[] {
  if (!context) return []
  const scopeFields = new Set(getScopeFields())
  const args: string[] = []
  const user = typeof context.userID === "string"
    ? context.userID
    : typeof context.user === "string"
      ? context.user
      : undefined
  const agent = typeof context.agent === "string" ? context.agent : undefined
  const run = typeof context.sessionID === "string" ? context.sessionID : typeof context.run === "string" ? context.run : undefined
  const channel = typeof context.channel === "string"
    ? context.channel
    : typeof context.variant === "string"
      ? context.variant
      : undefined

  if (scopeFields.has("user") && user) args.push("--user", user)
  if (scopeFields.has("agent") && agent) args.push("--agent", agent)
  if (scopeFields.has("run") && run) args.push("--run", run)
  if (scopeFields.has("channel") && channel) args.push("--channel", channel)
  return args
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

async function runCurateLogged(
  client: LogCapableClient,
  args: string[],
  meta: CliLogMeta & { operation: string },
): Promise<string | null> {
  return runCliSyncBestEffort(client, args, AKM_CURATE_TIMEOUT_MS, {
    ...meta,
    subsystem: "curation",
  })
}

async function runCurateForPrompt(client: LogCapableClient, text: string, sessionID?: string): Promise<string | null> {
  if (!text || text.length < AKM_CURATE_MIN_CHARS) return null
  return runCurateLogged(client,
    [
      "--shape",
      "agent",
      "--format",
      "text",
      "-q",
      "curate",
      text,
      "--limit",
      String(AKM_CURATE_LIMIT),
    ],
    { toolName: "chat.message", sessionID, operation: "prompt-curate" },
  )
}

async function runCurateForSession(client: LogCapableClient, sessionID: string, query?: string): Promise<string | null> {
  const args = [
    "--shape",
    "agent",
    "--format",
    "text",
    "-q",
    "curate",
  ]
  if (query) args.push(query)
  args.push("--limit", String(AKM_CURATE_LIMIT))
  return runCurateLogged(client,
    args,
    { toolName: "session.start", sessionID, operation: "session-curate" },
  )
}

async function runHintsForSession(client: LogCapableClient, sessionID?: string): Promise<string | null> {
  return runCliSyncBestEffort(client, ["--format", "text", "-q", "hints"], AKM_CURATE_TIMEOUT_MS, {
    toolName: "session.start",
    sessionID,
    subsystem: "hints",
    operation: "session-hints",
  })
}

function summarizeWorkflowList(value: unknown): string | null {
  if (Array.isArray(value)) {
    const lines = value
      .map((item) => {
        if (!item || typeof item !== "object") return null
        const record = item as Record<string, unknown>
        const id = typeof record.runId === "string"
          ? record.runId
          : typeof record.id === "string"
            ? record.id
            : null
        const ref = typeof record.ref === "string"
          ? record.ref
          : typeof record.workflowRef === "string"
            ? record.workflowRef
            : null
        const state = typeof record.state === "string" ? record.state : typeof record.status === "string" ? record.status : null
        // akm 0.9.0 run summaries carry `currentStepId`; `step`/`currentStep`
        // are retained as fallbacks for older envelope shapes.
        const step = typeof record.currentStepId === "string"
          ? record.currentStepId
          : typeof record.step === "string"
            ? record.step
            : typeof record.currentStep === "string"
              ? record.currentStep
              : null
        if (!id && !ref && !state && !step) return null
        return `- ${ref ?? "workflow"} (${id ?? "run"})${state ? ` — ${state}` : ""}${step ? ` — next: ${step}` : ""}`
      })
      .filter((line): line is string => !!line)
    return lines.length > 0 ? lines.join("\n") : null
  }
  return null
}

async function runWorkflowSummaryForSession(client: LogCapableClient, sessionID?: string): Promise<string | null> {
  const raw = await runCliSyncBestEffort(client, ["--format", "json", "-q", "workflow", "list", "--active"], AKM_CURATE_TIMEOUT_MS, {
    toolName: "session.start",
    sessionID,
    subsystem: "workflow",
    operation: "active-workflow-summary",
  })
  if (!raw) return null
  const parsed = parseMaybeJson(raw)
  const summary = summarizeWorkflowList(
    Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as { runs?: unknown }).runs))
        ? (parsed as { runs: unknown[] }).runs
        : (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items))
          ? (parsed as { items: unknown[] }).items
          : [],
  )
  return summary
}

function formatWorkflowContext(summary: string): string {
  return `# AKM active workflows\n${summary}`
}

function formatCuratorReportContext(report: string): string {
  return `# AKM curator report\n${report}`
}

function formatPendingProposalContext(count: number): string {
  const summaryLine = count === 1 ? "There is 1 pending AKM proposal." : `There are ${count} pending AKM proposals.`
  return [
    "# AKM pending proposals",
    "",
    summaryLine,
    "Use the AKM CLI to review them; mutating proposal actions require explicit user approval.",
    PROPOSED_QUALITY_WARNING,
  ].join("\n")
}

async function getAkmBundleDir(client?: LogCapableClient): Promise<string | undefined> {
  const override = process.env.AKM_BUNDLE_DIR?.trim()
  if (override) return override
  if (cachedAkmBundleDir !== undefined) return cachedAkmBundleDir || undefined
  const raw = client
    ? await runCliSyncBestEffort(client, ["info", "--format", "json", "-q"], AKM_CURATE_TIMEOUT_MS, {
      toolName: "shell.env",
      subsystem: "info",
      operation: "get-bundle-dir",
    })
    : runCurate(["info", "--format", "json", "-q"])
  if (!raw) {
    cachedAkmBundleDir = ""
    return undefined
  }
  const parsed = parseMaybeJson(raw)
  if (parsed && typeof parsed === "object") {
    const value = (parsed as Record<string, unknown>).bundleDir
    if (typeof value === "string" && value.trim()) {
      cachedAkmBundleDir = value.trim()
      return cachedAkmBundleDir
    }
  }
  cachedAkmBundleDir = ""
  return undefined
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
  const mappedEvent: AkmMemoryEvent["event"] = eventType.includes("workflow_")
    ? eventType as AkmMemoryEvent["event"]
    : eventType.includes("blocked")
      ? "safety_blocked"
      : "workflow_step"
  void writeStructuredEvent({
    event: mappedEvent,
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

function noteRecentRefs(sessionID: string | undefined, refs: string[]) {
  if (!sessionID || refs.length === 0) return
  const state = retrospectiveState.get(sessionID) ?? { recentRefs: [] }
  state.recentRefs = [...new Set([...state.recentRefs, ...refs])].slice(-8)
  retrospectiveState.set(sessionID, state)
}

async function getPendingProposalCount(client: LogCapableClient, sessionID?: string): Promise<{ count: number; unsupported?: boolean }> {
  const cacheKey = sessionID ?? "global"
  const cached = pendingProposalSummaryCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached

  const command = resolveAkmCommand()
  if (typeof command === "object" && "ok" in command) return { count: 0, unsupported: true }
  try {
    // 0.8.0 canonical proposal-queue listing path: `akm proposal list`.
    const stdout = execResolvedAkm(command, ["proposal", "list", "--status", "pending", "--format", "json"], {
      encoding: "utf8",
      timeout: AKM_PENDING_PROPOSAL_TIMEOUT_MS,
    })
    const parsed = safeJsonParse<{ proposals?: unknown[]; hits?: unknown[] }>(stdout)
    const count = Array.isArray(parsed?.proposals) ? parsed.proposals.length : Array.isArray(parsed?.hits) ? parsed.hits.length : 0
    const result = { count, expiresAt: Date.now() + 60_000 }
    pendingProposalSummaryCache.set(cacheKey, result)
    return result
  } catch (error: unknown) {
    const message = formatCliError(error)
    const unsupported = /unknown|unsupported|not found|invalid/i.test(message)
    const result = { count: 0, unsupported, expiresAt: Date.now() + 60_000 }
    pendingProposalSummaryCache.set(cacheKey, result)
    return result
  }
}

async function recordRetrospectiveFeedback(client: LogCapableClient, sessionID: string | undefined, text: string) {
  if (!sessionID) return
  const state = retrospectiveState.get(sessionID)
  const recentRefs = state?.recentRefs ?? []
  if (recentRefs.length === 0) return

  const explicitCorrection = AKM_EXPLICIT_CORRECTION_RE.test(text)
  const negative = explicitCorrection || AKM_RETROSPECTIVE_NEGATIVE_RE.test(text)
  if (!negative) return

  if (!explicitCorrection) {
    const now = Date.now()
    if (!state?.lastNegativeSignalAt || now - state.lastNegativeSignalAt > 2 * 60 * 1000) {
      retrospectiveState.set(sessionID, { recentRefs, lastNegativeSignalAt: now })
      return
    }
  }

  const targetRef = recentRefs[recentRefs.length - 1]
  const raw = await runCli(client, ["feedback", targetRef, "--negative", "--reason", text.slice(0, 280)], {
    toolName: "akm_feedback",
    sessionID,
  })
  const parsed = safeJsonParse<{ ok?: boolean }>(raw)
  if (parsed?.ok === true) {
    await emitWorkflowTelemetry(client, "info", "akm.feedback.recorded", {
      sessionID,
      toolName: "akm_feedback",
      assetRef: targetRef,
      outcome: "success",
      reason: explicitCorrection ? "explicit correction" : "negative retrospective signal",
    })
  }
  retrospectiveState.set(sessionID, { recentRefs })
}

function queueFeedback(
  client: LogCapableClient,
  ref: string,
  sentiment: "positive" | "negative",
  note: string,
  meta: CliLogMeta,
  dedupe?: Set<string>,
): boolean {
  const dedupeKey = `${ref}:${sentiment}`
  if (dedupe?.has(dedupeKey)) return true
  dedupe?.add(dedupeKey)

  const command = resolveAkmCommand()
  if (typeof command === "object" && "ok" in command) {
    void writePluginLog(client, "warn", "AKM auto-feedback skipped", {
      subsystem: "feedback",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      ref,
      sentiment,
      error: command.error,
    })
    return false
  }

  try {
    const child = spawn(
      command.command,
      [
        ...command.argsPrefix,
        "feedback",
        ref,
        sentiment === "positive" ? "--positive" : "--negative",
        "--reason",
        note,
        "--format",
        "json",
        "-q",
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    )
    child.on("exit", (code, signal) => {
      if ((typeof code === "number" && code !== 0) || signal) {
        void writePluginLog(client, "warn", "AKM auto-feedback failed", {
          subsystem: "feedback",
          toolName: meta.toolName,
          sessionID: meta.sessionID,
          directory: meta.directory,
          ref,
          sentiment,
          error: signal
            ? `akm feedback exited via signal ${signal}`
            : `akm feedback exited with code ${code}`,
        })
      }
    })
    child.on("error", (error) => {
      void writePluginLog(client, "warn", "AKM auto-feedback failed", {
        subsystem: "feedback",
        toolName: meta.toolName,
        sessionID: meta.sessionID,
        directory: meta.directory,
        ref,
        sentiment,
        error: formatCliError(error),
      })
    })
    child.unref()
    return true
  } catch (error: unknown) {
    void writePluginLog(client, "warn", "AKM auto-feedback failed", {
      subsystem: "feedback",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      ref,
      sentiment,
      error: formatCliError(error),
    })
    return false
  }
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

// 03-R1/06-M1 kept half: the session_checkpoint `remember --force` write is
// gone, but the memory-candidate pipeline still harvests explicit
// "remember ..." intents from the session buffer at session end. There is no
// stash write and, as of 0.9, no in-product consumer either: the
// /akm-memory-promote slash command that used to review these was deleted in
// this release. Candidates are appended to the harness candidate log
// (getCandidateLogPath("opencode") -> …/akm-opencode/memory-candidates.jsonl)
// alongside a `candidate_extracted` structured event, and are read
// out-of-band. Whether to retire the pipeline or re-home the review step is a
// deliberately open maintainer decision, so the harvest stays wired up.
// Deleting the buffer after extraction is the de-dup: a re-fired lifecycle
// event finds an empty buffer and no-ops.
function maybeExtractSessionCandidates(sessionID: string, reason: string): void {
  if (!AKM_AUTO_MEMORY) return
  if (!sessionID) return
  const entries = sessionBuffer.get(sessionID) ?? []
  // Require at least two observations before persisting — single events are noise.
  if (entries.length < 2) {
    // Below the noise floor, only the terminal session.deleted event may
    // discard the buffer (the old discard-noise-at-session-end behavior).
    // Non-terminal events (session.idle fires at every turn's quiescence,
    // session.compacted mid-session) must KEEP a below-floor buffer so a
    // lone "remember ..." intent from one turn survives to pair with an
    // observation from a later turn instead of being wiped at each idle.
    if (reason === "session.deleted") sessionBuffer.delete(sessionID)
    return
  }
  const targetRefHints = entries.flatMap((entry) => (entry.ref ? [entry.ref] : []))
  const text = entries
    .filter((entry) => entry.kind === "memory-intent" && entry.note)
    .map((entry) => entry.note as string)
    .join("\n")
  const candidates = extractCandidatesFromText({
    harness: "opencode",
    sessionId: sessionID,
    text,
    evidence: [reason, ...targetRefHints],
    sourcePaths: [OPENCODE_EVENT_LOG, OPENCODE_CANDIDATE_LOG],
    targetRefHints,
  })
  if (candidates.length > 0) {
    appendCandidates(OPENCODE_CANDIDATE_LOG, candidates)
    void writeStructuredEvent({
      event: "candidate_extracted",
      sessionId: sessionID,
      scope: buildEventScope(sessionID),
      memory: { count: candidates.length },
      outcome: { status: "ok" },
    })
  }
  sessionBuffer.delete(sessionID)
}

function extractToolRefs(
  toolName: string,
  args: Record<string, unknown>,
  output: unknown,
): { refs: string[]; positiveOnlyRefs: string[] } {
  const refs = new Set<string>()
  const positiveOnlyRefs = new Set<string>()
  const addMatches = (value: unknown) => {
    if (typeof value !== "string") return
    for (const ref of extractAkmRefsFromString(value)) refs.add(ref)
  }

  for (const key of ["ref", "package_ref"]) {
    addMatches((args as Record<string, unknown>)[key])
  }

  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>
    addMatches(o.ref)
    if (Array.isArray(o.hits)) {
      for (const hit of o.hits) {
        if (hit && typeof hit === "object") addMatches((hit as Record<string, unknown>).ref)
      }
    }
    if (Array.isArray(o.assetHits)) {
      for (const hit of o.assetHits) {
        if (hit && typeof hit === "object") addMatches((hit as Record<string, unknown>).ref)
      }
    }
    if (toolName === "akm_remember" && typeof o.ref === "string") addMatches(o.ref)
  }

  return { refs: [...refs], positiveOnlyRefs: [...positiveOnlyRefs] }
}

function extractAkmRefsFromAllArgs(args: Record<string, unknown>): string[] {
  if (!args || typeof args !== "object") return []
  const refs = new Set<string>()
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      for (const ref of extractAkmRefsFromString(value)) refs.add(ref)
    } else if (typeof value === "object" && value !== null) {
      const serialized = JSON.stringify(value)
      for (const ref of extractAkmRefsFromString(serialized)) refs.add(ref)
    }
  }
  return [...refs]
}

const AKM_HINTS_PREFIX = [
  "# AKM is available in this session",
  "",
  "You have an AKM stash on this machine. Before writing anything from scratch, call `akm_curate` with a task description to find relevant assets with LLM-reranked relevance scores.",
  "",
  "**Choosing the right lookup command:**",
  "",
  "- **`akm_curate`** — use this when starting any new task, looking for patterns, docs, skills, or workflows. This is the PRIMARY lookup command. akm automatically boosts assets that match the current project (cwd-anchored project-context ranking), so an explicit project name in the query is not required for ranking — but it still helps the reranker frame intent.",
  '  - Good: `akm_curate("akm CLI improve command performance analysis")` (explicit framing, still ideal)',
  '  - Bad: `akm_curate("improve performance analysis")` (too generic — the reranker has less to work with even with auto-boost)',
  "- **`akm_search` (known name)** — use ONLY when you already know an asset exists (e.g. after `akm_show` returned \"not found\") and need to locate its exact ref. Do not use as a discovery tool.",
  "- **`akm_show <stash>//meta`** — when working in or with an unfamiliar stash, read its optional `.meta/` orientation (purpose, key assets, conventions, maintainer) before diving in. `akm_show meta` reads your working stash's `.meta/index.md`; `akm_show meta:<name>` reads other `.meta/` docs (e.g. `meta:about`). These docs are direct-read and never appear in `akm_search`.",
  "",
  "Record `akm_feedback <ref> positive|negative` whenever an asset materially helps or misses, and use `akm_remember` to persist durable learnings so future sessions inherit them.",
  "",
  AKM_WORKFLOW_INSTRUCTION,
].join("\n")

const AKM_CURATED_HEADER = "# AKM stash — assets relevant to this prompt"
const AKM_CURATED_TAIL = "\n\nTip: call `akm_show <ref>` to fetch full content, and record `akm_feedback <ref> positive|negative` once you know whether the asset helped."
const AKM_CONTEXT_TRUNCATED_MARKER = "\n\n[truncated for context]"

function getContextBudgetChars(): number {
  const parsed = Number(process.env.AKM_CONTEXT_BUDGET_CHARS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4000
}

function truncateContextBlock(block: string, maxChars: number): string {
  if (block.length <= maxChars) return block
  if (maxChars <= AKM_CONTEXT_TRUNCATED_MARKER.length) return block.slice(0, maxChars)
  return `${block.slice(0, maxChars - AKM_CONTEXT_TRUNCATED_MARKER.length)}${AKM_CONTEXT_TRUNCATED_MARKER}`
}

function applyContextBudget(blocks: string[]): string[] {
  const budget = getContextBudgetChars()
  const injected: string[] = []
  let remaining = budget
  for (const block of blocks) {
    if (!block) continue
    // The host effectively concatenates injected blocks into one prompt body;
    // we budget for a single newline separator between adjacent blocks.
    const separatorCost = injected.length > 0 ? 1 : 0
    if (remaining <= separatorCost) break
    const allowed = remaining - separatorCost
    if (block.length <= allowed) {
      injected.push(block)
      remaining -= separatorCost + block.length
      continue
    }
    const truncated = truncateContextBlock(block, allowed)
    if (truncated) injected.push(truncated)
    break
  }
  return injected
}

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

// Cap on how much of the extract child's stdout/stderr we retain for logging.
// The envelope we care about is a few hundred bytes; anything past this is
// dropped so a chatty/looping child can never grow the buffer unbounded.
const AKM_EXTRACT_OUTPUT_MAX_CHARS = 2_000

// `unref()` exists on the net.Socket that node hands back for a piped child
// stream, but not on the `Readable` the @types/node signature advertises.
// Unref'ing keeps the piped fds from holding the host's event loop open, which
// is what preserves the fire-and-forget contract now that stdio is captured.
function unrefChildStream(stream: unknown): void {
  const handle = stream as { unref?: () => void } | null | undefined
  if (handle && typeof handle.unref === "function") handle.unref()
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
 * This is the only remaining memory-harvest path in 0.9, and on a default
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

  try {
    const child = spawn(
      command.command,
      [...command.argsPrefix, "proposal", "extract", "--type", "opencode", "--session-id", sid, "--format", "json", "-q"],
      {
        detached: true,
        // Piped rather than ignored so the `ok:false` envelope is observable;
        // both pipes are unref'd below so this stays fire-and-forget.
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let output = ""
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      unrefChildStream(stream)
      stream.setEncoding("utf8")
      stream.on("data", (chunk: string) => {
        if (output.length < AKM_EXTRACT_OUTPUT_MAX_CHARS) output += chunk
      })
      // A pipe torn down with the detached child must not raise here.
      stream.on("error", () => {})
    }
    // "close" rather than "exit": it fires once the piped stdio has also been
    // drained, so `output` is complete when we inspect the envelope.
    child.on("close", (code, signal) => {
      const body = output.trim().slice(0, AKM_EXTRACT_OUTPUT_MAX_CHARS)
      const envelope = safeJsonParse<{ ok?: boolean; error?: string; code?: string; hint?: string }>(body)
      const exitFailed = (typeof code === "number" && code !== 0) || !!signal
      if (envelope?.ok === false || exitFailed) {
        const reason = envelope?.error
          ?? (signal ? `akm extract exited via signal ${signal}` : `akm extract exited with code ${code}`)
        reportExtractFailure(reason, {
          akmCode: envelope?.code,
          hint: envelope?.hint,
          exitCode: code,
          // Only fall back to the raw body when it was not parseable JSON —
          // otherwise the structured fields above already carry everything.
          output: envelope ? undefined : truncateLogText(body, 400) || undefined,
        })
        return
      }
      void writePluginLog(client, "info", "AKM extract completed", {
        subsystem: "extract",
        sessionID: sid,
        directory,
      })
    })
    child.on("error", (error) => {
      reportExtractFailure(formatCliError(error))
    })
    child.unref()
  } catch (error: unknown) {
    reportExtractFailure(formatCliError(error))
  }
}

function extractFirstSemverMatch(value: string): string | null {
  return value.match(SEMVER_PATTERN)?.[0] ?? null
}

function getCommandVersion(command: string): string | null {
  try {
    const version = execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    })
    return extractFirstSemverMatch(version)
  } catch {
    return null
  }
}

type ResolvedAkmCommand = {
  command: string
  argsPrefix: string[]
  displayCommand: string
}

type CommandProbe = {
  command: string
  argsPrefix: string[]
  displayCommand: string
  exists: boolean
  version: string | null
  failureReason: string | null
}

// Like getCommandVersion, but distinguishes "binary not found on disk" from
// "binary found but failed to produce a version" — the latter typically means
// the binary is corrupt, wrong architecture, or has a runtime dependency missing.
// Used by the diagnostic resolution trail so the consent banner can tell users
// which failure mode they're hitting.
function getLocalBuildAkmCommand(): ResolvedAkmCommand | null {
  const cliPath = process.env.AKM_LOCAL_BUILD_CLI?.trim()
  if (!cliPath) return null
  return {
    command: process.env.BUN || "bun",
    argsPrefix: [cliPath],
    displayCommand: cliPath,
  }
}

// Every call site passes `encoding: "utf8"`, so the real runtime return value
// is always a string — but `execFileSync`'s overloads resolve on the exact
// shape of the options argument, and forwarding a loosely-typed `options`
// parameter defeats that resolution, leaving the inferred return type
// `string | Buffer`. Pin the options type to require `encoding: "utf8"` and
// assert the (already-guaranteed) string return so callers get real string
// typing without changing behavior.
type ExecResolvedAkmOptions = Omit<NonNullable<Parameters<typeof execFileSync>[2]>, "encoding"> & {
  encoding: "utf8"
}

function execResolvedAkm(command: ResolvedAkmCommand, args: string[], options: ExecResolvedAkmOptions): string {
  return execFileSync(command.command, [...command.argsPrefix, ...args], options) as string
}

function probeCommand(command: ResolvedAkmCommand): CommandProbe {
  const displayIsAbsolute = path.isAbsolute(command.displayCommand)
  const displayExists = displayIsAbsolute ? existsSync(command.displayCommand) : true
  if (displayIsAbsolute && !displayExists) {
    return { ...command, exists: false, version: null, failureReason: "not_on_disk" }
  }
  const commandIsAbsolute = path.isAbsolute(command.command)
  const commandExists = commandIsAbsolute ? existsSync(command.command) : true
  if (commandIsAbsolute && !commandExists) {
    return { ...command, exists: false, version: null, failureReason: "command_not_on_disk" }
  }
  try {
    // Pipe (don't inherit) the child's stderr. Some akm builds validate the
    // user's config on EVERY invocation — including `--version` — and a version
    // skew (e.g. a bundled akm-cli@0.8.x against a config written by 0.9.x, whose
    // improve process keys 0.8 rejects) makes `--version` exit non-zero and print
    // an INVALID_CONFIG_FILE blob to stderr. With the default inherited stderr
    // that blob leaks to OpenCode's console on every plugin load, reading as a
    // plugin failure even though resolution correctly falls through to a
    // compatible akm. Capturing it keeps the probe silent; the structured
    // resolution trail / consent banner still surfaces a genuine no-akm case.
    const version = execResolvedAkm(command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const parsed = extractFirstSemverMatch(version)
    if (!parsed) {
      return { ...command, exists: true, version: null, failureReason: "no_semver_in_output" }
    }
    return { ...command, exists: true, version: parsed, failureReason: null }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") {
      return { ...command, exists: false, version: null, failureReason: "not_on_path" }
    }
    return { ...command, exists: true, version: null, failureReason: code ?? "version_check_failed" }
  }
}

function getBundledAkmCommand(): string | null {
  const packagePath = path.join(moduleDir, "node_modules", "akm-cli", "package.json")
  const fallback = path.join(moduleDir, "node_modules", ".bin", process.platform === "win32" ? "akm.cmd" : "akm")
  try {
    const raw = readFileSync(packagePath, "utf8")
    const pkg = JSON.parse(raw) as { bin?: unknown }
    const bin = pkg.bin
    const relativeBin = typeof bin === "string"
      ? bin
      : bin && typeof bin === "object" && typeof (bin as Record<string, unknown>).akm === "string"
        ? (bin as Record<string, string>).akm
        : null
    if (!relativeBin) return existsSync(fallback) ? fallback : null
    const bundledCommand = path.join(moduleDir, "node_modules", "akm-cli", relativeBin)
    return existsSync(bundledCommand) ? bundledCommand : existsSync(fallback) ? fallback : null
  } catch {
    return existsSync(fallback) ? fallback : null
  }
}

function getConfigNodeModulesAkmCommand(): string | null {
  const homeDir = process.env.HOME || os.homedir()
  const configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config")
  const configBin = path.join(configDir, "opencode", "node_modules", ".bin", process.platform === "win32" ? "akm.cmd" : "akm")
  return existsSync(configBin) ? configBin : null
}

function getPathAkmCandidates(): string[] {
  const candidates: string[] = []
  const configNodeModules = getConfigNodeModulesAkmCommand()
  if (configNodeModules) candidates.push(configNodeModules)
  candidates.push("akm")
  // Honor an explicit $HOME override (standard POSIX, and matches
  // getConfigNodeModulesAkmCommand). os.homedir() snapshots HOME at process
  // start and ignores later changes, which made this path non-sandboxable.
  const home = process.env.HOME || os.homedir()
  if (home) {
    candidates.push(path.join(home, ".local", "bin", process.platform === "win32" ? "akm.cmd" : "akm"))
  }
  return candidates
}

type AkmResolutionTrail = Array<{
  command: string
  source: "bundled" | "path" | "local_build"
  version: string | null
  outcome: "selected" | "version_out_of_range" | "missing" | "probe_failed"
  failureReason: string | null
}>

let lastAkmResolutionTrail: AkmResolutionTrail = []

function getResolvedAkmDetails(): { command: string; argsPrefix: string[]; displayCommand: string; version: string; source: "bundled" | "path" | "local_build" } | null {
  const candidates: Array<{ command: string; argsPrefix: string[]; displayCommand: string; source: "bundled" | "path" | "local_build" }> = []
  // Resolution precedence — first compatible candidate wins:
  //   1. AKM_LOCAL_BUILD_CLI  — explicit dev override
  //   2. PATH / user installs — the akm the user actually installed, which wrote
  //      their config and has its native deps (e.g. embeddings) built
  //   3. bundled akm-cli      — last-resort fallback for users with no akm
  // The bundled CLI is deliberately LAST: preferring it over the user's own
  // install would ignore a newer user akm that understands a newer config and
  // route through a bundled copy whose native postinstalls may be unbuilt. A
  // config-INCOMPATIBLE candidate fails its `--version` probe — older akm builds
  // validate config on every invocation and exit non-zero — so it is skipped
  // silently and the version probe doubles as a config-compatibility gate.
  const localBuild = getLocalBuildAkmCommand()
  if (localBuild) candidates.push({ ...localBuild, source: "local_build" })
  for (const command of getPathAkmCandidates()) {
    candidates.push({ command, argsPrefix: [], displayCommand: command, source: "path" })
  }
  // Opt-out (default off): drop the bundled fallback entirely. Used by the eval
  // harness so a deterministic fake `akm` on PATH is the only candidate; also a
  // useful escape hatch when the bundled dep is broken.
  const ignoreBundled = process.env.AKM_OPENCODE_IGNORE_BUNDLED_CLI === "1"
  const bundled = ignoreBundled ? null : getBundledAkmCommand()
  if (bundled) candidates.push({ command: bundled, argsPrefix: [], displayCommand: bundled, source: "bundled" })

  const trail: AkmResolutionTrail = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const cacheKey = `${candidate.command}::${candidate.argsPrefix.join(" ")}`
    if (!candidate.command || seen.has(cacheKey)) continue
    seen.add(cacheKey)
    const probe = probeCommand(candidate)
    if (!probe.exists) {
      trail.push({ command: candidate.displayCommand, source: candidate.source, version: null, outcome: "missing", failureReason: probe.failureReason })
      continue
    }
    if (probe.failureReason || !probe.version) {
      trail.push({ command: candidate.displayCommand, source: candidate.source, version: probe.version, outcome: "probe_failed", failureReason: probe.failureReason })
      continue
    }
    if (!satisfiesAkmVersionRange(probe.version)) {
      trail.push({ command: candidate.displayCommand, source: candidate.source, version: probe.version, outcome: "version_out_of_range", failureReason: null })
      continue
    }
    trail.push({ command: candidate.displayCommand, source: candidate.source, version: probe.version, outcome: "selected", failureReason: null })
    lastAkmResolutionTrail = trail
    return { ...candidate, version: probe.version }
  }
  lastAkmResolutionTrail = trail
  return null
}

// The OpenCode plugin has never silently auto-installed akm-cli — it relies on
// the bundled binary that ships with the plugin, falling back to PATH. When
// neither path produces a compatible akm we log a warn-level event to the host
// AND emit a consent banner through the host's structured logging channel so
// the human running OpenCode actually sees the problem. The banner mirrors
// the Claude plugin's wording: install must be user-driven, never automatic.
// The recommended consent point is `akm setup` (or the host-specific akm
// setup slash command if one exists).
async function ensureSupportedAkmResolved(client: LogCapableClient): Promise<void> {
  const installedAkm = getResolvedAkmDetails()
  if (!installedAkm) {
    await writePluginLog(client, "warn", "AKM CLI resolution failed", {
      subsystem: "akm",
      requiredRange: AKM_REQUIRED_VERSION_RANGE,
      bundledCommand: getBundledAkmCommand(),
      pathCommand: "akm",
      reason: "no_supported_command",
      trail: lastAkmResolutionTrail,
    })
    await writeAkmConsentBanner(client, {
      detected: getCommandVersion("akm") ?? undefined,
      bundled: getBundledAkmCommand(),
      trail: lastAkmResolutionTrail,
    })
    return
  }

  resolvedAkmCommand = installedAkm.command
  await writePluginLog(client, "info", "AKM CLI resolved", {
    subsystem: "akm",
    command: installedAkm.command,
    source: installedAkm.source,
    version: installedAkm.version,
    requiredRange: AKM_REQUIRED_VERSION_RANGE,
  })
}

async function writeAkmConsentBanner(client: LogCapableClient, info: { detected?: string; bundled?: string | null; trail?: AkmResolutionTrail }) {
  const detectedLabel = info.detected ?? "(not found on PATH)"
  const bundledLabel = info.bundled ?? "(none)"
  const trailLines: string[] = []
  if (info.trail && info.trail.length > 0) {
    trailLines.push("", "  resolution trail (in order tried):")
    for (const entry of info.trail) {
      const versionLabel = entry.version ?? "no version"
      const reason = entry.failureReason ? ` reason=${entry.failureReason}` : ""
      trailLines.push(`    [${entry.source}] ${entry.command} → ${entry.outcome} (${versionLabel})${reason}`)
    }
  }
  const banner = [
    "─".repeat(60),
    "akm-opencode plugin: akm CLI not installed or wrong version",
    `  detected on PATH: ${detectedLabel}`,
    `  bundled fallback: ${bundledLabel}`,
    `  required:         ${AKM_REQUIRED_VERSION_RANGE}`,
    ...trailLines,
    "",
    "Reinstall or update the akm-opencode plugin so OpenCode/Bun",
    "installs the dependency, or install akm-cli manually:",
    `  bun install -g ${AKM_RECOMMENDED_INSTALL_REF}`,
    `  npm install -g ${AKM_RECOMMENDED_INSTALL_REF}`,
    "Then run `akm setup` interactively to configure the stash.",
    "─".repeat(60),
  ].join("\n")
  // AGENTS.md forbids plugin runtime code from writing to
  // console.*/stdout/stderr; route the banner through the host's structured
  // logging channel (client.app.log) instead of process.stderr.write so it
  // still reaches the user without violating that rule.
  await writePluginLog(client, "warn", "akm CLI not installed or wrong version", {
    subsystem: "akm",
    detected: detectedLabel,
    bundled: bundledLabel,
    required: AKM_REQUIRED_VERSION_RANGE,
    installRef: AKM_RECOMMENDED_INSTALL_REF,
    banner,
  })
}

function resolveAkmCommand(): ResolvedAkmCommand | CliError {
  const localBuild = getLocalBuildAkmCommand()
  if (localBuild) {
    const probe = probeCommand(localBuild)
    if (probe.exists && satisfiesAkmVersionRange(probe.version)) return localBuild
  }

  const currentVersion = getCommandVersion(resolvedAkmCommand)
  if (satisfiesAkmVersionRange(currentVersion)) {
    return { command: resolvedAkmCommand, argsPrefix: [], displayCommand: resolvedAkmCommand }
  }

  const installedAkm = getResolvedAkmDetails()
  if (installedAkm) {
    resolvedAkmCommand = installedAkm.command
    return { command: installedAkm.command, argsPrefix: installedAkm.argsPrefix, displayCommand: installedAkm.displayCommand }
  }

  return {
    ok: false,
    error: `AKM CLI ${AKM_REQUIRED_VERSION_RANGE} is required, but no compatible bundled or PATH 'akm' executable was found. Reinstall or update the akm-opencode plugin so OpenCode/Bun installs the dependency.`,
  }
}

async function runCli(client: LogCapableClient, args: string[], meta: CliLogMeta): Promise<string> {
  const command = resolveAkmCommand()
  if (typeof command === "object" && "ok" in command) {
    await writePluginLog(client, "error", "AKM command resolution failed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      command: resolvedAkmCommand,
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
    noteRecentRefs(meta.sessionID, refs)
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
  try {
    const result = operation === "search"
      ? await akmSearch(input as Parameters<typeof akmSearch>[0])
      : operation === "show"
        ? await akmShowUnified(input as Parameters<typeof akmShowUnified>[0])
        : await akmCurate(input as Parameters<typeof akmCurate>[0])
    const output = JSON.stringify(result)
    const refs = extractAkmRefsFromString(output)
    noteRecentRefs(meta.sessionID, refs)
    await writePluginLog(client, "info", "AKM in-process call completed", {
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
    await writePluginLog(client, "error", "AKM in-process call failed", {
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
    return JSON.stringify({ ok: false, error: message })
  }
}

type CliError = { ok: false; error: string }

// The AKM 0.9 asset-type vocabulary, in the singular form `--type` accepts.
// This is exactly `akm info --format json` -> .assetTypes, sorted; keep the two
// in step when akm adds a type. Note there is no `wiki` type in 0.9 — the entry
// that used to be here made `type: "wiki"` a selectable enum value that akm
// answers with an empty hit list rather than an error, i.e. a silent dead end,
// while `instruction`, `session`, and `fact` could not be filtered for at all.
// `any` is a tool-surface sentinel, not an akm type: it means "no filter" and is
// stripped before the value reaches akm, so it sorts last.
const ASSET_TYPES = [
  "agent",
  "command",
  "env",
  "fact",
  "instruction",
  "knowledge",
  "lesson",
  "memory",
  "script",
  "secret",
  "session",
  "skill",
  "task",
  "workflow",
  "any",
] as const

// Derived from ASSET_TYPES so the enum published on the akm_search/akm_curate
// tool surface and the type carried by search hits cannot drift apart again.
type AssetType = Exclude<(typeof ASSET_TYPES)[number], "any">

type ShowToolResponse = {
  type: "tool" | "script"
  name: string
  path?: string
  description?: string
  run?: string
  setup?: string
  cwd?: string
  editable?: boolean
  origin?: string | null
  action?: string
  editHint?: string
}

type SearchHit = {
  type: AssetType | "registry" | "registry-asset"
  ref?: string
  id?: string
  installRef?: string
  editable?: boolean
  name?: string
  description?: string
  score?: number
  whyMatched?: string[]
  run?: string
  origin?: string | null
  size?: string
  action?: string
  editHint?: string
  curated?: boolean
  quality?: string
}

type SearchResponse = {
  hits?: SearchHit[]
  source?: "local" | "stash" | "registry" | "both"
  stashDir?: string
  timing?: { totalMs?: number; rankMs?: number; embedMs?: number }
  warnings?: string[]
  tip?: string
}

function isShowToolResponse(value: unknown): value is ShowToolResponse {
  return !!value
    && typeof value === "object"
    && ((value as { type?: unknown }).type === "tool" || (value as { type?: unknown }).type === "script")
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
    if (part?.type === "text" && typeof part.text === "string") {
      const text = part.text.trim()
      if (text) segments.push(text)
    }
  }
  return segments.join("\n\n")
}

function parseToolOutput(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
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

function classifyToolFeedback(value: unknown): "positive" | "negative" | undefined {
  if (!value || typeof value !== "object") return undefined
  if (isCliError(value)) return "negative"
  if ("ok" in value && (value as { ok?: unknown }).ok === false) return "negative"
  if ("error" in value && typeof (value as { error?: unknown }).error === "string") return "negative"
  if ("ok" in value && (value as { ok?: unknown }).ok === true) return "positive"
  if ("type" in value || "hits" in value || "assetHits" in value || "sources" in value) return "positive"
  return undefined
}

function withProposedWarnings(raw: string): string {
  const parsed = safeJsonParse<SearchResponse>(raw)
  if (!parsed) return raw
  const hasProposed = parsed.hits?.some((hit) => hit.quality === "proposed") ?? false
  if (!hasProposed) return raw
  const warnings = parsed.warnings ?? []
  return JSON.stringify({
    ...parsed,
    warnings: warnings.includes(PROPOSED_QUALITY_WARNING) ? warnings : [...warnings, PROPOSED_QUALITY_WARNING],
  })
}

function truncateLogText(value: string, limit = 1_000): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

export const AkmPlugin: Plugin = async ({ client, worktree, directory }) => {
  await ensureSupportedAkmResolved(client as unknown as LogCapableClient)

  const logClient = client as unknown as LogCapableClient
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
          if (!sessionContextEpoch.has(sid)) sessionContextEpoch.set(sid, 0)
          if (type === "session.created") {
            // Best-effort, fire-and-forget, fully error-trapped internally —
            // must never block or fail session.created (13: "tmp-file cleanup").
            void pruneStaleCuratedFiles()
            warmIndexInBackground()
            if (AKM_AUTO_CURATE && !sessionCurated.has(sid)) {
              const cwdContext = gatherCwdContext(directory)
              const curated = await runCurateForSession(logClient, sid, cwdContext || undefined)
              if (curated) {
                bumpCuratedVersion(sid)
                sessionCurated.set(sid, curated)
                writeCuratedFile(sid, curated)
              }
            }
          }
          if (AKM_AUTO_HINTS && !sessionHints.has(sid)) {
            const hints = await runHintsForSession(logClient, sid)
            if (hints) sessionHints.set(sid, hints)
          }
          if (!sessionWorkflow.has(sid)) {
            sessionWorkflow.set(sid, await runWorkflowSummaryForSession(logClient, sid) ?? "")
          }
          const proposalSummary = await getPendingProposalCount(logClient, sid)
          if (!proposalSummary.unsupported && proposalSummary.count > 0) {
            markContextEpochDirty(sid)
          }
        } else if (type === "session.compacted" || type === "session.idle" || type === "session.deleted") {
          if (!sid) return
          // 03-R1/06-M1: the session_checkpoint `remember --force` write is
          // removed. Keep the freshness reindex on session-end events so
          // upstream inference/graph passes still run.
          await maybeIndexSessionMemory(logClient, sid, type, "")
          // `stop` is not a real OpenCode hook (not in the Hooks contract), so
          // the memory-candidate harvest has to ride real lifecycle events
          // instead: idle (per-turn quiescence), compacted, and deleted. This
          // is safe to fire on all three — a harvest always clears the buffer,
          // so a later event finds it empty and no-ops rather than
          // double-harvesting. A below-noise-floor buffer is kept across
          // non-terminal events (so intents accumulate across turns) and only
          // discarded on the terminal session.deleted.
          maybeExtractSessionCandidates(sid, type)
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
            clearSessionState(sid)
          }
        }
      } catch (error: unknown) {
        await logHookFailure(logClient, "event", error)
      }
    },
    // experimental.chat.system.transform is how OpenCode exposes the
    // additionalContext channel. We append the cached hints (once per session)
    // and the curated file reference (once per turn) so the next LLM call
    // sees instructions to read the curated file instead of raw content.
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; session_id?: string } | undefined,
      output: { system?: string[] } | undefined,
    ) => {
      try {
        if (!output || !Array.isArray(output.system)) return
        const sid = extractSessionIdFromEvent(input) ?? ""
        const epoch = sessionContextEpoch.get(sid) ?? 0
        const injectedEpoch = sessionContextInjectedEpoch.get(sid)
        if (sid && injectedEpoch !== epoch) {
          const curatedFile = sessionCuratedFile.get(sid)
          const curatedBlock = curatedFile
            ? `AKM stash curation available at \`${curatedFile}\`. Read that file to discover assets relevant to this session. ${AKM_CURATED_TAIL}`
            : ""
          const blocks = [
            sessionHints.get(sid) ? `${AKM_HINTS_PREFIX}\n\n${sessionHints.get(sid)}` : "",
            curatedBlock,
            sessionWorkflow.get(sid) ? formatWorkflowContext(sessionWorkflow.get(sid)!) : "",
            (await getPendingProposalCount(logClient, sid)).count > 0 && !(await getPendingProposalCount(logClient, sid)).unsupported ? formatPendingProposalContext((await getPendingProposalCount(logClient, sid)).count) : "",
            sessionCuratorReport.get(sid) ? formatCuratorReportContext(sessionCuratorReport.get(sid)!) : "",
          ]
          output.system.push(...applyContextBudget(blocks))
          sessionContextInjectedEpoch.set(sid, epoch)
          if (sessionCurated.has(sid)) {
            sessionCuratedInjectedVersion.set(sid, sessionCuratedVersion.get(sid) ?? 0)
          }
        }
        const curated = sid ? sessionCurated.get(sid) : undefined
        const curatedVersion = sessionCuratedVersion.get(sid) ?? 0
        if (curated) {
          if (sessionCuratedInjectedVersion.get(sid) !== curatedVersion) {
            const curatedFile = writeCuratedFile(sid, curated)
            output.system.push(...applyContextBudget([`AKM stash curation written to \`${curatedFile}\`. Read that file to discover assets relevant to the current task. ${AKM_CURATED_TAIL}`]))
            sessionCuratedInjectedVersion.set(sid, curatedVersion)
          }
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

        if (AKM_AUTO_CURATE && input.sessionID) {
          const decision = shouldRecall(text, { activeWorkflow: !!sessionWorkflow.get(input.sessionID), recentAssetFailure: retrospectiveState.get(input.sessionID)?.lastNegativeSignalAt != null })
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
            // Record the audit row immediately; the `injectedRefs` field is populated lazily
            // when the background curate resolves.
            sessionRecallAudit.set(sessionID, {
              shouldRecall: true,
              reason: decision.reason,
              query: decision.query,
              injectedRefs: [],
              injectedChars: 0,
              warnings: ["curate dispatched asynchronously; result injected on next message"],
            })
            void (async () => {
              try {
                const curated = await runCurateForPrompt(logClient, decision.query, sessionID)
                // Shared 0.9 concept-ID extractor. The inline regex this
                // replaced still matched the pre-0.9 `type:slug` ref form
                // (`skill:code-review`, plus a `wiki:` type that no longer
                // exists), so against real 0.9 curate output it matched nothing
                // and both the recall audit and the prompt_recall event
                // recorded an empty ref list on every turn.
                const refs = extractAkmRefsFromString(curated ?? "")
                const prior = sessionRecallAudit.get(sessionID)
                if (prior) {
                  sessionRecallAudit.set(sessionID, {
                    ...prior,
                    injectedRefs: refs,
                    injectedChars: curated?.length ?? 0,
                    warnings: prior.warnings.filter((warning) => !warning.startsWith("curate dispatched asynchronously")),
                  })
                }
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
            const hint = "Need more AKM context? Use `akm_search` or `akm_curate` before writing from scratch."
            sessionRecallAudit.set(input.sessionID, {
              shouldRecall: false,
              reason: decision.reason,
              query: decision.query,
              injectedRefs: [],
              injectedChars: 0,
              warnings: [],
            })
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
          addBufferEntry(input.sessionID, {
            kind: "memory-intent",
            note: truncateLogText(text, 500),
          })
        }

        // Retrospective positive feedback: the loose "thanks|perfect|worked"
        // matcher previously fired on `thanks, but it didn't work` because it
        // only checked for a positive token without considering negation in
        // the same message. Gate the path with the same negative/correction
        // matchers used by `recordRetrospectiveFeedback` so a mixed-signal
        // message is treated as ambiguous (skip rather than misattribute).
        // Refs still flow through the shared confidence gate so Claude and
        // OpenCode produce parallel auto-feedback verdicts for the same
        // signal (README "Confidence-scored auto-feedback" parity claim).
        if (
          input.sessionID
          && AKM_AUTO_FEEDBACK
          && AKM_RETROSPECTIVE_FEEDBACK_RE.test(text)
          && !AKM_RETROSPECTIVE_NEGATIVE_RE.test(text)
          && !AKM_EXPLICIT_CORRECTION_RE.test(text)
        ) {
          const recentRefs = (sessionBuffer.get(input.sessionID) ?? [])
            .filter((entry) => entry.kind === "tool-ref" && !!entry.ref)
            .map((entry) => entry.ref!)
            .filter((ref, index, refs) => !/^(?:.*\/\/)?(?:memories|env|secrets)\//.test(ref) && refs.indexOf(ref) === index)
            .slice(-3)
          const dedupe = new Set<string>()
          for (const ref of recentRefs) {
            const signal = classifyFeedbackSignal({
              ref,
              polarity: "positive",
              harness: "opencode",
              sessionId: input.sessionID,
              retrospective: true,
              note: "opencode retrospective: user confirmed it worked",
            })
            if (!shouldSubmitAutomaticFeedback(signal)) continue
            queueFeedback(logClient, ref, "positive", signal.note, {
              toolName: "chat.message",
              sessionID: input.sessionID,
              agent: input.agent,
            }, dedupe)
          }
        }
        await recordRetrospectiveFeedback(logClient, input.sessionID, text)
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
    "tool.execute.after": async (input, output) => {
      try {
        const isAkmTool = input.tool.startsWith("akm_")
        // The SDK type for `tool.execute.after` input does not expose `directory`,
        // but the OpenCode runtime does provide it for tool-scoped hooks. Read
        // it via a structural cast so we get the value when present without
        // accepting `any` everywhere it's used.
        const inputDirectory = (input as { directory?: unknown }).directory
        const directory = typeof inputDirectory === "string" ? inputDirectory : undefined

        const allArgRefs = extractAkmRefsFromAllArgs(input.args as Record<string, unknown>)
        const allOutputRefs = extractAkmRefsFromString(output.output)
        const candidateRefs = [...new Set([...allArgRefs, ...allOutputRefs])]
        const parsedForRefs = isAkmTool ? parseToolOutput(output.output) : null
        const allRefs = isAkmTool && parsedForRefs
          ? extractToolRefs(input.tool, input.args as Record<string, unknown>, parsedForRefs).refs
          : validateRefCandidates(candidateRefs, [await getAkmBundleDir(logClient) ?? ""])

        if (allRefs.length > 0) {
          writeStructuredEvent({
            event: "tool_ref_observed",
            sessionId: input.sessionID,
            scope: buildEventScope(input.sessionID, directory, input.tool),
            input: { tool: input.tool, callID: input.callID },
            refs: allRefs,
            outcome: { status: "ok" },
          })
          for (const ref of allRefs) {
            addBufferEntry(input.sessionID, {
              kind: "tool-ref",
              toolName: input.tool,
              ref,
              status: "unknown",
            })
          }
        }

        if (!isAkmTool) return

        const parsed = parseToolOutput(output.output)
        if (!parsed) return

        const feedback = classifyToolFeedback(parsed)
        if (feedback) {
          await writePluginLog(logClient, feedback === "negative" ? "warn" : "info", "AKM system feedback recorded", {
            subsystem: "feedback",
            actor: "system",
            feedback,
            toolName: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
            title: output.title,
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

        const refResult = extractToolRefs(input.tool, input.args as Record<string, unknown>, parsed)
        noteRecentRefs(input.sessionID, refResult.refs)
        writeStructuredEvent({
          event: "tool_observation",
          sessionId: input.sessionID,
          scope: buildEventScope(input.sessionID, directory, input.tool),
          input: { tool: input.tool, callID: input.callID, args: input.args as Record<string, unknown>, output: parsed as Record<string, unknown> },
          refs: refResult.refs,
          outcome: { status: feedback === "negative" ? "failed" : "ok" },
        })
        if (refResult.refs.length > 0 && input.sessionID) {
          for (const ref of refResult.refs) {
            addBufferEntry(input.sessionID, {
              kind: "tool-ref",
              toolName: input.tool,
              ref,
              status: feedback ?? "unknown",
            })
          }
        }

        if (
          AKM_AUTO_FEEDBACK
          && feedback
          && input.tool !== "akm_feedback"
          && refResult.refs.length > 0
        ) {
          const dedupe = new Set<string>()
          const feedbackRefs = feedback === "positive"
            ? refResult.refs
            : refResult.refs.filter((ref) => !refResult.positiveOnlyRefs.includes(ref))
          const note = feedback === "positive"
            ? `opencode auto: ${input.tool} succeeded`
            : `opencode auto: ${input.tool} failed`
          for (const ref of feedbackRefs) {
            // Skip refs that should never receive auto-feedback. Matches the
            // claude-side hook: memories/env/secrets/lessons are excluded, including
            // bundle-qualified forms like `local//lessons/foo`. Lessons take
            // feedback through the proposal queue, not via direct akm feedback.
            if (/^(?:.*\/\/)?(?:memories|env|secrets|lessons)\//.test(ref)) continue
            const directInput = Object.values(input.args as Record<string, unknown>).some((value) => typeof value === "string" && value.includes(ref))
            const signal = classifyFeedbackSignal({
              ref,
              polarity: feedback,
              harness: "opencode",
              sessionId: input.sessionID,
              directInput,
              note: `${note}; confidence=${directInput ? "0.65" : "0.25"}; source=${feedback === "positive" ? "tool_success" : "tool_failure"}`,
            })
            if (!shouldSubmitAutomaticFeedback(signal)) {
              writeStructuredEvent({
                event: "feedback_recorded",
                sessionId: input.sessionID,
                scope: buildEventScope(input.sessionID, directory, input.tool),
                refs: [ref],
                input: { source: signal.source, confidence: signal.confidence, note: signal.note },
                outcome: { status: "skipped", warnings: ["confidence below automatic submission threshold"] },
              })
              continue
            }
            const ok = queueFeedback(logClient, ref, feedback, signal.note, {
              toolName: input.tool,
              sessionID: input.sessionID,
              directory,
              agent: input.tool,
            }, dedupe)
            if (ok) {
              writeStructuredEvent({
                event: "feedback_recorded",
                sessionId: input.sessionID,
                scope: buildEventScope(input.sessionID, directory, input.tool),
                refs: [ref],
                input: { source: signal.source, confidence: signal.confidence, note: signal.note },
                outcome: { status: "ok" },
              })
            }
            if (!ok) break
          }
        }
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
        description: "Search configured AKM bundles or registries in process. Use source='registry' for installable community assets.",
        args: {
          query: tool.schema.string().optional().describe("Search query. Omit to browse all assets."),
          type: tool.schema
            .enum(ASSET_TYPES as unknown as [string, ...string[]])
            .optional()
            .describe("Optional type filter. Defaults to 'any'."),
          limit: tool.schema.number().optional().describe("Maximum number of hits to return. Defaults to 20."),
          source: tool.schema.string().optional().describe("Search source: 'local', 'registry', 'all', or a configured bundle name."),
          include_proposed: tool.schema.boolean().optional().describe("Include proposed-quality results. Proposed assets are not curated until accepted."),
        },
        async execute({ query, type, limit, source, include_proposed }, context) {
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
        description: "Show an AKM asset by [bundle//]conceptId[#fragment]. Markdown heading fragments select a section.",
        args: {
          ref: tool.schema.string().describe("Asset reference returned by akm_search, optionally with a #fragment."),
          detail: tool.schema.enum(["brief", "summary", "normal", "full"]).optional().describe("Response detail level. Defaults to 'normal'."),
        },
        async execute({ ref, detail }, context) {
          return runInProcess(
            client as unknown as LogCapableClient,
            "show",
            { ref, detail },
            { toolName: "akm_show", sessionID: context.sessionID, directory: context.directory },
          )
        },
      }),
      akm_remember: tool({
        description: "Record a memory in the default AKM stash so it can be searched and shown later.",
        args: {
          content: tool.schema.string().describe("Memory content to store."),
          name: tool.schema.string().optional().describe("Optional memory name."),
          force: tool.schema.boolean().optional().describe("Overwrite an existing memory with the same name."),
        },
        async execute({ content, name, force }, context) {
          const args = ["remember", content]
          if (name) args.push("--name", name)
          if (force) args.push("--force")
          args.push(...buildScopedArgs(context as unknown as Record<string, unknown>))
          return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_remember", sessionID: context.sessionID, directory: context.directory })
        },
      }),
      akm_feedback: tool({
        description: "Record positive or negative feedback for a stash asset so AKM can improve future ranking.",
        args: {
          ref: tool.schema.string().describe("Asset ref to record feedback for."),
          sentiment: tool.schema.enum(["positive", "negative"]).describe("Whether the feedback is positive or negative."),
          note: tool.schema.string().optional().describe("Optional note to attach to the feedback."),
        },
        async execute({ ref, sentiment, note }, context) {
          const args = ["feedback", ref, sentiment === "positive" ? "--positive" : "--negative"]
          if (note) args.push("--reason", note)
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
        description: "Curate stash assets for a task or topic. Returns the top matches as a ranked list so the agent can inspect and use them.",
        args: {
          query: tool.schema.string().describe("Task, topic, or natural-language description of what you want to do."),
          type: tool.schema.enum(ASSET_TYPES as unknown as [string, ...string[]]).optional().describe("Optional asset type filter."),
          limit: tool.schema.number().optional().describe("Maximum number of curated matches to return. Defaults to 4."),
          source: tool.schema.string().optional().describe("Search source: 'local', 'registry', 'all', or a configured bundle name."),
        },
        async execute({ query, type, limit, source }, context) {
          return runInProcess(
            client as unknown as LogCapableClient,
            "curate",
            { query, type: type === "any" ? undefined : type, limit, source },
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
