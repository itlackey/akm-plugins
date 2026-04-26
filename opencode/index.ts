import { type Plugin, tool } from "@opencode-ai/plugin"
import { execFileSync, execSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

let resolvedAkmCommand = "akm"
const autoInstallPackageRef = "akm-cli@latest"
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const SEMVER_PATTERN = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/

const AKM_AUTO_FEEDBACK = (process.env.AKM_AUTO_FEEDBACK ?? "1") !== "0"
const AKM_AUTO_MEMORY = (process.env.AKM_AUTO_MEMORY ?? "1") !== "0"
const AKM_AUTO_CURATE = (process.env.AKM_AUTO_CURATE ?? "1") !== "0"
const AKM_AUTO_HINTS = (process.env.AKM_AUTO_HINTS ?? "1") !== "0"
const AKM_CURATE_LIMIT = Math.max(1, Number(process.env.AKM_CURATE_LIMIT ?? "5") || 5)
const AKM_CURATE_MIN_CHARS = Math.max(1, Number(process.env.AKM_CURATE_MIN_CHARS ?? "16") || 16)
const AKM_CURATE_TIMEOUT_MS = Math.max(1_000, (Number(process.env.AKM_CURATE_TIMEOUT ?? "8") || 8) * 1_000)
const AKM_MEMORY_CHECKPOINT_EVERY = Math.max(1, Number(process.env.AKM_MEMORY_CHECKPOINT_EVERY ?? "8") || 8)
const AKM_CURATOR_CONTEXT_MAX_CHARS = Math.max(500, Number(process.env.AKM_CURATOR_CONTEXT_MAX_CHARS ?? "4000") || 4000)
const SESSION_DATE_TAG_LENGTH = 8
const CHECKPOINT_DATE_TAG_LENGTH = 15
const AKM_RETROSPECTIVE_FEEDBACK_RE = createRetrospectiveFeedbackRegex()
const PLUGIN_VERSION = readPackageVersion()

// Per-session state that drives the compound-engineering loop.
// These maps are keyed by OpenCode sessionID.
const sessionHints = new Map<string, string>()
const sessionCurated = new Map<string, string>()
const sessionWorkflow = new Map<string, string>()
const sessionCuratorReport = new Map<string, string>()
const sessionContextEpoch = new Map<string, number>()
const sessionContextInjectedEpoch = new Map<string, number>()
const sessionCuratedVersion = new Map<string, number>()
const sessionCuratedInjectedVersion = new Map<string, number>()
type ParsedSemver = { core: [number, number, number]; prerelease: Array<string | number> | null }
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
const sessionFinalMemoryCaptured = new Set<string>()
const sessionSuccessfulAssetTouchCount = new Map<string, number>()
let cachedAkmStashDir: string | undefined

// Asset-ref grammar matching the stash skill: [origin//]type:name.
// We validate normalized tokens individually instead of running a global regex
// over arbitrary tool output to keep extraction predictable and ReDoS-safe.
const AKM_REF_PATTERN = /^(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|script|workflow|vault|wiki):[A-Za-z0-9._/\-]+$/

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

const CURATOR_AGENT_PROMPT_FALLBACK = `You are the AKM curator — a compound-engineering agent that keeps the user's AKM stash improving every time the main agent finishes a task.

Inputs you should inspect:
1. OpenCode app logs that include the "akm-opencode" service (feedback, memory, tool invocations).
2. Session-summary memories named memory:opencode-session-*.
3. The live stash: call akm_search "" --limit 50 (and akm_show <ref>) to enumerate assets; reach for akm_help topic="list sources" if you need the configured-sources view.
4. Parent-session context via akm_parent_messages when this session was dispatched as a child.

Signals to act on:
- Hot refs: assets repeatedly appearing in positive tool outcomes. Call akm_feedback <ref> positive --note "curator: consistently useful" to reinforce.
- Cold refs: assets tied to failures or user complaints. Record akm_feedback <ref> negative --note "<excerpt>" and open the asset for review.
- Missing coverage: recurring user prompts with no matching asset. Draft a new skill, command, knowledge doc, wiki page, or workflow in the working stash and reindex via the akm CLI (see akm_help topic="reindex").
- Duplicates / drift: near-identical descriptions or overlapping responsibilities. Propose a consolidation.
- Stale memories: session summaries that never get recalled. Propose removal (see akm_help topic="remove") once distilled into a durable knowledge doc or wiki page.
- Wiki hygiene: for each wiki returned by akm_wiki list, run akm_wiki lint <name> and report orphans, broken xrefs, uncited raws, and stale indexes as fix candidates.
- Stuck workflows: run akm_workflow list --active and surface any runs in blocked or failed state with their step ids. Propose whether to resume or escalate.
- Never touch vaults: do not call akm_vault show or load unless the user explicitly asks. Vault values must never appear in reports.

Rules of engagement:
- Never apply destructive changes without explicit user approval.
- Report findings as a prioritized action list of concrete akm_* tool calls the user can run.
- Prefer small, reversible edits: promote via positive feedback, draft a candidate skill, or clone and tweak.
- When drafting new assets, write them into the working stash directory under skills/, commands/, agents/, knowledge/, or scripts/. Use akm_help (topic="config" / topic="reindex") to look up the right CLI invocation when you need the stash path or want to force a reindex.
- When finished, persist your own summary with akm_remember (name: curator-run-<timestamp>) so the next curator run can build on yours.

Output shape: end every run with a markdown report that has these sections:

## Hot assets (promote)
- <ref> — why it helped — command to run

## Cold assets (investigate)
- <ref> — failure signal — proposed fix

## Coverage gaps
- <theme> — proposed asset (type, name, one-line description)

## Duplicates / drift
- <ref a> vs <ref b> — consolidation proposal

## Wiki health
- <wiki> — lint findings (orphan, broken-xref, uncited-raw, stale-index) with suggested fix

## Workflow health
- <workflow|runId> — blocked/failed state — resume or escalate

## Housekeeping
- stale memories, reindex needs, config tweaks
`

function loadCuratorAgentPrompt(): string {
  try {
    const raw = readFileSync(path.join(moduleDir, "agent", "akm-curator.md"), "utf8").trim()
    let body = raw
    const lines = raw.split(/\r?\n/)
    if (lines[0] === "---") {
      const closingIndex = lines.indexOf("---", 1)
      if (closingIndex > 0) body = lines.slice(closingIndex + 1).join("\n").trim()
    }
    return body || CURATOR_AGENT_PROMPT_FALLBACK
  } catch {
    return CURATOR_AGENT_PROMPT_FALLBACK
  }
}

const CURATOR_AGENT_PROMPT = loadCuratorAgentPrompt()

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
}

type SessionPromptBody = {
  agent: string
  parts: Array<{ type: "text"; text: string }>
  system?: string
  model?: { providerID: string; modelID: string }
  tools?: Record<string, boolean>
}

function formatCliError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return "The 'akm' CLI was not found on PATH. Install it first from https://github.com/itlackey/akm."
  }
  return error instanceof Error ? error.message : String(error)
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
    await client.app.log({
      query: typeof extra.directory === "string" ? { directory: extra.directory } : undefined,
      body: {
        service: "akm-opencode",
        level,
        message,
        extra,
      },
    })
  } catch {
    // Avoid breaking the TUI if logging itself fails.
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildDateTag(options?: { includeTime?: boolean }): string {
  const compactIso = new Date().toISOString().replace(/[-:]/g, "")
  return compactIso.slice(0, options?.includeTime ? CHECKPOINT_DATE_TAG_LENGTH : SESSION_DATE_TAG_LENGTH)
}

function addBufferEntry(sessionID: string | undefined, entry: Omit<SessionBufferEntry, "timestamp">) {
  if (!sessionID) return
  const buf = sessionBuffer.get(sessionID) ?? []
  buf.push({ timestamp: nowIso(), ...entry })
  sessionBuffer.set(sessionID, buf)
}

function markContextEpochDirty(sessionID: string) {
  sessionContextEpoch.set(sessionID, (sessionContextEpoch.get(sessionID) ?? 0) + 1)
}

function bumpCuratedVersion(sessionID: string) {
  sessionCuratedVersion.set(sessionID, (sessionCuratedVersion.get(sessionID) ?? 0) + 1)
}

function isAkmRef(value: string): boolean {
  return AKM_REF_PATTERN.test(value)
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
  if (typeof command !== "string") return { ok: false, error: command.error }
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, stdout }
  } catch (error: unknown) {
    return { ok: false, error: formatCliError(error) }
  }
}

function appendRunScopeArgs(args: string[], sessionID: string | undefined): string[] {
  return sessionID ? [...args, "--run", sessionID] : args
}

function runCurate(args: string[]): string | null {
  const result = runCliSyncRaw(args, AKM_CURATE_TIMEOUT_MS)
  if (!result.ok) return null
  const body = result.stdout.trim()
  return body || null
}

function runCurateForPrompt(text: string, sessionID?: string): string | null {
  if (!text || text.length < AKM_CURATE_MIN_CHARS) return null
  return runCurate(
    appendRunScopeArgs(
      [
        "--for-agent",
        "--format",
        "text",
        "--detail",
        "summary",
        "-q",
        "curate",
        text,
        "--limit",
        String(AKM_CURATE_LIMIT),
      ],
      sessionID,
    ),
  )
}

function runCurateForSession(sessionID: string): string | null {
  return runCurate(
    appendRunScopeArgs(
      [
        "--for-agent",
        "--format",
        "text",
        "--detail",
        "summary",
        "-q",
        "curate",
        "--limit",
        String(AKM_CURATE_LIMIT),
      ],
      sessionID,
    ),
  )
}

