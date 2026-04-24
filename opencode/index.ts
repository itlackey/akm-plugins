import { type Plugin, tool } from "@opencode-ai/plugin"
import { execFileSync, execSync } from "node:child_process"
import path from "node:path"

let resolvedAkmCommand = "akm"
const autoInstallPackageRef = "akm-cli@latest"

const AKM_AUTO_FEEDBACK = (process.env.AKM_AUTO_FEEDBACK ?? "1") !== "0"
const AKM_AUTO_MEMORY = (process.env.AKM_AUTO_MEMORY ?? "1") !== "0"
const AKM_AUTO_CURATE = (process.env.AKM_AUTO_CURATE ?? "1") !== "0"
const AKM_AUTO_HINTS = (process.env.AKM_AUTO_HINTS ?? "1") !== "0"
const AKM_CURATE_LIMIT = Math.max(1, Number(process.env.AKM_CURATE_LIMIT ?? "5") || 5)
const AKM_CURATE_MIN_CHARS = Math.max(1, Number(process.env.AKM_CURATE_MIN_CHARS ?? "16") || 16)
const AKM_CURATE_TIMEOUT_MS = Math.max(1_000, (Number(process.env.AKM_CURATE_TIMEOUT ?? "8") || 8) * 1_000)

// Per-session state that drives the compound-engineering loop.
// These maps are keyed by OpenCode sessionID.
const sessionHints = new Map<string, string>()
const sessionCurated = new Map<string, string>()
type SessionBufferEntry = {
  timestamp: string
  kind: "memory-intent" | "tool-ref"
  toolName?: string
  ref?: string
  status?: "positive" | "negative" | "unknown"
  note?: string
}
const sessionBuffer = new Map<string, SessionBufferEntry[]>()
const sessionMemoryCaptured = new Set<string>()

// Asset-ref grammar matching the stash skill: [origin//]type:name
const AKM_REF_PATTERN = /(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|script|workflow|vault|wiki):[A-Za-z0-9._/\-]+/g