function runHintsForSession(): string | null {
  const result = runCliSyncRaw(["--format", "text", "-q", "hints"], AKM_CURATE_TIMEOUT_MS)
  if (!result.ok) return null
  const body = result.stdout.trim()
  return body || null
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
        const step = typeof record.step === "string"
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

function runWorkflowSummaryForSession(): string | null {
  const result = runCliSyncRaw(["--format", "json", "-q", "workflow", "list", "--active"], AKM_CURATE_TIMEOUT_MS)
  if (!result.ok) return null
  const parsed = parseMaybeJson(result.stdout)
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

function summarizeCuratorReportForContext(report: string): string {
  if (report.length <= AKM_CURATOR_CONTEXT_MAX_CHARS) return report
  return `${report.slice(0, AKM_CURATOR_CONTEXT_MAX_CHARS).trimEnd()}\n\n[truncated for context]`
}

function getAkmStashDir(): string | undefined {
  if (cachedAkmStashDir !== undefined) return cachedAkmStashDir || undefined
  const result = runCliSyncRaw(["--format", "json", "-q", "config", "get", "stashDir"], AKM_CURATE_TIMEOUT_MS)
  if (!result.ok) {
    cachedAkmStashDir = ""
    return undefined
  }
  const parsed = parseMaybeJson(result.stdout)
  if (typeof parsed === "string" && parsed.trim()) {
    cachedAkmStashDir = parsed.trim()
    return cachedAkmStashDir
  }
  if (parsed && typeof parsed === "object") {
    for (const key of ["value", "path", "stashDir"]) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === "string" && value.trim()) {
        cachedAkmStashDir = value.trim()
        return cachedAkmStashDir
      }
    }
  }
  const raw = result.stdout.trim()
  cachedAkmStashDir = raw || ""
  return cachedAkmStashDir || undefined
}

function warmIndexInBackground(): void {
  const command = resolveAkmCommand()
  if (typeof command !== "string") return
  try {
    // Fire and forget — execSync with a timeout would block, so spawn via the
    // shell and detach. Errors here are never surfaced to the session.
    execSync(`${JSON.stringify(command)} index >/dev/null 2>&1 &`, { timeout: 2_000 })
  } catch {
    // Intentionally ignore — warming is best-effort.
  }
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
  if (typeof command !== "string") {
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
      command,
      [
        "--format",
        "json",
        "-q",
        "feedback",
        ref,
        sentiment === "positive" ? "--positive" : "--negative",
        "--note",
        note,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    )
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

function rememberTextAsMemory(name: string, body: string): string | null {
  const command = resolveAkmCommand()
  if (typeof command !== "string") return null
  try {
    execFileSync(command, ["--format", "json", "-q", "remember", "--name", name, "--force"], {
      encoding: "utf8",
      timeout: AKM_CURATE_TIMEOUT_MS * 2,
      input: body,
    })
    return `memory:${name}`
  } catch {
    return null
  }
}

function captureSessionMemory(
  sessionID: string,
  reason: string,
  options?: { checkpoint?: boolean },
): string | null {
  if (!AKM_AUTO_MEMORY) return null
  if (!sessionID) return null
  const isCheckpoint = options?.checkpoint === true
  if (!isCheckpoint && sessionFinalMemoryCaptured.has(sessionID)) return null
  const entries = sessionBuffer.get(sessionID) ?? []
  const pendingEntries = isCheckpoint ? entries.filter((entry) => !entry.checkpointed) : entries
  // Require at least two observations before persisting — single events are noise.
  if (pendingEntries.length < 2) {
    if (!isCheckpoint) sessionBuffer.delete(sessionID)
    return null
  }

  const lines: string[] = []
  lines.push(`# Session summary (${nowIso()})`)
  lines.push(`Reason: ${reason}`)
  lines.push(`Session: ${sessionID}`)
  lines.push("")
  for (const entry of pendingEntries) {
    if (entry.kind === "memory-intent") {
      lines.push(`## ${entry.timestamp} — user memory intent`)
      if (entry.note) lines.push(entry.note)
      lines.push("")
    } else {
      lines.push(`## ${entry.timestamp} — ${entry.toolName ?? "tool"} ${entry.status ?? "unknown"}`)
      if (entry.ref) lines.push(`- ref: ${entry.ref}`)
      if (entry.note) lines.push(`- note: ${entry.note}`)
      lines.push("")
    }
  }
  const body = lines.join("\n")

  const dateTag = buildDateTag({ includeTime: isCheckpoint })
  const shortSid = sessionID.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 8) || "session"
  const name = isCheckpoint
    ? `opencode-checkpoint-${dateTag}-${shortSid}`
    : `opencode-session-${dateTag}-${shortSid}`

  const ref = rememberTextAsMemory(name, body)
  if (!ref) {
    if (!isCheckpoint) {
      sessionFinalMemoryCaptured.add(sessionID)
      sessionBuffer.delete(sessionID)
    }
    return null
  }

  if (isCheckpoint) {
    for (const entry of entries) {
      if (!entry.checkpointed) entry.checkpointed = true
    }
    sessionSuccessfulAssetTouchCount.set(sessionID, 0)
    sessionBuffer.set(sessionID, entries)
    return ref
  }

  sessionFinalMemoryCaptured.add(sessionID)
  sessionBuffer.delete(sessionID)
  return ref
}

function maybeCheckpointSessionMemory(sessionID: string): string | null {
  const count = sessionSuccessfulAssetTouchCount.get(sessionID) ?? 0
  if (count < AKM_MEMORY_CHECKPOINT_EVERY) return null
  const captured = captureSessionMemory(sessionID, "checkpoint", { checkpoint: true })
  if (!captured) {
    sessionSuccessfulAssetTouchCount.set(sessionID, 0)
  }
  return captured
}

const AKM_REF_EDGE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "(", ")", "[", "]", "{", "}", "'", "\"", "`"])

function normalizeExtractedRef(ref: string): string {
  let start = 0
  let end = ref.length
  while (start < end && AKM_REF_EDGE_PUNCTUATION.has(ref[start] ?? "")) start += 1
  while (end > start && AKM_REF_EDGE_PUNCTUATION.has(ref[end - 1] ?? "")) end -= 1
  return ref.slice(start, end)
}

function extractRefsFromText(value: string): string[] {
  const refs = new Set<string>()
  for (const token of value.split(/\s+/)) {
    const normalized = normalizeExtractedRef(token)
    if (normalized && isAkmRef(normalized)) refs.add(normalized)
  }
  return [...refs]
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
    for (const ref of extractRefsFromText(value)) refs.add(ref)
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
    if (
      (toolName === "akm_agent" || toolName === "akm_cmd" || toolName === "akm_evolve")
      && typeof o.text === "string"
    ) {
      for (const ref of extractRefsFromText(o.text)) {
        refs.add(ref)
        positiveOnlyRefs.add(ref)
      }
    }
  }

  return { refs: [...refs], positiveOnlyRefs: [...positiveOnlyRefs] }
}

const AKM_HINTS_PREFIX = [
  "# AKM is available in this session",
  "",
  "You have an AKM stash on this machine. Before writing anything from scratch, call `akm_search` or `akm_curate` to see if the stash already covers it. Record `akm_feedback <ref> positive|negative` whenever an asset materially helps or misses, and use `akm_remember` to persist durable learnings so future sessions inherit them.",
].join("\n")

const AKM_CURATED_HEADER = "# AKM stash — assets relevant to this prompt"
const AKM_CURATED_TAIL = "\n\nTip: call `akm_show <ref>` to fetch full content, and record `akm_feedback <ref> positive|negative` once you know whether the asset helped."
const AKM_CONTEXT_TRUNCATED_MARKER = "\n\n[truncated for context]"