const CURATOR_AGENT_PROMPT = `You are the AKM curator — a compound-engineering agent that keeps the user's AKM stash improving every time the main agent finishes a task.

Inputs you should inspect:
1. OpenCode app logs that include the "akm-opencode" service (feedback, memory, tool invocations).
2. Session-summary memories named memory:opencode-session-*.
3. The live stash: call akm_list, akm_search "" --limit 50, and akm_show <ref>.

Signals to act on:
- Hot refs: assets repeatedly appearing in positive tool outcomes. Call akm_feedback <ref> positive --note "curator: consistently useful" to reinforce.
- Cold refs: assets tied to failures or user complaints. Record akm_feedback <ref> negative --note "<excerpt>" and open the asset for review.
- Missing coverage: recurring user prompts with no matching asset. Draft a new skill, command, knowledge doc, wiki page, or workflow in the working stash and reindex with akm_index.
- Duplicates / drift: near-identical descriptions or overlapping responsibilities. Propose a consolidation.
- Stale memories: session summaries that never get recalled. Propose akm_remove memory:<name> once distilled into a durable knowledge doc or wiki page.
- Wiki hygiene: for each wiki returned by akm_wiki list, run akm_wiki lint <name> and report orphans, broken xrefs, uncited raws, and stale indexes as fix candidates.
- Stuck workflows: run akm_workflow list --active and surface any runs in blocked or failed state with their step ids. Propose whether to resume or escalate.
- Never touch vaults: do not call akm_vault show or shell_snippet unless the user explicitly asks. Vault values must never appear in reports.

Rules of engagement:
- Never apply destructive changes without explicit user approval.
- Report findings as a prioritized action list of concrete akm_* tool calls the user can run.
- Prefer small, reversible edits: promote via positive feedback, draft a candidate skill, or clone and tweak.
- When drafting new assets, write them into the working stash directory (akm_config get stashDir) under skills/, commands/, agents/, knowledge/, or scripts/. Call akm_index when finished.
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

function addBufferEntry(sessionID: string | undefined, entry: Omit<SessionBufferEntry, "timestamp">) {
  if (!sessionID) return
  const buf = sessionBuffer.get(sessionID) ?? []
  buf.push({ timestamp: nowIso(), ...entry })
  sessionBuffer.set(sessionID, buf)
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

function runCurateForPrompt(text: string): string | null {
  if (!text || text.length < AKM_CURATE_MIN_CHARS) return null
  const result = runCliSyncRaw(
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
    AKM_CURATE_TIMEOUT_MS,
  )
  if (!result.ok) return null
  const body = result.stdout.trim()
  return body || null
}

function runHintsForSession(): string | null {
  const result = runCliSyncRaw(["--format", "text", "-q", "hints"], AKM_CURATE_TIMEOUT_MS)
  if (!result.ok) return null
  const body = result.stdout.trim()
  return body || null
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

function recordFeedbackSync(ref: string, sentiment: "positive" | "negative", note: string): boolean {
  const result = runCliSyncRaw(
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
    AKM_CURATE_TIMEOUT_MS,
  )
  return result.ok
}

function captureSessionMemory(sessionID: string, reason: string): string | null {
  if (!AKM_AUTO_MEMORY) return null
  if (!sessionID) return null
  if (sessionMemoryCaptured.has(sessionID)) return null
  const entries = sessionBuffer.get(sessionID) ?? []
  // Require at least two observations before persisting — single events are noise.
  if (entries.length < 2) {
    sessionBuffer.delete(sessionID)
    return null
  }

  const lines: string[] = []
  lines.push(`# Session summary (${nowIso()})`)
  lines.push(`Reason: ${reason}`)
  lines.push(`Session: ${sessionID}`)
  lines.push("")
  for (const entry of entries) {
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

  const dateTag = new Date().toISOString().replace(/[-:]/g, "").slice(0, 8)
  const shortSid = sessionID.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 8) || "session"
  const name = `opencode-session-${dateTag}-${shortSid}`

  const command = resolveAkmCommand()
  if (typeof command !== "string") {
    sessionMemoryCaptured.add(sessionID)
    sessionBuffer.delete(sessionID)
    return null
  }
  try {
    execFileSync(command, ["--format", "json", "-q", "remember", "--name", name, "--force"], {
      encoding: "utf8",
      timeout: AKM_CURATE_TIMEOUT_MS * 2,
      input: body,
    })
    sessionMemoryCaptured.add(sessionID)
    sessionBuffer.delete(sessionID)
    return `memory:${name}`
  } catch {
    sessionMemoryCaptured.add(sessionID)
    sessionBuffer.delete(sessionID)
    return null
  }
}

function extractToolRefs(toolName: string, args: Record<string, unknown>, output: unknown): string[] {
  const refs = new Set<string>()
  const addMatches = (value: unknown) => {
    if (typeof value !== "string") return
    const matches = value.match(AKM_REF_PATTERN)
    if (matches) for (const ref of matches) refs.add(ref)
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

  return [...refs]
}

const AKM_HINTS_PREFIX = [
  "# AKM is available in this session",
  "",
  "You have an AKM stash on this machine. Before writing anything from scratch, call `akm_search` or `akm_curate` to see if the stash already covers it. Record `akm_feedback <ref> positive|negative` whenever an asset materially helps or misses, and use `akm_remember` to persist durable learnings so future sessions inherit them.",
].join("\n")

const AKM_CURATED_HEADER = "# AKM stash — assets relevant to this prompt"
const AKM_CURATED_TAIL = "\n\nTip: call `akm_show <ref>` to fetch full content, and record `akm_feedback <ref> positive|negative` once you know whether the asset helped."

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

  const fullArgs = [...args, "--format", "json"]

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

async function resolveRefInput(
  client: LogCapableClient,
  input: { ref?: string; query?: string },
  type: AssetType,
  meta: CliLogMeta,
): Promise<{ ok: true; ref: string } | CliError> {
  if (input.ref && input.ref.trim()) {
    return { ok: true, ref: input.ref.trim() }
  }

  const query = input.query?.trim()
  if (!query) {
    return { ok: false, error: "Provide either 'ref' or 'query'." }
  }

  const raw = await runCli(client, ["search", query, "--type", type, "--limit", "1", "--detail", "normal", "--source", "stash"], meta)
  const parsed = parseCliJson<SearchResponse>(raw)
  if (isCliError(parsed)) return parsed

  const ref = parsed.hits?.[0]?.ref
  if (!ref) {
    return { ok: false, error: `No ${type} match found for query '${query}'.` }
  }

  return { ok: true, ref }
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
    prompt: (input: {
      path: { id: string }
      body: SessionPromptBody
    }) => Promise<{ data?: { parts?: unknown }; error?: unknown }>
  }
}