function getContextBudgetChars(): number {
  return Math.max(1, Number(process.env.AKM_CONTEXT_BUDGET_CHARS) || 4000)
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

// Curated quick-reference for the long-tail of `akm` CLI verbs that no longer
// have a dedicated tool wrapper. Surfaced through akm_help so agents can
// always find the right invocation without polluting default context.
type AkmHelpEntry = {
  task: string
  command: string
  notes?: string
  keywords: string[]
}

const AKM_HELP_QUICK_REFERENCE: readonly AkmHelpEntry[] = [
  {
    task: "Install a kit or register an external source (npm, GitHub, git, URL, local dir)",
    command: "akm add <package-ref> [--name <n>] [--type wiki] [--writable] [--trust] [--provider <p>] [--max-pages N] [--max-depth N]",
    notes: "Confirm with the user before passing --trust or registering a website crawler.",
    keywords: ["add", "install", "register", "kit", "source", "github", "npm"],
  },
  {
    task: "Commit (and optionally push) pending stash changes",
    command: "akm save [<source-name>] [-m <msg>] [--push]",
    notes: "Add --push only when the stash is writable; review the diff first.",
    keywords: ["save", "commit", "push", "publish", "git"],
  },
  {
    task: "Import a file (or stdin) into the stash as a typed asset",
    command: "akm import <path|-> [--name <name>] [--force]",
    notes: "Use `-` and pipe content via stdin to import a string.",
    keywords: ["import", "ingest", "upload", "stdin"],
  },
  {
    task: "Clone an asset from any source for editing",
    command: "akm clone <ref> [--name <new>] [--dest <dir>] [--force]",
    notes: "Type subdirectory is appended automatically; ref may include origin (e.g. npm:@scope/pkg//script:foo).",
    keywords: ["clone", "copy", "fork", "edit"],
  },
  {
    task: "Update a managed source (or all of them)",
    command: "akm update [<package_ref>|--all] [--force]",
    keywords: ["update", "upgrade kit", "refresh", "pull"],
  },
  {
    task: "Remove a configured source and reindex",
    command: "akm remove <id|ref|path|url|name>",
    notes: "Destructive — confirm intent before running.",
    keywords: ["remove", "uninstall", "delete source"],
  },
  {
    task: "List configured sources (local dirs, kits, remotes)",
    command: "akm list",
    keywords: ["list", "sources", "kits", "show sources"],
  },
  {
    task: "Search the registry only (skip local stash)",
    command: "akm registry search <query> [--limit N] [--assets]",
    notes: "akm_search with source='registry' covers most cases; this is the explicit form.",
    keywords: ["registry", "search registry", "installable", "discover kit"],
  },
  {
    task: "Build or rebuild the stash search index",
    command: "akm index",
    notes: "Rarely needed — the index refreshes implicitly after writes.",
    keywords: ["index", "reindex", "rebuild"],
  },
  {
    task: "View or update akm config (get/set/list/unset/path)",
    command: "akm config <action> [<key>] [<value>] [--all]",
    notes: "`akm config path --all` prints config, stash, cache, and index paths.",
    keywords: ["config", "settings", "configure", "path"],
  },
  {
    task: "Check for or install an akm CLI update",
    command: "akm upgrade [--check] [--force]",
    keywords: ["upgrade cli", "update cli", "self-upgrade"],
  },
  {
    task: "Run a stash script end-to-end (resolve → show → run)",
    command: "akm show <script-ref> # then exec the printed `run` command",
    notes: "Or `akm --format json -q show <ref>` and pipe `.run` into your shell.",
    keywords: ["run", "execute", "script", "exec"],
  },
]

function lookupAkmHelpHint(topic: string): AkmHelpEntry[] {
  const needle = topic.toLowerCase().trim()
  if (!needle) return []
  return AKM_HELP_QUICK_REFERENCE.filter((entry) =>
    entry.keywords.some((kw) => needle.includes(kw))
    || entry.task.toLowerCase().includes(needle)
    || entry.command.toLowerCase().includes(needle),
  )
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

function getCommandStatus(command: string): "ok" | "missing" | "error" {
  try {
    execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    })
    return "ok"
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return "missing"
    }
    return "error"
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

function parseSemver(version: string): ParsedSemver | null {
  const normalized = extractFirstSemverMatch(version)
  if (!normalized) return null

  const [withoutBuildMetadata] = normalized.split("+", 1)
  const [release, prereleaseText] = withoutBuildMetadata.split("-", 2)
  const parts = release.split(".").map((part) => Number(part))
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return null
  }
  const core = [parts[0], parts[1], parts[2]] as [number, number, number]

  return {
    core,
    prerelease: prereleaseText
      ? prereleaseText.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : null,
  }
}

function compareSemver(left: string, right: string): number {
  const leftParsed = parseSemver(left)
  const rightParsed = parseSemver(right)
  if (!leftParsed || !rightParsed) return left.localeCompare(right)

  for (let index = 0; index < leftParsed.core.length; index += 1) {
    const delta = leftParsed.core[index] - rightParsed.core[index]
    if (delta !== 0) return delta
  }

  if (!leftParsed.prerelease && !rightParsed.prerelease) return 0
  if (!leftParsed.prerelease) return 1
  if (!rightParsed.prerelease) return -1

  const length = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParsed.prerelease[index]
    const rightPart = rightParsed.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart - rightPart
    if (typeof leftPart === "number") return -1
    if (typeof rightPart === "number") return 1
    return leftPart.localeCompare(rightPart)
  }

  return 0
}

function getBunGlobalAkmCommand(): string | null {
  try {
    const globalBin = execFileSync("bun", ["pm", "bin", "-g"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim()
    if (!globalBin || !path.isAbsolute(globalBin)) return null
    return process.platform === "win32"
      ? path.join(globalBin, "akm.exe")
      : path.join(globalBin, "akm")
  } catch {
    return null
  }
}

function getInstalledAkmDetails(): { command: string; version: string } | null {
  const candidates = [resolvedAkmCommand, getBunGlobalAkmCommand(), "akm"]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    const version = getCommandVersion(candidate)
    if (version) return { command: candidate, version }
  }
  return null
}

async function getLatestNpmPackageVersion(packageName: string): Promise<string | null> {
  if (typeof fetch !== "function") return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const body = await response.json()
    if (!body || typeof body !== "object") return null
    return typeof body.version === "string" ? extractFirstSemverMatch(body.version) : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function ensureLatestAkmInstalled(client: LogCapableClient): Promise<void> {
  try {
    execFileSync("bun", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    })
  } catch (error: unknown) {
    await writePluginLog(client, "warn", "AKM auto-install skipped", {
      subsystem: "akm",
      installer: "bun",
      error: `Bun is not available: ${formatCliError(error)}`,
    })
    return
  }

  const installedAkm = getInstalledAkmDetails()
  const latestStable = await getLatestNpmPackageVersion("akm-cli")

  if (installedAkm) {
    if (!latestStable) {
      resolvedAkmCommand = installedAkm.command
      await writePluginLog(client, "info", "AKM auto-install skipped", {
        subsystem: "akm",
        installer: "bun",
        package: autoInstallPackageRef,
        command: resolvedAkmCommand,
        installedVersion: installedAkm.version,
        latestStable,
        reason: "latest_version_unavailable",
      })
      return
    }

    if (compareSemver(installedAkm.version, latestStable) >= 0) {
      resolvedAkmCommand = installedAkm.command
      await writePluginLog(client, "info", "AKM auto-install skipped", {
        subsystem: "akm",
        installer: "bun",
        package: autoInstallPackageRef,
        command: resolvedAkmCommand,
        installedVersion: installedAkm.version,
        latestStable,
        reason: "installed_version_not_older",
      })
      return
    }
  }

  try {
    execFileSync("bun", ["install", "-g", autoInstallPackageRef], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: "pipe",
    })

    const bunGlobalAkm = getBunGlobalAkmCommand()
    if (bunGlobalAkm && getCommandStatus(bunGlobalAkm) === "ok") {
      resolvedAkmCommand = bunGlobalAkm
    } else if (getCommandStatus("akm") === "ok") {
      resolvedAkmCommand = "akm"
    }

      await writePluginLog(client, "info", "AKM CLI install check completed", {
        subsystem: "akm",
        installer: "bun",
        package: autoInstallPackageRef,
        command: resolvedAkmCommand,
        installedVersion: installedAkm?.version ?? null,
        latestStable,
      })
  } catch (error: unknown) {
    await writePluginLog(client, "warn", "AKM auto-install failed", {
      subsystem: "akm",
      installer: "bun",
      package: autoInstallPackageRef,
      error: formatCliError(error),
    })
  }
}

function resolveAkmCommand(): string | CliError {
  const currentStatus = getCommandStatus(resolvedAkmCommand)
  if (currentStatus === "ok" || currentStatus === "error") return resolvedAkmCommand

  const bunGlobalAkm = getBunGlobalAkmCommand()
  if (bunGlobalAkm && getCommandStatus(bunGlobalAkm) === "ok") {
    resolvedAkmCommand = bunGlobalAkm
    return resolvedAkmCommand
  }

  if (getCommandStatus("akm") === "ok") {
    resolvedAkmCommand = "akm"
    return resolvedAkmCommand
  }

  return {
    ok: false,
    error: `The 'akm' CLI could not be resolved after attempting to install '${autoInstallPackageRef}' with Bun. Install akm from https://github.com/itlackey/akm.`,
  }
}

async function runCli(client: LogCapableClient, args: string[], meta: CliLogMeta): Promise<string> {
  const command = resolveAkmCommand()
  if (typeof command !== "string") {
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

  const fullArgs = args.includes("--format") ? [...args] : [...args, "--format", "json"]

  try {
    const stdout = execFileSync(command, fullArgs, {
      encoding: "utf8",
      timeout: 60_000,
    })
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
    return stdout
  } catch (error: unknown) {
    const message = formatCliError(error)
    await writePluginLog(client, "error", "AKM command failed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      command,
      args: fullArgs,
      exitCode: getExecStatus(error),
      stdout: toLogString((error as { stdout?: unknown }).stdout) ?? "",
      stderr: toLogString((error as { stderr?: unknown }).stderr) ?? message,
    })
    return JSON.stringify({ ok: false, error: message })
  }
}

type CliError = { ok: false; error: string }
type AssetType =
  | "agent"
  | "command"
  | "knowledge"
  | "memory"
  | "script"
  | "skill"
  | "workflow"
  | "vault"
  | "wiki"

const ASSET_TYPES = [
  "agent",
  "command",
  "knowledge",
  "memory",
  "script",
  "skill",
  "workflow",
  "vault",
  "wiki",
  "any",
] as const

type ShowAgentResponse = {
  type: "agent"
  name: string
  path: string
  description?: string
  prompt?: string
  toolPolicy?: unknown
  modelHint?: unknown
  editable?: boolean
  origin?: string | null
  action?: string
  editHint?: string
}

type ShowCommandResponse = {
  type: "command"
  name: string
  path: string
  description?: string
  template?: string
  editable?: boolean
  agent?: string
  origin?: string | null
  action?: string
  parameters?: string[]
  editHint?: string
}

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

function isShowAgentResponse(value: unknown): value is ShowAgentResponse {
  return !!value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "agent"
}

function isShowCommandResponse(value: unknown): value is ShowCommandResponse {
  return !!value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "command"
}

function parseCliJson<T>(raw: string): T | CliError {
  try {
    return JSON.parse(raw) as T
  } catch {
    return {
      ok: false,
      error: "akm CLI returned non-JSON output",
    }
  }
}

function blockedToolResponse(args: Record<string, unknown>): string | null {
  return typeof args.__akmBlocked === "string"
    ? JSON.stringify({ ok: false, error: args.__akmBlocked })
    : null
}

function isCliError(value: unknown): value is CliError {
  return !!value
    && typeof value === "object"
    && "ok" in value
    && (value as { ok?: unknown }).ok === false
    && "error" in value
}

function parseModelHint(modelHint: unknown): { providerID: string; modelID: string } | undefined {
  if (typeof modelHint !== "string") return undefined
  const [providerID, ...modelParts] = modelHint.split("/")
  const modelID = modelParts.join("/")
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function parseToolPolicy(toolPolicy: unknown): Record<string, boolean> | undefined {
  const result: Record<string, boolean> = {}

  const assign = (key: string, value: unknown) => {
    const normalizedKey = key.trim().toLowerCase()
    if (!normalizedKey) return
    if (typeof value === "boolean") {
      result[normalizedKey] = value
      return
    }
    if (typeof value === "string") {
      if (value === "allow") result[normalizedKey] = true
      if (value === "deny") result[normalizedKey] = false
    }
  }

  if (typeof toolPolicy === "string") {
    assign(toolPolicy, true)
    return Object.keys(result).length > 0 ? result : undefined
  }

  if (Array.isArray(toolPolicy)) {
    for (const item of toolPolicy) {
      if (typeof item === "string") assign(item, true)
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  if (!toolPolicy || typeof toolPolicy !== "object") return undefined

  for (const [key, value] of Object.entries(toolPolicy as Record<string, unknown>)) {
    assign(key, value)
  }
  return Object.keys(result).length > 0 ? result : undefined
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
    if (refs.size === 0 && typeof parsed.name === "string" && parsed.name) refs.add(`memory:${parsed.name}`)
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

function truncateLogText(value: string, limit = 1_000): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

async function searchRef(
  client: LogCapableClient,
  query: string,
  type: AssetType | "any",
  meta: CliLogMeta,
): Promise<{ ok: true; ref: string } | CliError> {
  const raw = await runCli(
    client,
    ["search", query, "--type", type, "--limit", "1", "--detail", "normal", "--source", "stash"],
    meta,
  )
  const parsed = parseCliJson<SearchResponse>(raw)
  if (isCliError(parsed)) return parsed
  const ref = parsed.hits?.[0]?.ref
  if (!ref) {
    return {
      ok: false,
      error: `No stash ref matched '${query}'. Use akm_search to disambiguate, then retry with an exact ref.`,
    }
  }
  return { ok: true, ref }
}

async function resolveRefOrQueryInput(
  client: LogCapableClient,
  input: { ref?: string; query?: string },
  type: AssetType | "any",
  meta: CliLogMeta,
): Promise<{ ok: true; ref: string } | CliError> {
  const explicitRef = input.ref?.trim()
  if (explicitRef) return { ok: true, ref: explicitRef }

  const query = input.query?.trim()
  if (!query) {
    return { ok: false, error: "Provide either 'ref' or 'query'." }
  }
  return searchRef(client, query, type, meta)
}

async function ensureTargetSessionID(input: {
  useSubtask: boolean
  context: { sessionID: string; directory: string }
  title: string
  client: PluginClient
  logClient: LogCapableClient
  toolName: string
}): Promise<{ ok: true; sessionID: string } | CliError> {
  if (!input.useSubtask) return { ok: true, sessionID: input.context.sessionID }

  try {
    const created = await input.client.session.create({
      body: { parentID: input.context.sessionID, title: input.title },
    })
    if (created.error || !created.data?.id) {
      const reason = created.error ? JSON.stringify(created.error) : "missing child session id"
      await writePluginLog(input.logClient, "error", "AKM dispatch child session failed", {
        subsystem: "dispatch",
        toolName: input.toolName,
        sessionID: input.context.sessionID,
        directory: input.context.directory,
        title: input.title,
        error: reason,
      })
      return { ok: false, error: `Failed to create child session: ${reason}` }
    }
    await writePluginLog(input.logClient, "info", "AKM dispatch child session created", {
      subsystem: "dispatch",
      toolName: input.toolName,
      sessionID: input.context.sessionID,
      directory: input.context.directory,
      childSessionID: created.data.id,
      title: input.title,
    })
    return { ok: true, sessionID: created.data.id }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    await writePluginLog(input.logClient, "error", "AKM dispatch child session threw", {
      subsystem: "dispatch",
      toolName: input.toolName,
      sessionID: input.context.sessionID,
      directory: input.context.directory,
      title: input.title,
      error: reason,
    })
    return { ok: false, error: `Failed to create child session: ${reason}` }
  }
}

async function promptTargetSession(input: {
  client: PluginClient
  logClient: LogCapableClient
  toolName: string
  context: { sessionID: string; directory: string }
  targetSessionID: string
  promptBody: SessionPromptBody
  failureMessage: string
  ref?: string
}): Promise<{ ok: true; data: { parts?: unknown } } | CliError> {
  try {
    const promptResponse = await input.client.session.prompt({
      path: { id: input.targetSessionID },
      body: input.promptBody,
    })

    if (promptResponse.error || !promptResponse.data) {
      const reason = promptResponse.error ? JSON.stringify(promptResponse.error) : "empty response"
      await writePluginLog(input.logClient, "error", "AKM dispatch prompt failed", {
        subsystem: "dispatch",
        toolName: input.toolName,
        sessionID: input.context.sessionID,
        directory: input.context.directory,
        targetSessionID: input.targetSessionID,
        dispatchAgent: input.promptBody.agent,
        ref: input.ref,
        error: reason,
      })
      return {
        ok: false,
        error: `${input.failureMessage}: ${reason}`,
      }
    }

    await writePluginLog(input.logClient, "info", "AKM dispatch prompt completed", {
      subsystem: "dispatch",
      toolName: input.toolName,
      sessionID: input.context.sessionID,
      directory: input.context.directory,
      targetSessionID: input.targetSessionID,
      dispatchAgent: input.promptBody.agent,
      ref: input.ref,
    })
    return { ok: true, data: promptResponse.data }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    await writePluginLog(input.logClient, "error", "AKM dispatch prompt threw", {
      subsystem: "dispatch",
      toolName: input.toolName,
      sessionID: input.context.sessionID,
      directory: input.context.directory,
      targetSessionID: input.targetSessionID,
      dispatchAgent: input.promptBody.agent,
      ref: input.ref,
      error: reason,
    })
    return {
      ok: false,
      error: `${input.failureMessage}: ${reason}`,
    }
  }
}

async function resolveDispatchAgent(
  client: PluginClient,
  requestedAgent: string,
  directory: string,
): Promise<string> {
  if (requestedAgent !== "akm-curator") return requestedAgent
  try {
    const agents = await client.app.agents({ query: { directory } })
    if (agents.error) return "general"
    const hasCurator = (agents.data ?? []).some((agent) => agent?.name === "akm-curator")
    return hasCurator ? "akm-curator" : "general"
  } catch {
    return "general"
  }
}

function summarizeSessionMessages(
  sessionID: string,
  messages: Array<{ info?: Record<string, unknown>; parts?: unknown }>,
) {
  return {
    ok: true,
    sessionID,
    messages: messages.map((message) => {
      const info = message.info ?? {}
      const role = typeof info.role === "string" ? info.role : "unknown"
      const agent = typeof info.agent === "string"
        ? info.agent
        : typeof info.mode === "string"
          ? info.mode
          : null
      return {
        role,
        agent,
        text: extractText(message.parts),
      }
    }),
  }
}

async function getParentSessionID(
  client: PluginClient,
  sessionID: string,
  directory: string,
): Promise<{ ok: true; parentID: string } | CliError> {
  try {
    const result = await client.session.get({
      path: { id: sessionID },
      query: { directory },
    })
    if (result.error || !result.data?.parentID) {
      return { ok: false, error: "This session does not have a parent session." }
    }
    return { ok: true, parentID: result.data.parentID }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function splitArguments(raw: string): string[] {
  if (!raw.trim()) return []
  const args: string[] = []
  const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "")
  }
  return args
}

function renderCommandTemplate(template: string, rawArguments: string): string {
  const args = splitArguments(rawArguments)
  return template
    .replace(/\$ARGUMENTS/g, rawArguments)
    .replace(/\$(\d+)/g, (_m, index: string) => args[Number(index) - 1] ?? "")
}

function normalizeSearchSource(source: "local" | "stash" | "registry" | "both"): "stash" | "registry" | "both" {
  return source === "local" ? "stash" : source
}

function createSearchArgs(input: {
  query: string
  type?: AssetType | "any" | string
  limit?: number
  source?: "local" | "stash" | "registry" | "both"
  defaultSource?: "local" | "stash" | "registry" | "both"
}): string[] {
  const args = ["search", input.query]
  if (input.type) args.push("--type", input.type)
  if (input.limit) args.push("--limit", String(input.limit))
  if (input.source) {
    args.push("--source", normalizeSearchSource(input.source))
  } else if (input.defaultSource) {
    args.push("--source", normalizeSearchSource(input.defaultSource))
  }
  args.push("--detail", "normal")
  return args
}

type PluginClient = {
  session: {
    create: (input: {
      body: { parentID: string; title: string }
    }) => Promise<{ data?: { id?: string }; error?: unknown }>
    get: (input: {
      path: { id: string }
      query?: { directory?: string }
    }) => Promise<{ data?: { id?: string; parentID?: string }; error?: unknown }>
    messages: (input: {
      path: { id: string }
      query?: { directory?: string }
    }) => Promise<{ data?: Array<{ info?: Record<string, unknown>; parts?: unknown }>; error?: unknown }>
    prompt: (input: {
      path: { id: string }
      body: SessionPromptBody
    }) => Promise<{ data?: { parts?: unknown }; error?: unknown }>
  }
  app: {
    agents: (input?: {
      query?: { directory?: string }
    }) => Promise<{ data?: Array<{ name?: string }>; error?: unknown }>
  }
}

export const AkmPlugin: Plugin = async ({ client, worktree, directory }) => {
  await ensureLatestAkmInstalled(client as unknown as LogCapableClient)

  const logClient = client as unknown as LogCapableClient
  const sdkClient = client as unknown as PluginClient

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
          if (!sessionContextEpoch.has(sid)) sessionContextEpoch.set(sid, 0)
          if (type === "session.created") {
            warmIndexInBackground()
            if (AKM_AUTO_CURATE && !sessionCurated.has(sid)) {
              const curated = runCurateForSession(sid)
              if (curated) {
                bumpCuratedVersion(sid)
                sessionCurated.set(sid, curated)
              }
            }
          }
          if (AKM_AUTO_HINTS && !sessionHints.has(sid)) {
            const hints = runHintsForSession()
            if (hints) sessionHints.set(sid, hints)
          }
          if (!sessionWorkflow.has(sid)) {
            sessionWorkflow.set(sid, runWorkflowSummaryForSession() ?? "")
          }
        } else if (type === "session.compacted" || type === "session.idle" || type === "session.deleted") {
          if (!sid) return
          const captured = captureSessionMemory(sid, type)
          if (captured) {
            await writePluginLog(logClient, "info", "AKM session memory captured", {
              subsystem: "memory",
              actor: "system",
              sessionID: sid,
              reason: type,
              ref: captured,
            })
          }
          // Drop per-session state so a re-created session does not inherit
          // stale hints/curation.
          if (type === "session.deleted") {
            sessionHints.delete(sid)
            sessionCurated.delete(sid)
            sessionWorkflow.delete(sid)
            sessionCuratorReport.delete(sid)
            sessionContextEpoch.delete(sid)
            sessionContextInjectedEpoch.delete(sid)
            sessionCuratedVersion.delete(sid)
            sessionCuratedInjectedVersion.delete(sid)
            sessionFinalMemoryCaptured.delete(sid)
            sessionSuccessfulAssetTouchCount.delete(sid)
            sessionBuffer.delete(sid)
          }
        }
      } catch {
        // Lifecycle hooks must never throw into the TUI.
      }
    },
    // Stop is the closest analogue to Claude's Stop/SubagentStop — the user or
    // agent halted the active run. Flush the session buffer so learnings are
    // preserved even if the session.idle event does not fire.
    stop: async (input: unknown) => {
      try {
        const sid = extractSessionIdFromEvent(input)
        if (!sid) return
        const captured = captureSessionMemory(sid, "stop")
        if (captured) {
          await writePluginLog(logClient, "info", "AKM session memory captured", {
            subsystem: "memory",
            actor: "system",
            sessionID: sid,
            reason: "stop",
            ref: captured,
          })
        }
      } catch {
        // Best-effort only.
      }
    },
    "experimental.session.compacting": async (input, output) => {
      try {
        const sid = input.sessionID
        if (!sid) return
        if (!Array.isArray(output.context)) return
        markContextEpochDirty(sid)
        const blocks = [
          sessionHints.get(sid) ? `${AKM_HINTS_PREFIX}\n\n${sessionHints.get(sid)}` : "",
          sessionCurated.get(sid) ? `${AKM_CURATED_HEADER}\n${sessionCurated.get(sid)}${AKM_CURATED_TAIL}` : "",
          sessionWorkflow.get(sid) ? formatWorkflowContext(sessionWorkflow.get(sid)!) : "",
          sessionCuratorReport.get(sid) ? formatCuratorReportContext(sessionCuratorReport.get(sid)!) : "",
        ]
        output.context.push(...applyContextBudget(blocks))
      } catch {
        // Never break compaction because of plugin context.
      }
    },
    // experimental.chat.system.transform is how OpenCode exposes the
    // additionalContext channel. We append the cached hints (once per session)
    // and the curated assets (once per turn) so the next LLM call sees them.
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
          const blocks = [
            sessionHints.get(sid) ? `${AKM_HINTS_PREFIX}\n\n${sessionHints.get(sid)}` : "",
            sessionCurated.get(sid) ? `${AKM_CURATED_HEADER}\n${sessionCurated.get(sid)}${AKM_CURATED_TAIL}` : "",
            sessionWorkflow.get(sid) ? formatWorkflowContext(sessionWorkflow.get(sid)!) : "",
            sessionCuratorReport.get(sid) ? formatCuratorReportContext(sessionCuratorReport.get(sid)!) : "",
          ]
          output.system.push(...applyContextBudget(blocks))
          sessionContextInjectedEpoch.set(sid, epoch)
          if (sessionCurated.has(sid)) {
            // Startup curation is already included in the epoch-scoped block,
            // so mark that version as consumed to avoid a duplicate inject below.
            sessionCuratedInjectedVersion.set(sid, sessionCuratedVersion.get(sid) ?? 0)
          }
        }
        const curated = sid ? sessionCurated.get(sid) : undefined
        const curatedVersion = sessionCuratedVersion.get(sid) ?? 0
        if (curated) {
          if (sessionCuratedInjectedVersion.get(sid) !== curatedVersion) {
            output.system.push(...applyContextBudget([`${AKM_CURATED_HEADER}\n${curated}${AKM_CURATED_TAIL}`]))
            sessionCuratedInjectedVersion.set(sid, curatedVersion)
          }
        }
      } catch {
        // Never break the turn because of a transform failure.
      }
    },
    "tool.execute.before": async (input, output) => {
      try {
        if (!input.tool.startsWith("akm_")) return
        const args = output.args && typeof output.args === "object" ? output.args as Record<string, unknown> : {}
        const confirm = args.confirm === true
        if (input.tool === "akm_vault" && (args.action === "show" || args.action === "unset") && !confirm) {
          output.args = {
            ...args,
            __akmBlocked: `akm_vault action='${String(args.action)}' requires confirm:true to avoid accidental secret exposure or deletion.`,
          }
          return
        }
        output.args = args
      } catch {
        // Never break tool execution from the pre-hook.
      }
    },
    "shell.env": async (_input, output) => {
      try {
        output.env.AKM_PROJECT = worktree
        output.env.AKM_PLUGIN_VERSION = PLUGIN_VERSION
        const stashDir = getAkmStashDir()
        if (stashDir) output.env.AKM_STASH_DIR = stashDir
      } catch {
        // Best-effort only.
      }
    },
    "chat.message": async (input, output) => {
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

      // Compound-engineering loop: on every user message, curate the stash and
      // stash the result so experimental.chat.system.transform can inject it.
      if (AKM_AUTO_CURATE && input.sessionID) {
        const curated = runCurateForPrompt(text, input.sessionID)
        if (curated) {
          sessionCurated.set(input.sessionID, curated)
          bumpCuratedVersion(input.sessionID)
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

      if (input.sessionID && AKM_AUTO_FEEDBACK && AKM_RETROSPECTIVE_FEEDBACK_RE.test(text)) {
        const recentRefs = (sessionBuffer.get(input.sessionID) ?? [])
          .filter((entry) => entry.kind === "tool-ref" && !!entry.ref)
          .map((entry) => entry.ref!)
          .filter((ref, index, refs) => !ref.startsWith("memory:") && !ref.startsWith("vault:") && refs.indexOf(ref) === index)
          .slice(-3)
        const dedupe = new Set<string>()
        for (const ref of recentRefs) {
          queueFeedback(logClient, ref, "positive", "opencode retrospective: user confirmed it worked", {
            toolName: "chat.message",
            sessionID: input.sessionID,
          }, dedupe)
        }
      }
    },
    "tool.execute.after": async (input, output) => {
      if (!input.tool.startsWith("akm_")) return

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

      // Auto-feedback + session buffering: record every asset ref the tool
      // touched so the stash ranking improves over time and so Stop/Compact
      // has material to flush into a session summary memory.
      const refResult = extractToolRefs(input.tool, input.args as Record<string, unknown>, parsed)
      if (refResult.refs.length > 0 && input.sessionID) {
        for (const ref of refResult.refs) {
          addBufferEntry(input.sessionID, {
            kind: "tool-ref",
            toolName: input.tool,
            ref,
            status: feedback ?? "unknown",
          })
        }
        if (feedback === "positive") {
          sessionSuccessfulAssetTouchCount.set(
            input.sessionID,
            (sessionSuccessfulAssetTouchCount.get(input.sessionID) ?? 0) + 1,
          )
          const checkpointRef = maybeCheckpointSessionMemory(input.sessionID)
          if (checkpointRef) {
            await writePluginLog(logClient, "info", "AKM checkpoint memory captured", {
              subsystem: "memory",
              actor: "system",
              sessionID: input.sessionID,
              reason: "checkpoint",
              ref: checkpointRef,
            })
          }
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
          // Memories and vault refs are not first-class feedback targets —
          // memories do not accept feedback, and vault values never surface in
          // JSON so automatic usage signals would be misleading.
          if (ref.startsWith("memory:") || ref.startsWith("vault:")) continue
          const ok = queueFeedback(logClient, ref, feedback, note, {
            toolName: input.tool,
            sessionID: input.sessionID,
          }, dedupe)
          if (!ok) break
        }
      }
    },
    tool: {
    akm_search: tool({
      description: "Search your stash or the akm registry for scripts, skills, commands, agents, knowledge, memories, workflows, vaults, and wikis. Use source='registry' for installable community kits.",
      args: {
        query: tool.schema.string().describe("Case-insensitive substring search."),
        type: tool.schema
          .enum(ASSET_TYPES as unknown as [string, ...string[]])
          .optional()
          .describe("Optional type filter. Defaults to 'any'."),
        limit: tool.schema.number().optional().describe("Maximum number of hits to return. Defaults to 20."),
        source: tool.schema
          .enum(["local", "stash", "registry", "both"])
          .optional()
          .describe("Search source. 'stash' searches local stash directories, 'registry' searches registries, and 'both' searches all sources. 'local' remains a backward-compatible alias for 'stash'."),
      },
      async execute({ query, type, limit, source }) {
        return runCli(client as unknown as LogCapableClient, createSearchArgs({ query, type, limit, source }), { toolName: "akm_search" })
      },
    }),
    akm_show: tool({
      description: "Show a stash asset by ref. For knowledge assets, use view_mode to retrieve specific content (toc, section, lines, frontmatter).",
      args: {
        ref: tool.schema.string().describe("Asset reference returned by akm_search."),
        view_mode: tool.schema
          .enum(["full", "toc", "frontmatter", "section", "lines"])
          .optional()
          .describe("View mode for knowledge assets. Defaults to 'full'. Ignored for other types."),
        heading: tool.schema.string().optional()
          .describe("Section heading to extract (required when view_mode is 'section')."),
        start_line: tool.schema.number().optional()
          .describe("Start line number, 1-based (for view_mode 'lines')."),
        end_line: tool.schema.number().optional()
          .describe("End line number, 1-based inclusive (for view_mode 'lines')."),
      },
      async execute({ ref, view_mode, heading, start_line, end_line }) {
        const args = ["show", ref]
        if (view_mode) {
          args.push(view_mode)
          if (view_mode === "section" && heading) args.push(heading)
          if (view_mode === "lines") {
            if (start_line != null) args.push(String(start_line))
            if (end_line != null) args.push(String(end_line))
          }
        }
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_show" })
      },
    }),
    akm_remember: tool({
      description: "Record a memory in the default AKM stash so it can be searched and shown later.",
      args: {
        content: tool.schema.string().describe("Memory content to store."),
        name: tool.schema.string().optional().describe("Optional memory name."),
        force: tool.schema.boolean().optional().describe("Overwrite an existing memory with the same name."),
      },
      async execute({ content, name, force }) {
        const args = ["remember", content]
        if (name) args.push("--name", name)
        if (force) args.push("--force")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_remember" })
      },
    }),
    akm_feedback: tool({
      description: "Record positive or negative feedback for a stash asset so AKM can improve future ranking.",
      args: {
        ref: tool.schema.string().describe("Asset ref to record feedback for."),
        sentiment: tool.schema.enum(["positive", "negative"]).describe("Whether the feedback is positive or negative."),
        note: tool.schema.string().optional().describe("Optional note to attach to the feedback."),
      },
      async execute({ ref, sentiment, note }) {
        const args = ["feedback", ref, sentiment === "positive" ? "--positive" : "--negative"]
        if (note) args.push("--note", note)
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_feedback" })
      },
    }),
    akm_curate: tool({
      description: "Curate stash assets for a task or topic. Returns the top matches as a ranked list so the agent can inspect and use them.",
      args: {
        query: tool.schema.string().describe("Task, topic, or natural-language description of what you want to do."),
        limit: tool.schema.number().optional().describe("Maximum number of curated matches to return. Defaults to 6."),
        detail: tool.schema.enum(["summary", "normal", "full"]).optional().describe("Detail level for each match. Defaults to 'summary'."),
      },
      async execute({ query, limit, detail }) {
        const args = [
          "--for-agent",
          "--format",
          "text",
          "--detail",
          detail ?? "summary",
          "-q",
          "curate",
          query,
          "--limit",
          String(limit ?? 6),
        ]
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_curate" })
      },
    }),
    akm_evolve: tool({
      description: "Dispatch the AKM curator agent to review recent session activity and propose stash improvements (promote hot assets, flag cold ones, draft missing coverage). Persists the report as a memory and seeds the curator-context cache so it survives compaction.",
      args: {
        focus: tool.schema.string().optional().describe("Optional focus area or theme to weight the review toward."),
        dispatch_agent: tool.schema.string().optional().describe("OpenCode agent to run the curator with. Defaults to 'akm-curator', or falls back to 'general' when that agent is unavailable."),
        as_subtask: tool.schema.boolean().optional().describe("Run in a child session with parent context. Defaults to true."),
      },
      async execute({ focus, dispatch_agent, as_subtask }, context) {
        const useSubtask = as_subtask ?? true
        const requestedAgent = dispatch_agent ?? "akm-curator"
        const targetAgent = await resolveDispatchAgent(sdkClient, requestedAgent, context.directory)
        const targetSession = await ensureTargetSessionID({
          useSubtask,
          context: { sessionID: context.sessionID, directory: context.directory },
          title: "akm:curator",
          client: sdkClient,
          logClient,
          toolName: "akm_evolve",
        })
        if (!targetSession.ok) return JSON.stringify(targetSession)

        const task = focus && focus.trim()
          ? `Review recent AKM activity with an emphasis on: ${focus.trim()}. Produce the prioritized action list described in the system prompt.`
          : "Review recent AKM activity and produce the prioritized action list described in the system prompt."

        const promptResponse = await promptTargetSession({
          client: sdkClient,
          logClient,
          toolName: "akm_evolve",
          context: { sessionID: context.sessionID, directory: context.directory },
          targetSessionID: targetSession.sessionID,
          failureMessage: "Failed to dispatch curator",
          promptBody: {
            agent: targetAgent,
            system: targetAgent === "akm-curator" ? undefined : CURATOR_AGENT_PROMPT,
            parts: [{ type: "text", text: task }],
          },
        })
        if (!promptResponse.ok) return JSON.stringify(promptResponse)

        const fullText = extractText(promptResponse.data.parts)
        sessionCuratorReport.set(context.sessionID, summarizeCuratorReportForContext(fullText))
        markContextEpochDirty(context.sessionID)
        const dateTag = buildDateTag()
        const shortSid = context.sessionID.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 8) || "session"
        const curatorMemoryRef = fullText
          ? rememberTextAsMemory(`akm-curator-${dateTag}-${shortSid}`, fullText)
          : null

        return JSON.stringify({
          ok: true,
          dispatchAgent: targetAgent,
          usedSubtask: useSubtask,
          sessionID: targetSession.sessionID,
          focus: focus ?? null,
          curatorMemoryRef,
          text: fullText,
        })
      },
    }),
    akm_parent_messages: tool({
      description: "Read compact text summaries of the parent session's messages so a dispatched AKM subagent can inherit upstream context.",
      args: {},
      async execute(_input, context) {
        const parent = await getParentSessionID(sdkClient, context.sessionID, context.directory)
        if (!parent.ok) return JSON.stringify(parent)
        const messages = await sdkClient.session.messages({
          path: { id: parent.parentID },
          query: { directory: context.directory },
        })
        if (messages.error || !messages.data) {
          return JSON.stringify({ ok: false, error: "Failed to read parent session messages." })
        }
        return JSON.stringify(summarizeSessionMessages(parent.parentID, messages.data))
      },
    }),
    akm_session_messages: tool({
      description: "Read compact text summaries for a specific OpenCode session. Arbitrary session IDs are restricted to the akm-curator agent; other agents may read only their current or parent session.",
      args: {
        session_id: tool.schema.string().describe("OpenCode session ID to inspect."),
      },
      async execute({ session_id }, context) {
        const parent = await getParentSessionID(sdkClient, context.sessionID, context.directory)
        const allowedSessionIDs = new Set<string>([context.sessionID])
        if (parent.ok) allowedSessionIDs.add(parent.parentID)
        if (context.agent !== "akm-curator" && !allowedSessionIDs.has(session_id)) {
          return JSON.stringify({
            ok: false,
            error: "akm_session_messages only allows arbitrary session IDs for the akm-curator agent. Use akm_parent_messages for parent context.",
          })
        }
        const messages = await sdkClient.session.messages({
          path: { id: session_id },
          query: { directory: context.directory },
        })
        if (messages.error || !messages.data) {
          return JSON.stringify({ ok: false, error: `Failed to read messages for session '${session_id}'.` })
        }
        return JSON.stringify(summarizeSessionMessages(session_id, messages.data))
      },
    }),
    akm_agent: tool({
      description: "Dispatch a stash agent by ref into a child OpenCode session, applying the agent prompt and metadata from akm_show.",
      args: {
        ref: tool.schema.string().optional().describe("Agent ref from akm_search (e.g. agent:my-agent.md)."),
        query: tool.schema.string().optional().describe("If ref is omitted, resolve best matching stash agent for this query."),
        task_prompt: tool.schema.string().describe("Task prompt sent to the dispatched OpenCode agent."),
        dispatch_agent: tool.schema.string().optional().describe("OpenCode agent to run the task with. Defaults to 'general'."),
        as_subtask: tool.schema.boolean().optional().describe("Run in child session with parent context. Defaults to true."),
      },
      async execute({ ref, query, task_prompt, dispatch_agent, as_subtask }, context) {
        const logMeta = {
          toolName: "akm_agent",
          directory: context.directory,
          sessionID: context.sessionID,
        }
        const resolved = await resolveRefOrQueryInput(client as unknown as LogCapableClient, { ref, query }, "agent", logMeta)
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = await runCli(client as unknown as LogCapableClient, ["show", resolved.ref], logMeta)
        const shown = parseCliJson<ShowAgentResponse | { type: string }>(shownRaw)
        if (isCliError(shown)) {
          return JSON.stringify(shown)
        }

        if (!isShowAgentResponse(shown)) {
          return JSON.stringify({
            ok: false,
            error: `Ref ${ref} is not an agent payload from akm_show.`,
          })
        }

        if (!shown.prompt || !shown.prompt.trim()) {
          return JSON.stringify({
            ok: false,
            error: `Agent ${shown.name} is missing prompt content.`,
          })
        }

        const useSubtask = as_subtask ?? true
        const targetAgent = dispatch_agent ?? "general"
        const model = parseModelHint(shown.modelHint)
        const tools = parseToolPolicy(shown.toolPolicy)

        const targetSession = await ensureTargetSessionID({
          useSubtask,
          context: { sessionID: context.sessionID, directory: context.directory },
          title: `akm:${shown.name}`,
          client: client as unknown as PluginClient,
          logClient,
          toolName: "akm_agent",
        })
        if (!targetSession.ok) return JSON.stringify(targetSession)

        const promptBody: SessionPromptBody = {
          agent: targetAgent,
          system: shown.prompt,
          parts: [{ type: "text", text: task_prompt }],
        }
        if (model) promptBody.model = model
        if (tools) promptBody.tools = tools

        const promptResponse = await promptTargetSession({
          client: client as unknown as PluginClient,
          logClient,
          toolName: "akm_agent",
          context: { sessionID: context.sessionID, directory: context.directory },
          targetSessionID: targetSession.sessionID,
          promptBody,
          failureMessage: `Failed to dispatch prompt for ${resolved.ref}`,
          ref: resolved.ref,
        })
        if (!promptResponse.ok) return JSON.stringify(promptResponse)

        return JSON.stringify({
          ok: true,
          ref: resolved.ref,
          stashAgent: shown.name,
          dispatchAgent: targetAgent,
          usedSubtask: useSubtask,
          sessionID: targetSession.sessionID,
          model,
          tools,
          text: extractText(promptResponse.data.parts),
        })
      },
    }),
    akm_cmd: tool({
      description: "Execute a stash command template through the OpenCode SDK in the current or child session.",
      args: {
        ref: tool.schema.string().optional().describe("Command ref from akm_search (e.g. command:review.md)."),
        query: tool.schema.string().optional().describe("If ref is omitted, resolve best matching stash command for this query."),
        arguments: tool.schema.string().optional().describe("Command arguments used for $ARGUMENTS and positional placeholders ($1, $2, ...)."),
        dispatch_agent: tool.schema.string().optional().describe("OpenCode agent to run the rendered command. Defaults to current agent."),
        as_subtask: tool.schema.boolean().optional().describe("Run in child session with parent context. Defaults to false."),
      },
      async execute({ ref, query, arguments: commandArguments, dispatch_agent, as_subtask }, context) {
        const logMeta = {
          toolName: "akm_cmd",
          directory: context.directory,
          sessionID: context.sessionID,
        }
        const resolved = await resolveRefOrQueryInput(client as unknown as LogCapableClient, { ref, query }, "command", logMeta)
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = await runCli(client as unknown as LogCapableClient, ["show", resolved.ref], logMeta)
        const shown = parseCliJson<ShowCommandResponse | { type: string }>(shownRaw)
        if (isCliError(shown)) return JSON.stringify(shown)
        if (!isShowCommandResponse(shown)) {
          return JSON.stringify({ ok: false, error: `Ref ${resolved.ref} is not a command payload from akm_show.` })
        }

        const template = shown.template?.trim()
        if (!template) {
          return JSON.stringify({ ok: false, error: `Command ${shown.name} is missing template content.` })
        }

        const argsText = commandArguments ?? ""
        const rendered = renderCommandTemplate(template, argsText)
        const useSubtask = as_subtask ?? false
        const targetAgent = dispatch_agent ?? context.agent

        const targetSession = await ensureTargetSessionID({
          useSubtask,
          context: { sessionID: context.sessionID, directory: context.directory },
          title: `akm:cmd:${shown.name}`,
          client: client as unknown as PluginClient,
          logClient,
          toolName: "akm_cmd",
        })
        if (!targetSession.ok) return JSON.stringify(targetSession)

        const promptResponse = await promptTargetSession({
          client: client as unknown as PluginClient,
          logClient,
          toolName: "akm_cmd",
          context: { sessionID: context.sessionID, directory: context.directory },
          targetSessionID: targetSession.sessionID,
          failureMessage: `Failed to execute command ${resolved.ref}`,
          ref: resolved.ref,
          promptBody: {
            agent: targetAgent,
            parts: [{ type: "text", text: rendered }],
          },
        })
        if (!promptResponse.ok) return JSON.stringify(promptResponse)

        return JSON.stringify({
          ok: true,
          ref: resolved.ref,
          stashCommand: shown.name,
          dispatchAgent: targetAgent,
          usedSubtask: useSubtask,
          sessionID: targetSession.sessionID,
          arguments: argsText,
          renderedTemplate: rendered,
          text: extractText(promptResponse.data.parts),
        })
      },
    }),
    akm_vault: tool({
      description: "Manage encrypted-at-rest vaults of KEY=VALUE pairs. Values never surface in any output channel — 'show'/'list' return key names only, 'set'/'unset' never echo the value. Use 'load' to get a shell-eval snippet that loads values into the process. action='show' and action='unset' require confirm:true.",
      args: {
        action: tool.schema.enum(["list", "show", "create", "set", "unset", "load"]).describe("Vault subcommand. 'load' wraps `akm vault load` — treat its output as opaque shell text meant for eval."),
        ref: tool.schema.string().optional().describe("Vault ref such as vault:prod or vault:team/prod. Required for show/set/unset/load; optional for list."),
        name: tool.schema.string().optional().describe("Vault name when action is 'create' (e.g. 'prod' → vaults/prod.env)."),
        key: tool.schema.string().optional().describe("Variable name for set/unset. May include '=' to pass KEY=VALUE in one field when value is omitted."),
        value: tool.schema.string().optional().describe("Value to store. Never echoed back."),
        comment: tool.schema.string().optional().describe("Optional inline '# comment' written above the key for 'set'."),
        confirm: tool.schema.boolean().optional().describe("Must be true for sensitive actions like show and unset."),
      },
      async execute(input) {
        const blocked = blockedToolResponse(input as Record<string, unknown>)
        if (blocked) return blocked
        const { action, ref, name, key, value, comment } = input
        const logMeta = { toolName: "akm_vault" }
        switch (action) {
          case "list": {
            const args = ["vault", "list"]
            if (ref) args.push(ref)
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "show": {
            if (!ref) return JSON.stringify({ ok: false, error: "'ref' is required for action='show'." })
            return runCli(client as unknown as LogCapableClient, ["vault", "show", ref], logMeta)
          }
          case "create": {
            if (!name) return JSON.stringify({ ok: false, error: "'name' is required for action='create'." })
            return runCli(client as unknown as LogCapableClient, ["vault", "create", name], logMeta)
          }
          case "set": {
            if (!ref) return JSON.stringify({ ok: false, error: "'ref' is required for action='set'." })
            if (!key) return JSON.stringify({ ok: false, error: "'key' is required for action='set'." })
            const args = ["vault", "set", ref, key]
            if (value != null) args.push(value)
            if (comment) args.push("--comment", comment)
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "unset": {
            if (!ref) return JSON.stringify({ ok: false, error: "'ref' is required for action='unset'." })
            if (!key) return JSON.stringify({ ok: false, error: "'key' is required for action='unset'." })
            return runCli(client as unknown as LogCapableClient, ["vault", "unset", ref, key], logMeta)
          }
          case "load": {
            if (!ref) return JSON.stringify({ ok: false, error: "'ref' is required for action='load'." })
            // `vault load` emits raw shell — not JSON. Return the snippet verbatim
            // so the caller can hand it to a shell via eval. Never parse values.
            const command = resolveAkmCommand()
            if (typeof command !== "string") return JSON.stringify(command)
            try {
              const stdout = execFileSync(command, ["vault", "load", ref], {
                encoding: "utf8",
                timeout: 30_000,
              })
              return JSON.stringify({ ok: true, ref, shell: stdout.trim() })
            } catch (error: unknown) {
              return JSON.stringify({ ok: false, error: formatCliError(error) })
            }
          }
        }
      },
    }),
    akm_wiki: tool({
      description: "Manage AKM wikis — multi-wiki knowledge bases under <stashDir>/wikis/<name>/. Supports scaffolding, registering external sources, listing pages, scoped search, stashing raw sources, lint, and ingest workflow.",
      args: {
        action: tool.schema.enum([
          "create",
          "register",
          "list",
          "show",
          "remove",
          "pages",
          "search",
          "stash",
          "lint",
          "ingest",
        ]).describe("Wiki subcommand."),
        name: tool.schema.string().optional().describe("Wiki name (required for every action except 'list')."),
        source_ref: tool.schema.string().optional().describe("Source ref to register (required for action='register'). Accepts directory paths, git URLs, github owner/repo, or https:// website roots."),
        writable: tool.schema.boolean().optional().describe("When registering a git-backed source, mark it as push-writable (used by `akm save`; see akm_help topic='save')."),
        trust: tool.schema.boolean().optional().describe("Bypass install-audit blocking for this registration only."),
        max_pages: tool.schema.number().optional().describe("Crawler page cap when registering a website (default 50)."),
        max_depth: tool.schema.number().optional().describe("Crawler depth cap when registering a website (default 3)."),
        query: tool.schema.string().optional().describe("Query string for action='search'."),
        limit: tool.schema.number().optional().describe("Result cap for action='search'."),
        source: tool.schema.string().optional().describe("Source path (or '-' for stdin) for action='stash'."),
        as_slug: tool.schema.string().optional().describe("Explicit slug for action='stash' (defaults to derived from source)."),
        content: tool.schema.string().optional().describe("Raw content to feed stdin when stashing with source='-'."),
        force: tool.schema.boolean().optional().describe("Required for action='remove'."),
        with_sources: tool.schema.boolean().optional().describe("When removing, also delete the raw/ sources (default false)."),
      },
      async execute({ action, name, source_ref, writable, trust, max_pages, max_depth, query, limit, source, as_slug, content, force, with_sources }) {
        const logMeta = { toolName: "akm_wiki" }
        const requireName = () => {
          if (!name) return JSON.stringify({ ok: false, error: `'name' is required for action='${action}'.` })
          return null
        }
        switch (action) {
          case "list":
            return runCli(client as unknown as LogCapableClient, ["wiki", "list"], logMeta)
          case "create": {
            const err = requireName(); if (err) return err
            return runCli(client as unknown as LogCapableClient, ["wiki", "create", name!], logMeta)
          }
          case "show": {
            const err = requireName(); if (err) return err
            return runCli(client as unknown as LogCapableClient, ["wiki", "show", name!], logMeta)
          }
          case "pages": {
            const err = requireName(); if (err) return err
            return runCli(client as unknown as LogCapableClient, ["wiki", "pages", name!], logMeta)
          }
          case "ingest": {
            const err = requireName(); if (err) return err
            return runCli(client as unknown as LogCapableClient, ["wiki", "ingest", name!], logMeta)
          }
          case "lint": {
            const err = requireName(); if (err) return err
            // `wiki lint` exits 1 when findings exist, which runCli surfaces as
            // an error envelope. That is still useful output — the JSON body is
            // the lint report. Pass through either way.
            return runCli(client as unknown as LogCapableClient, ["wiki", "lint", name!], logMeta)
          }
          case "register": {
            const err = requireName(); if (err) return err
            if (!source_ref) return JSON.stringify({ ok: false, error: "'source_ref' is required for action='register'." })
            const args = ["wiki", "register", name!, source_ref]
            if (writable) args.push("--writable")
            if (trust) args.push("--trust")
            if (max_pages != null) args.push("--max-pages", String(max_pages))
            if (max_depth != null) args.push("--max-depth", String(max_depth))
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "remove": {
            const err = requireName(); if (err) return err
            if (!force) return JSON.stringify({ ok: false, error: "'force' must be true to remove a wiki." })
            const args = ["wiki", "remove", name!, "--force"]
            if (with_sources) args.push("--with-sources")
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "search": {
            const err = requireName(); if (err) return err
            if (!query) return JSON.stringify({ ok: false, error: "'query' is required for action='search'." })
            const args = ["wiki", "search", name!, query]
            if (limit != null) args.push("--limit", String(limit))
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "stash": {
            const err = requireName(); if (err) return err
            if (!source) return JSON.stringify({ ok: false, error: "'source' is required for action='stash'." })
            const args = ["wiki", "stash", name!, source]
            if (as_slug) args.push("--as", as_slug)
            if (source === "-" && content) {
              const command = resolveAkmCommand()
              if (typeof command !== "string") return JSON.stringify(command)
              try {
                const stdout = execFileSync(command, [...args, "--format", "json"], {
                  encoding: "utf8",
                  timeout: 60_000,
                  input: content,
                })
                return stdout
              } catch (error: unknown) {
                return JSON.stringify({ ok: false, error: formatCliError(error) })
              }
            }
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
        }
      },
    }),
    akm_workflow: tool({
      description: "Manage AKM workflow runs — stateful multi-step procedures defined as workflow:<name> assets. Use start/next/complete/resume to drive a run, status/list to inspect, create/template to author.",
      args: {
        action: tool.schema.enum([
          "start",
          "next",
          "complete",
          "status",
          "list",
          "create",
          "template",
          "resume",
        ]).describe("Workflow subcommand."),
        ref: tool.schema.string().optional().describe("Workflow ref (e.g. workflow:release). Required for start; accepted by next/status as a target."),
        target: tool.schema.string().optional().describe("Run id or workflow ref for next/status. When a workflow ref is passed to 'next', a new run is auto-started."),
        run_id: tool.schema.string().optional().describe("Workflow run id. Required for complete and resume."),
        params: tool.schema.string().optional().describe("JSON object string of parameters for start/next."),
        step: tool.schema.string().optional().describe("Step id to transition (required for action='complete')."),
        state: tool.schema.enum(["completed", "blocked", "failed", "skipped"]).optional().describe("Step state for 'complete'. Defaults to 'completed'."),
        notes: tool.schema.string().optional().describe("Freeform notes attached to the step transition."),
        evidence: tool.schema.string().optional().describe("JSON object string of evidence attached to the step transition."),
        name: tool.schema.string().optional().describe("Workflow name for action='create'."),
        from: tool.schema.string().optional().describe("Path to a markdown template for action='create'."),
        force: tool.schema.boolean().optional().describe("Overwrite an existing workflow on create (requires --from or --reset)."),
        reset: tool.schema.boolean().optional().describe("Reset to the built-in template for action='create'."),
        filter_ref: tool.schema.string().optional().describe("Restrict action='list' to runs of this workflow ref."),
        active_only: tool.schema.boolean().optional().describe("Restrict action='list' to active (non-terminal) runs."),
      },
      async execute({
        action,
        ref,
        target,
        run_id,
        params,
        step,
        state,
        notes,
        evidence,
        name,
        from,
        force,
        reset,
        filter_ref,
        active_only,
      }) {
        const logMeta = { toolName: "akm_workflow" }
        switch (action) {
          case "start": {
            if (!ref) return JSON.stringify({ ok: false, error: "'ref' is required for action='start'." })
            const args = ["workflow", "start", ref]
            if (params) args.push("--params", params)
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "next": {
            const picked = target ?? run_id ?? ref
            if (!picked) return JSON.stringify({ ok: false, error: "'target', 'run_id', or 'ref' is required for action='next'." })
            const args = ["workflow", "next", picked]
            if (params) args.push("--params", params)
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "complete": {
            if (!run_id) return JSON.stringify({ ok: false, error: "'run_id' is required for action='complete'." })
            if (!step) return JSON.stringify({ ok: false, error: "'step' is required for action='complete'." })
            const args = ["workflow", "complete", run_id, "--step", step]
            if (state) args.push("--state", state)
            if (notes) args.push("--notes", notes)
            if (evidence) args.push("--evidence", evidence)
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "status": {
            const picked = target ?? run_id ?? ref
            if (!picked) return JSON.stringify({ ok: false, error: "'target', 'run_id', or 'ref' is required for action='status'." })
            return runCli(client as unknown as LogCapableClient, ["workflow", "status", picked], logMeta)
          }
          case "list": {
            const args = ["workflow", "list"]
            if (filter_ref) args.push("--ref", filter_ref)
            if (active_only) args.push("--active")
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "create": {
            if (!name) return JSON.stringify({ ok: false, error: "'name' is required for action='create'." })
            const args = ["workflow", "create", name]
            if (from) args.push("--from", from)
            if (force) args.push("--force")
            if (reset) args.push("--reset")
            return runCli(client as unknown as LogCapableClient, args, logMeta)
          }
          case "template": {
            // The workflow template is emitted as raw markdown, not JSON.
            const command = resolveAkmCommand()
            if (typeof command !== "string") return JSON.stringify(command)
            try {
              const stdout = execFileSync(command, ["workflow", "template"], {
                encoding: "utf8",
                timeout: 30_000,
              })
              return JSON.stringify({ ok: true, template: stdout })
            } catch (error: unknown) {
              return JSON.stringify({ ok: false, error: formatCliError(error) })
            }
          }
          case "resume": {
            if (!run_id) return JSON.stringify({ ok: false, error: "'run_id' is required for action='resume'." })
            return runCli(client as unknown as LogCapableClient, ["workflow", "resume", run_id], logMeta)
          }
        }
      },
    }),
    akm_help: tool({
      description: "Discover the right `akm` CLI command and args for tasks not covered by a first-class tool — e.g. save/push, import, clone, update, remove, list sources, registry search, reindex, config, CLI upgrade, run script. Returns a curated quick-reference plus live `akm --help` output. Pass `command` to drill into a specific subcommand.",
      args: {
        topic: tool.schema.string().optional().describe("Natural-language description of the task (e.g. 'commit and push my stash', 'install a kit from github'). Returns curated hints if any keywords match."),
        command: tool.schema.string().optional().describe("Specific akm subcommand to inspect (e.g. 'save', 'clone', 'config'). Runs `akm <command> --help` and returns the output verbatim."),
      },
      async execute({ topic, command }) {
        const cliCommand = resolveAkmCommand()
        if (typeof cliCommand !== "string") return JSON.stringify(cliCommand)
        const helpArgs = command && command.trim()
          ? [command.trim(), "--help"]
          : ["--help"]
        let helpText = ""
        try {
          helpText = execFileSync(cliCommand, helpArgs, {
            encoding: "utf8",
            timeout: 30_000,
          }).toString().trim()
        } catch (error: unknown) {
          return JSON.stringify({ ok: false, error: formatCliError(error) })
        }
        return JSON.stringify({
          ok: true,
          command: command ?? null,
          topic: topic ?? null,
          hints: topic ? lookupAkmHelpHint(topic) : [],
          quickReference: AKM_HELP_QUICK_REFERENCE,
          help: helpText,
        })
      },
    }),
    },
  }
}

export const server = AkmPlugin
export default { server }