export const AkmPlugin: Plugin = async ({ client }) => {
  await ensureLatestAkmInstalled(client as unknown as LogCapableClient)

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
          if (!AKM_AUTO_HINTS) return
          if (sessionHints.has(sid)) return
          warmIndexInBackground()
          const hints = runHintsForSession()
          if (hints) sessionHints.set(sid, hints)
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
            sessionMemoryCaptured.delete(sid)
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
        const hints = sid ? sessionHints.get(sid) : undefined
        if (hints) {
          output.system.push(`${AKM_HINTS_PREFIX}\n\n${hints}`)
          // Only inject hints on the first transform of the session.
          sessionHints.delete(sid)
        }
        const curated = sid ? sessionCurated.get(sid) : undefined
        if (curated) {
          output.system.push(`${AKM_CURATED_HEADER}\n${curated}${AKM_CURATED_TAIL}`)
          sessionCurated.delete(sid)
        }
      } catch {
        // Never break the turn because of a transform failure.
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
        const curated = runCurateForPrompt(text)
        if (curated) sessionCurated.set(input.sessionID, curated)
      }

      // Track explicit memory intents so capture-memory has something durable
      // to flush when the session ends.
      if (/\b(remember|memory|memories)\b/i.test(text)) {
        addBufferEntry(input.sessionID, {
          kind: "memory-intent",
          note: truncateLogText(text, 500),
        })
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
      const allRefs = extractToolRefs(input.tool, input.args as Record<string, unknown>, parsed)
      if (allRefs.length > 0 && input.sessionID) {
        for (const ref of allRefs) {
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
        && allRefs.length > 0
      ) {
        const note = feedback === "positive"
          ? `opencode auto: ${input.tool} succeeded`
          : `opencode auto: ${input.tool} failed`
        for (const ref of allRefs) {
          // Memories and vault refs are not first-class feedback targets —
          // memories do not accept feedback, and vault values never surface in
          // JSON so automatic usage signals would be misleading.
          if (ref.startsWith("memory:") || ref.startsWith("vault:")) continue
          const ok = recordFeedbackSync(ref, feedback, note)
          if (!ok) break
        }
      }
    },
    tool: {
    akm_search: tool({
      description: "Search your stash or the akm registry for scripts, skills, commands, agents, knowledge, memories, workflows, vaults, and wikis. Use source='registry' or akm_registry_search for installable community kits.",
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
    akm_registry_search: tool({
      description: "Search configured akm registries only. Use this when you want installable kits without mixing in local stash results.",
      args: {
        query: tool.schema.string().describe("Search query for installable registry kits."),
        type: tool.schema
          .enum(ASSET_TYPES as unknown as [string, ...string[]])
          .optional()
          .describe("Optional asset type filter. Defaults to 'any'."),
        limit: tool.schema.number().optional().describe("Maximum number of registry hits to return. Defaults to 20."),
        assets: tool.schema.boolean().optional().describe("Include asset-level results from registry index v2 payloads."),
      },
      async execute({ query, type, limit, assets }) {
        const args = ["registry", "search", query]
        if (limit) args.push("--limit", String(limit))
        const assetTypeFilter = type && type !== "any" ? type : undefined
        if (assets || assetTypeFilter) args.push("--assets")

        const raw = await runCli(client as unknown as LogCapableClient, args, { toolName: "akm_registry_search" })
        if (!assetTypeFilter) return raw

        const parsed = parseCliJson<{
          hits?: SearchHit[]
          assetHits?: Array<SearchHit & { assetType?: AssetType }>
          warnings?: string[]
          query?: string
        }>(raw)
        if (isCliError(parsed)) return JSON.stringify(parsed)

        return JSON.stringify({
          ...parsed,
          hits: [],
          assetHits: (parsed.assetHits ?? []).filter((hit) => hit.assetType === assetTypeFilter),
        })
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
    akm_index: tool({
      description: "Build or rebuild the akm stash index. Scans stash directories, generates missing .stash.json metadata, and builds a semantic search index.",
      args: {},
      async execute() {
        return runCli(client as unknown as LogCapableClient, ["index"], { toolName: "akm_index" })
      },
    }),
    akm_add: tool({
      description: "Install a kit or register an external source from npm, GitHub, another git host, a URL, or a local directory. Use type='wiki' to register a wiki source instead of a stash kit.",
      args: {
        package_ref: tool.schema.string().describe("Package reference such as npm:@scope/kit, github:<owner>/<repo>, git+https://host/repo, https://url, or ./local/kit."),
        type: tool.schema.enum(["wiki"]).optional().describe("Route the add through a typed registrar. 'wiki' registers an external wiki source."),
        name: tool.schema.string().optional().describe("Optional name to register the source under."),
        writable: tool.schema.boolean().optional().describe("Mark a git-backed source as push-writable (used by akm save)."),
        trust: tool.schema.boolean().optional().describe("Bypass install-audit blocking for this registration only."),
        provider: tool.schema.string().optional().describe("Provider hint (required for raw URL refs, e.g. 'github', 'website')."),
        options: tool.schema.string().optional().describe("JSON string of provider-specific options."),
        max_pages: tool.schema.number().optional().describe("Cap for website crawlers (default 50)."),
        max_depth: tool.schema.number().optional().describe("Depth cap for website crawlers (default 3)."),
      },
      async execute({ package_ref, type, name, writable, trust, provider, options, max_pages, max_depth }) {
        const args = ["add", package_ref]
        if (type) args.push("--type", type)
        if (name) args.push("--name", name)
        if (writable) args.push("--writable")
        if (trust) args.push("--trust")
        if (provider) args.push("--provider", provider)
        if (options) args.push("--options", options)
        if (max_pages != null) args.push("--max-pages", String(max_pages))
        if (max_depth != null) args.push("--max-depth", String(max_depth))
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_add" })
      },
    }),
    akm_list: tool({
      description: "List all configured AKM sources, including local directories, managed kits, and remote providers.",
      args: {},
      async execute() {
        return runCli(client as unknown as LogCapableClient, ["list"], { toolName: "akm_list" })
      },
    }),
    akm_remove: tool({
      description: "Remove a configured AKM source by id, ref, path, URL, or name and reindex the stash.",
      args: {
        package_ref: tool.schema.string().describe("Source id, ref, path, URL, or name, such as npm:@scope/kit, owner/repo, or ~/.claude/skills."),
      },
      async execute({ package_ref }) {
        return runCli(client as unknown as LogCapableClient, ["remove", package_ref], { toolName: "akm_remove" })
      },
    }),
    akm_update: tool({
      description: "Update one managed AKM source or all managed sources to the latest available version.",
      args: {
        package_ref: tool.schema.string().optional().describe("Managed source id or ref to update."),
        all: tool.schema.boolean().optional().describe("Update all installed kits."),
        force: tool.schema.boolean().optional().describe("Force a fresh download even if the version is unchanged."),
      },
      async execute({ package_ref, all, force }) {
        const args = ["update"]
        const packageRef = package_ref?.trim()
        if (all) {
          args.push("--all")
        } else if (packageRef) {
          args.push(packageRef)
        } else {
          return JSON.stringify({ ok: false, error: "Provide 'package_ref' or set 'all' to true." })
        }
        if (force) args.push("--force")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_update" })
      },
    }),
    akm_clone: tool({
      description: "Clone an asset from any source into the working stash or a custom destination for editing.",
      args: {
        ref: tool.schema.string().describe("Asset ref to clone, including optional origin such as npm:@scope/pkg//script:deploy.sh."),
        name: tool.schema.string().optional().describe("Optional new asset name."),
        dest: tool.schema.string().optional().describe("Optional destination directory. The type subdirectory is appended automatically by akm."),
        force: tool.schema.boolean().optional().describe("Overwrite the destination if it already exists."),
      },
      async execute({ ref, name, dest, force }) {
        const args = ["clone", ref]
        if (name) args.push("--name", name)
        if (dest) args.push("--dest", dest)
        if (force) args.push("--force")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_clone" })
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
      description: "Dispatch the AKM curator agent to review recent session activity and propose stash improvements (promote hot assets, flag cold ones, draft missing coverage).",
      args: {
        focus: tool.schema.string().optional().describe("Optional focus area or theme to weight the review toward."),
        dispatch_agent: tool.schema.string().optional().describe("OpenCode agent to run the curator with. Defaults to 'general'."),
        as_subtask: tool.schema.boolean().optional().describe("Run in a child session with parent context. Defaults to true."),
      },
      async execute({ focus, dispatch_agent, as_subtask }, context) {
        const useSubtask = as_subtask ?? true
        const targetAgent = dispatch_agent ?? "general"
        const targetSession = await ensureTargetSessionID({
          useSubtask,
          context: { sessionID: context.sessionID, directory: context.directory },
          title: "akm:curator",
          client: client as unknown as PluginClient,
          logClient,
          toolName: "akm_evolve",
        })
        if (!targetSession.ok) return JSON.stringify(targetSession)

        const task = focus && focus.trim()
          ? `Review recent AKM activity with an emphasis on: ${focus.trim()}. Produce the prioritized action list described in the system prompt.`
          : "Review recent AKM activity and produce the prioritized action list described in the system prompt."

        const promptResponse = await promptTargetSession({
          client: client as unknown as PluginClient,
          logClient,
          toolName: "akm_evolve",
          context: { sessionID: context.sessionID, directory: context.directory },
          targetSessionID: targetSession.sessionID,
          failureMessage: "Failed to dispatch curator",
          promptBody: {
            agent: targetAgent,
            system: CURATOR_AGENT_PROMPT,
            parts: [{ type: "text", text: task }],
          },
        })
        if (!promptResponse.ok) return JSON.stringify(promptResponse)

        return JSON.stringify({
          ok: true,
          dispatchAgent: targetAgent,
          usedSubtask: useSubtask,
          sessionID: targetSession.sessionID,
          focus: focus ?? null,
          text: extractText(promptResponse.data.parts),
        })
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
        const resolved = await resolveRefInput(client as unknown as LogCapableClient, { ref, query }, "agent", logMeta)
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
        const resolved = await resolveRefInput(client as unknown as LogCapableClient, { ref, query }, "command", logMeta)
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
    akm_config: tool({
      description: "View or update akm configuration settings.",
      args: {
        action: tool.schema.enum(["get", "set", "list", "unset", "path"]).describe("Config action: get, set, list, unset, or path."),
        key: tool.schema.string().optional().describe("Config key (required for get/set)."),
        value: tool.schema.string().optional().describe("Config value (required for set)."),
        all: tool.schema.boolean().optional().describe("When action is 'path', include config, stash, cache, and index paths."),
      },
      async execute({ action, key, value, all }) {
        const args = ["config", action]
        if (key) args.push(key)
        if (value) args.push(value)
        if (action === "path" && all) args.push("--all")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_config" })
      },
    }),
    akm_run: tool({
      description: "Execute a stash script by ref. Resolves via search, fetches metadata via show, and runs the run command.",
      args: {
        ref: tool.schema.string().optional().describe("Script ref from akm_search (e.g. script:deploy.sh)."),
        query: tool.schema.string().optional().describe("If ref is omitted, resolve best matching stash script for this query."),
        args: tool.schema.string().optional().describe("Arguments to append to the run command."),
      },
      async execute({ ref, query, args: runArgs }) {
        const resolved = await resolveRefInput(client as unknown as LogCapableClient, { ref, query }, "script", { toolName: "akm_run" })
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = await runCli(client as unknown as LogCapableClient, ["show", resolved.ref], { toolName: "akm_run" })
        const shown = parseCliJson<ShowToolResponse | { type: string }>(shownRaw)
        if (isCliError(shown)) return JSON.stringify(shown)

        if (!isShowToolResponse(shown)) {
          return JSON.stringify({
            ok: false,
            error: `Ref ${resolved.ref} is not a script payload from akm_show.`,
          })
        }

        if (!shown.run || !shown.run.trim()) {
          return JSON.stringify({
            ok: false,
            error: `Script ${shown.name} is missing run command.`,
          })
        }

        let cmd = shown.run
        if (runArgs && runArgs.trim()) {
          cmd = `${cmd} ${runArgs.trim()}`
        }

        try {
          const output = execSync(cmd, {
            encoding: "utf8",
            timeout: 120_000,
          })
          return JSON.stringify({
            ok: true,
            ref: resolved.ref,
            script: shown.name,
            run: cmd,
            output,
          })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return JSON.stringify({
            ok: false,
            error: `Failed to execute run command for ${shown.name}: ${message}`,
          })
        }
      },
    }),
    akm_sources: tool({
      description: "List all configured AKM sources. Kept as a backward-compatible alias for the older sources command.",
      args: {},
      async execute() {
        return runCli(client as unknown as LogCapableClient, ["list"], { toolName: "akm_sources" })
      },
    }),
    akm_save: tool({
      description: "Commit (and push, when writable) pending changes in a git-backed stash. No-op for non-git stashes.",
      args: {
        name: tool.schema.string().optional().describe("Optional stash source name. Defaults to the primary stash."),
        message: tool.schema.string().optional().describe("Commit message. Defaults to an auto-generated summary."),
      },
      async execute({ name, message }) {
        const args = ["save"]
        if (name) args.push(name)
        if (message) args.push("-m", message)
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_save" })
      },
    }),
    akm_import: tool({
      description: "Import a file (or stdin) into the stash as a typed asset. Pass '-' as source to read from a string via content.",
      args: {
        source: tool.schema.string().describe("Path to the source file, or '-' to read from stdin (use 'content' to provide it)."),
        name: tool.schema.string().optional().describe("Optional asset name override."),
        force: tool.schema.boolean().optional().describe("Overwrite an existing asset with the same name."),
        content: tool.schema.string().optional().describe("Raw content to feed on stdin when source is '-'."),
      },
      async execute({ source, name, force, content }) {
        const args = ["import", source]
        if (name) args.push("--name", name)
        if (force) args.push("--force")
        const command = resolveAkmCommand()
        if (typeof command !== "string") return JSON.stringify(command)
        if (source === "-" && content) {
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
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_import" })
      },
    }),
    akm_vault: tool({
      description: "Manage encrypted-at-rest vaults of KEY=VALUE pairs. Values never surface in any output channel — 'show'/'list' return key names only, 'set'/'unset' never echo the value. Use 'shell_snippet' to get a shell-eval snippet that loads values into the process.",
      args: {
        action: tool.schema.enum(["list", "show", "create", "set", "unset", "shell_snippet"]).describe("Vault subcommand. 'shell_snippet' wraps 'vault load' — treat its output as opaque shell text meant for eval."),
        ref: tool.schema.string().optional().describe("Vault ref such as vault:prod or vault:team/prod. Required for show/set/unset/shell_snippet; optional for list."),
        name: tool.schema.string().optional().describe("Vault name when action is 'create' (e.g. 'prod' → vaults/prod.env)."),
        key: tool.schema.string().optional().describe("Variable name for set/unset. May include '=' to pass KEY=VALUE in one field when value is omitted."),
        value: tool.schema.string().optional().describe("Value to store. Never echoed back."),
        comment: tool.schema.string().optional().describe("Optional inline '# comment' written above the key for 'set'."),
      },
      async execute({ action, ref, name, key, value, comment }) {
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
          case "shell_snippet": {
            if (!ref) return JSON.stringify({ ok: false, error: "'ref' is required for action='shell_snippet'." })
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
        writable: tool.schema.boolean().optional().describe("When registering a git-backed source, mark it as push-writable (used by akm_save)."),
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
    akm_upgrade: tool({
      description: "Check for or install akm CLI updates.",
      args: {
        check: tool.schema.boolean().optional().describe("Only check for updates without installing."),
        force: tool.schema.boolean().optional().describe("Force upgrade even if already on latest version."),
      },
      async execute({ check, force }) {
        const args = ["upgrade"]
        if (check) args.push("--check")
        if (force) args.push("--force")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_upgrade" })
      },
    }),
    },
  }
}

export const server = AkmPlugin
export default { server }
