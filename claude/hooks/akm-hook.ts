#!/usr/bin/env bun

import { accessSync, appendFileSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { classifyFeedbackSignal, shouldSubmitAutomaticFeedback } from "../shared/feedback-signals"
import { appendCandidates, extractCandidatesFromText, getCandidateLogPath } from "../shared/memory-candidates"
import { appendMemoryEvent, getEventLogPath } from "../shared/memory-events"
import { shouldRecall } from "../shared/recall-policy"
import { redactObject, redactSecrets } from "../shared/redaction"
import { extractAllRefs, validateRefCandidates } from "../shared/ref-extraction"

const COMMAND = process.argv[2] ?? ""
const MODE = process.argv[3] ?? ""

// ── Agent model alias resolution ─────────────────────────────────────────────
const CC_VALID_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "inherit"])
const MODEL_ALIAS_MAP: Record<string, string> = {
  balanced: "sonnet",
  fast: "haiku",
  capable: "opus",
  smart: "opus",
  cheap: "haiku",
  "gpt-4o": "sonnet",
  "gpt-4o-mini": "haiku",
  "gpt-4": "sonnet",
  "gpt-5": "opus",
  "gpt-5.4": "opus",
}

function resolveModel(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (CC_VALID_MODEL_ALIASES.has(raw)) return raw
  const mapped = MODEL_ALIAS_MAP[raw.toLowerCase()]
  if (mapped) return mapped
  return "sonnet" // unknown alias → safe fallback
}

const PACKAGE_REF = process.env.AKM_PACKAGE_REF ?? "akm-cli@latest"
const STATE_DIR = process.env.AKM_PLUGIN_STATE_DIR ?? path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? ".", ".local", "state"), "akm-claude")
const SESSIONS_DIR = path.join(STATE_DIR, "sessions")
const SESSION_LOG = path.join(STATE_DIR, "session.log")
const FEEDBACK_LOG = path.join(STATE_DIR, "feedback.log")
const MEMORY_LOG = path.join(STATE_DIR, "memory.log")
const EVENT_LOG = getEventLogPath("claude-code")
const CANDIDATE_LOG = getCandidateLogPath("claude-code")
const QUALITY_CACHE = path.join(STATE_DIR, "quality-cache.tsv")
const CURATE_LIMIT = Number(process.env.AKM_CURATE_LIMIT ?? "5") || 5
const CURATE_MIN_CHARS = Number(process.env.AKM_CURATE_MIN_CHARS ?? "16") || 16
const CURATE_TIMEOUT = String(Number(process.env.AKM_CURATE_TIMEOUT ?? "8") || 8)
const CONTEXT_BUDGET_CHARS = Number(process.env.AKM_CONTEXT_BUDGET_CHARS ?? "4000") || 4000
const AUTO_FEEDBACK = (process.env.AKM_AUTO_FEEDBACK ?? "1") === "1"
const AUTO_MEMORY = (process.env.AKM_AUTO_MEMORY ?? "1") === "1"
const INDEX_ON_SESSION_END = (process.env.AKM_INDEX_ON_SESSION_END ?? "0") === "1"
const SCOPE_KEYS = (process.env.AKM_SCOPE_KEYS ?? "user,agent,run,channel").split(",").map((part) => part.trim()).filter(Boolean)
const CURATED_PROMPT_HEADER = "# AKM stash - assets relevant to this prompt"
const CURATED_SESSION_HEADER = "# AKM stash - assets relevant to this session"
const CURATED_CONTEXT_TAIL = "Tip: call `akm show <ref>` to fetch full content, and record `akm feedback <ref> --positive|--negative` once you know whether the asset helped."
const SESSION_START_FOOTER = "For verbs not covered by a slash command (save, import, clone, update, remove, list-sources, registry-search, reindex, config, upgrade, run-script, vault writes, agent, setup, ...), run `/akm-help` first to discover the right `akm` CLI invocation, then run it via Bash. v0.7.0 adds the `/akm-proposal`, `/akm-reflect`, `/akm-propose`, `/akm-distill`, `/akm-review-proposals`, and `/akm-setup` slash commands for the proposal queue and agent-CLI integration."
const SESSION_START_HEADER = [
  "# AKM is available in this session",
  "",
  'You have an AKM stash on this machine. Before writing anything from scratch, call `akm curate "<task>"` or `akm search` to see if the stash already covers it. Record `akm feedback <ref> --positive|--negative` whenever an asset materially helps or misses, and use `akm remember` to persist durable learnings so future sessions inherit them.',
].join("\n")
const REF_PATTERN = /(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|lesson|script|workflow|vault|wiki):[A-Za-z0-9._/-]+/g

mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(SESSIONS_DIR, { recursive: true })

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}

function sanitize(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").replace(/ {2,}/g, " ").trim()
}

function appendLog(filePath: string, ...fields: string[]) {
  try {
    const redacted = fields.map((field) => redactSecrets(field).text)
    appendFileSync(filePath, `${timestamp()}${redacted.map((field) => `\t${field}`).join("")}\n`)
  } catch {
    // Logging must never throw.
  }
}

function buildScope(sessionID: string) {
  return {
    user: SCOPE_KEYS.includes("user") ? process.env.AKM_USER_ID : undefined,
    agent: SCOPE_KEYS.includes("agent") ? process.env.AKM_AGENT_ID : undefined,
    run: SCOPE_KEYS.includes("run") ? sessionID || undefined : undefined,
    channel: SCOPE_KEYS.includes("channel") ? process.env.AKM_CHANNEL : undefined,
    project: process.env.AKM_PROJECT,
    repo: process.env.AKM_REPO,
    branch: process.env.AKM_BRANCH,
  }
}

function writeMemoryEvent(event: Omit<import("../shared/memory-events").AkmMemoryEvent, "version" | "timestamp" | "harness">) {
  const result = appendMemoryEvent(EVENT_LOG, {
    version: 1,
    timestamp: timestamp(),
    harness: "claude-code",
    ...event,
  })
  if (!result.ok) appendLog(SESSION_LOG, "event_write_failed", event.event, result.error)
}

function writeSessionBuffer(sid: string, sectionTitle: string, body: string) {
  if (!sid) return
  const redacted = redactSecrets(body).text
  appendFileSync(path.join(SESSIONS_DIR, `${sid}.md`), `## ${timestamp()} - ${sectionTitle}\n${redacted}\n\n`)
}

/**
 * Append ref candidates to a per-session sidecar file. The sidecar is
 * consumed by captureMemory() at session end: the candidates are validated
 * against the live stash and survivors are written to the durable memory's
 * YAML frontmatter as `refs: [...]`. Candidates that never resolve are
 * silently dropped, so heredoc / grep-pattern / JSON-value literals never
 * appear in the durable memory's ref list (and therefore never trigger
 * `missing-ref` lint flags).
 */
function appendSessionRefCandidates(sid: string, candidates: readonly string[]) {
  if (!sid || candidates.length === 0) return
  const sidecar = path.join(SESSIONS_DIR, `${sid}.refs.jsonl`)
  try {
    const payload = candidates.map((ref) => JSON.stringify({ ref })).join("\n")
    appendFileSync(sidecar, `${payload}\n`)
  } catch {
    // sidecar failure is non-fatal; refs will simply be absent from frontmatter
  }
}

function readSessionRefCandidates(sid: string): string[] {
  if (!sid) return []
  const sidecar = path.join(SESSIONS_DIR, `${sid}.refs.jsonl`)
  if (!existsSync(sidecar)) return []
  try {
    const lines = readFileSync(sidecar, "utf8").split("\n").filter(Boolean)
    const out: string[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { ref?: unknown }
        if (typeof parsed.ref === "string" && parsed.ref) out.push(parsed.ref)
      } catch {
        // skip malformed lines
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Resolve the stash root(s) used for ref validation. Prefers explicit
 * environment override (`AKM_STASH_DIR`) so tests / sandboxed harnesses
 * don't have to spawn `akm`. Falls back to `akm config get stashDir`, then
 * to the conventional `$HOME/akm` location.
 *
 * Returns an array because future work may surface multiple roots; today
 * the array has at most one entry.
 */
/**
 * Build a frontmatter fragment containing the validated `refs:` array.
 * Candidates are validated against the local stash; survivors are sorted
 * and deduplicated. When zero candidates survive, returns the empty
 * string so the frontmatter omits the key entirely (matches how the
 * `tags:` / `keywords:` keys are omitted when empty in
 * `src/commands/remember.ts#buildMemoryFrontmatter`).
 *
 * Returned string starts with a newline (no trailing newline) so it can
 * be concatenated directly into a template like
 * `reason: ${reason}${refsBlock}\n---`.
 */
function buildRefsFrontmatterBlock(candidates: readonly string[]): string {
  const stashRoots = resolveStashRoots()
  if (stashRoots.length === 0 || candidates.length === 0) return ""
  const validated = validateRefCandidates(candidates, stashRoots)
  if (validated.length === 0) return ""
  const lines = validated.map((ref) => `  - ${ref}`).join("\n")
  return `\nrefs:\n${lines}`
}

function resolveStashRoots(): string[] {
  const envOverride = process.env.AKM_STASH_DIR?.trim()
  if (envOverride) return [envOverride]
  if (akmAvailable()) {
    const raw = akmRun(["--format", "json", "-q", "config", "get", "stashDir"]).trim()
    if (raw) {
      const parsed = safeJsonParse<unknown>(raw)
      if (typeof parsed === "string" && parsed) return [parsed]
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>
        const value = record.value ?? record.stashDir
        if (typeof value === "string" && value) return [value]
      }
    }
  }
  const home = process.env.HOME
  if (home) return [path.join(home, "akm")]
  return []
}

function emitBlockDecision(reason: string): string {
  return JSON.stringify({ decision: "block", reason })
}

function logRuntimeError(detail: string) {
  appendLog(SESSION_LOG, "runtime_error", COMMAND || "unknown", detail)
}

function logSubprocessFailure(kind: string, detail: Record<string, string | undefined>) {
  appendLog(
    SESSION_LOG,
    kind,
    COMMAND || "unknown",
    detail.command ?? "",
    detail.args ?? "",
    detail.error ?? "",
    detail.stderr ?? "",
  )
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function findCommandOnPath(command: string): string | undefined {
  const searchPath = process.env.PATH ?? ""
  for (const entry of searchPath.split(":")) {
    if (!entry) continue
    const candidate = path.join(entry, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep searching
    }
  }
  return undefined
}

function firstLine(value: string): string {
  return value.replace(/\r/g, "").split("\n")[0] ?? ""
}

function runCommand(command: string, args: string[], options?: { input?: string; suppressStderr?: boolean }): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      input: options?.input,
      stdio: ["pipe", "pipe", options?.suppressStderr === false ? "pipe" : "ignore"],
    })
    return {
      ok: result.status === 0 && !result.error,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : result.error?.message ?? "",
    }
  } catch (error: unknown) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

function akmAvailable(): boolean {
  return !!findCommandOnPath("akm")
}

function akmRun(args: string[], input?: string): string {
  const akm = findCommandOnPath("akm")
  if (!akm) return ""
  const timeout = findCommandOnPath("timeout")
  const result = timeout
    ? runCommand(timeout, ["--preserve-status", CURATE_TIMEOUT, akm, ...args], { input, suppressStderr: false })
    : runCommand(akm, args, { input, suppressStderr: false })
  if (!result.ok) {
    logSubprocessFailure("akm_failed", {
      command: timeout ?? akm,
      args: (timeout ? ["--preserve-status", CURATE_TIMEOUT, akm, ...args] : args).join(" "),
      error: "akm invocation failed",
      stderr: sanitize(result.stderr),
    })
  }
  return result.stdout
}

function akmRunChecked(args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const akm = findCommandOnPath("akm")
  if (!akm) return { ok: false, stdout: "", stderr: "akm not found on PATH" }
  const timeout = findCommandOnPath("timeout")
  const result = timeout
    ? runCommand(timeout, ["--preserve-status", CURATE_TIMEOUT, akm, ...args], { input, suppressStderr: false })
    : runCommand(akm, args, { input, suppressStderr: false })
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr }
}

function buildRunScopeArgs(sessionID: string): string[] {
  const args: string[] = []
  if (SCOPE_KEYS.includes("run") && sessionID) args.push("--run", sessionID)
  if (SCOPE_KEYS.includes("user") && process.env.AKM_USER_ID) args.push("--user", process.env.AKM_USER_ID)
  if (SCOPE_KEYS.includes("agent") && process.env.AKM_AGENT_ID) args.push("--agent", process.env.AKM_AGENT_ID)
  if (SCOPE_KEYS.includes("channel") && process.env.AKM_CHANNEL) args.push("--channel", process.env.AKM_CHANNEL)
  return args
}

function emitHookContext(eventName: string, body: string): string {
  if (!body.trim()) return ""
  const marker = "\n\n[truncated for context]"
  let additionalContext = body
  if (additionalContext.length > CONTEXT_BUDGET_CHARS) {
    additionalContext = CONTEXT_BUDGET_CHARS <= marker.length
      ? additionalContext.slice(0, CONTEXT_BUDGET_CHARS)
      : `${additionalContext.slice(0, CONTEXT_BUDGET_CHARS - marker.length)}${marker}`
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  })
}

function safeJsonParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function extractSessionId(raw: string): string {
  const parsed = safeJsonParse<Record<string, unknown>>(raw)
  const sid = parsed?.session_id ?? parsed?.sessionId ?? parsed?.session
  return typeof sid === "string" ? sid.replace(/[^A-Za-z0-9._-]/g, "") : ""
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join(" ")
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["text", "prompt", "message", "input", "content", "value"]) {
      const result = flattenText(record[key])
      if (result) return result
    }
  }
  return ""
}

function getText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(getText).filter(Boolean).join(" ")
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["command", "output", "stderr", "stdout", "text", "value", "prompt", "message", "input", "content"]) {
      const result = getText(record[key])
      if (result) return result
    }
  }
  return ""
}

function extractUserText(raw: string): string {
  const parsed = safeJsonParse<Record<string, unknown>>(raw)
  if (!parsed) return sanitize(raw)
  for (const candidate of [parsed.prompt, parsed.message, parsed.input, parsed.userPrompt, parsed.text, parsed]) {
    const result = flattenText(candidate)
    if (result) return sanitize(result)
  }
  return ""
}

function extractPostToolFields(raw: string, mode: string): { toolName: string; commandText: string; outputText: string; statusText: string; refs: string[]; commandRefs: string[]; outputRefs: string[]; sid: string } {
  const parsed = safeJsonParse<Record<string, unknown>>(raw)
  if (!parsed) return { toolName: "", commandText: sanitize(raw), outputText: "", statusText: mode || "success", refs: [], commandRefs: [], outputRefs: [], sid: "" }
  const toolName = typeof parsed.tool === "string"
    ? parsed.tool
    : typeof parsed.tool_name === "string"
      ? parsed.tool_name
      : typeof parsed.toolName === "string"
        ? parsed.toolName
        : ""
  // Capture the *raw* (pre-sanitize) command/output text so we can collect
  // ref candidates from any sub-string position (heredocs, fenced code,
  // JSON values, prose). Candidates are intentionally permissive — the
  // validation step in captureMemory() drops anything that doesn't resolve
  // to a real asset in the local stash, so string-literal false positives
  // never make it into the durable memory frontmatter.
  // (sanitize() is still used for log-line readability.)
  const rawCommandText = getText(parsed.input) || getText(parsed.tool_input) || getText(parsed.command) || ""
  const rawOutputText = getText(parsed.output) || getText(parsed.tool_output) || getText(parsed.response) || ""
  const commandText = sanitize(rawCommandText)
  const outputText = sanitize(rawOutputText)
  const commandRefs = extractAllRefs(rawCommandText)
  const outputRefs = extractAllRefs(rawOutputText)
  const refs = [...new Set([...commandRefs, ...outputRefs])]
  if (refs.length === 0 && commandText.includes("akm remember")) {
    const match = commandText.match(/--name\s+([A-Za-z0-9._/-]+)/)
    if (match) refs.push(`memory:${match[1]}`)
  }
  const sid = typeof parsed.session_id === "string"
    ? parsed.session_id.replace(/[^A-Za-z0-9._-]/g, "")
    : typeof parsed.sessionId === "string"
      ? parsed.sessionId.replace(/[^A-Za-z0-9._-]/g, "")
      : ""
  return { toolName, commandText, outputText, statusText: mode || "success", refs, commandRefs, outputRefs, sid }
}

function assessRiskyClaudeCommand(command: string): string | undefined {
  const normalized = command.trim()
  if (!normalized) return undefined
  if (/^\s*akm\s+proposal\s+(accept|reject)\b/.test(normalized)) return "Proposal acceptance/rejection requires explicit user approval."
  if (/\bakm\s+save\b[\s\S]*--push\b/.test(normalized)) return "`akm save --push` requires explicit user approval."
  if (/\bakm\s+remove\b/.test(normalized)) return "`akm remove` is destructive and requires explicit user approval."
  if (/\bakm\s+update\b[\s\S]*--all\b/.test(normalized)) return "`akm update --all` requires explicit user approval."
  if (/\bakm\s+upgrade\b(?:[\s\S]*--force\b|\b)/.test(normalized)) return "`akm upgrade` requires explicit user approval."
  if (/\bakm\s+vault\s+(create|set|unset|load)\b/.test(normalized)) {
    if (/^\s*eval\s+["']?\$\(akm\s+vault\s+load\s+/.test(normalized)) return undefined
    return "Vault create/set/unset/load requires explicit approval, and raw `akm vault load` output must not be exposed in logs or chat."
  }
  if (/\bakm\s+config\s+set\s+(?:llm\.features\.|registries|searchPaths|stashDir)/.test(normalized)) return "AKM config mutations require explicit user approval."
  if (/\bakm\s+(?:add|wiki\s+register)\b[\s\S]*--trust\b/.test(normalized)) return "Trusted source registration requires explicit user approval."
  if (/\bakm\s+remember\b/.test(normalized) && redactSecrets(normalized).redacted) return "Raw `akm remember` payload appears to include secrets; redact it before writing memory."
  return undefined
}

function preToolBash(): string {
  const rawInput = readStdin()
  const { commandText, sid } = extractPostToolFields(rawInput, "pre")
  const blocked = assessRiskyClaudeCommand(commandText)
  if (!blocked) return ""
  appendLog(SESSION_LOG, "pretool_blocked", commandText, blocked)
  writeMemoryEvent({
    event: "safety_blocked",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { tool: "Bash", commandPreview: commandText.slice(0, 280) },
    outcome: { status: "blocked", warnings: [blocked] },
  })
  return emitBlockDecision(blocked)
}

function userPromptExpansion(): string {
  const rawInput = readStdin()
  const parsed = safeJsonParse<Record<string, unknown>>(rawInput) ?? {}
  const sid = extractSessionId(rawInput)
  const text = extractUserText(rawInput)
  const expanded = typeof parsed.command === "string" ? parsed.command : text
  if (!expanded) return ""
  const refs = [...new Set(expanded.match(REF_PATTERN) ?? [])]
  writeMemoryEvent({
    event: "tool_observation",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { phase: "UserPromptExpansion", expandedPrompt: expanded.slice(0, 400) },
    refs,
    outcome: { status: "ok" },
  })
  if (/\/akm-(memory-promote|memory-reject|proposal)\b/.test(expanded) && !/\b(confirm|approved|approval)\b/i.test(expanded)) {
    return emitHookContext("UserPromptExpansion", "AKM note: mutating memory/proposal flows should be explicit. Confirm promotion/rejection or proposal acceptance before changing durable state.")
  }
  if (/\/akm-/.test(expanded)) {
    return emitHookContext("UserPromptExpansion", "AKM note: slash-command expansion should keep mutating actions explicit and prefer review before durable writes.")
  }
  return ""
}

function postToolBatch(): string {
  const rawInput = readStdin()
  const sid = extractSessionId(rawInput)
  const parsed = safeJsonParse<Record<string, unknown>>(rawInput) ?? {}
  const tools = Array.isArray(parsed.tools) ? parsed.tools : Array.isArray(parsed.batch) ? parsed.batch : []
  const flattened = sanitize(getText(tools))
  const refs = [...new Set(flattened.match(REF_PATTERN) ?? [])]
  writeMemoryEvent({
    event: "tool_batch_observation",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { tools, summary: flattened.slice(0, 500) },
    refs,
    outcome: { status: "ok" },
  })
  if (sid && flattened) writeSessionBuffer(sid, "tool batch", `- summary: ${flattened}`)
  return ""
}

function subagentStart(): string {
  const rawInput = readStdin()
  const sid = extractSessionId(rawInput)
  const parsed = safeJsonParse<Record<string, unknown>>(rawInput) ?? {}
  const role = typeof parsed.agent === "string" ? parsed.agent : typeof parsed.role === "string" ? parsed.role : "subagent"
  const task = sanitize(flattenText(parsed.task) || flattenText(parsed.prompt) || "")
  const activeWorkflow = akmAvailable()
    ? akmRun(["--format", "json", "-q", "workflow", "list", "--active"]).trim()
    : ""
  const workflowSummary = activeWorkflow && activeWorkflow !== "[]" ? `# Active workflow\n${activeWorkflow}` : ""
  writeMemoryEvent({
    event: "subagent_started",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { role, taskPreview: task.slice(0, 280) },
    outcome: { status: "ok" },
  })
  const contextParts = [
    `# AKM subagent context\nRole: ${role}`,
    task ? `Task: ${task}` : "",
    workflowSummary,
  ].filter(Boolean)
  return contextParts.length > 0 ? emitHookContext("SubagentStart", contextParts.join("\n\n")) : ""
}

function taskCreated(): string {
  const rawInput = readStdin()
  const sid = extractSessionId(rawInput)
  const parsed = safeJsonParse<Record<string, unknown>>(rawInput) ?? {}
  const title = sanitize(flattenText(parsed.title) || flattenText(parsed.subject) || flattenText(parsed.task) || "")
  writeMemoryEvent({
    event: "task_created",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { taskId: parsed.task_id ?? parsed.taskId ?? null, title },
    outcome: { status: "ok" },
  })
  if (sid && title) writeSessionBuffer(sid, "task created", `- title: ${title}`)
  return ""
}

function taskCompleted(): string {
  const rawInput = readStdin()
  const sid = extractSessionId(rawInput)
  const parsed = safeJsonParse<Record<string, unknown>>(rawInput) ?? {}
  const summary = sanitize(flattenText(parsed.summary) || flattenText(parsed.result) || flattenText(parsed.task) || "")
  writeMemoryEvent({
    event: "task_completed",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { taskId: parsed.task_id ?? parsed.taskId ?? null, summary },
    outcome: { status: "ok" },
  })
  if (sid && summary) {
    writeSessionBuffer(sid, "task completed", summary)
    const candidates = extractCandidatesFromText({
      harness: "claude-code",
      sessionId: sid,
      text: summary,
      evidence: [summary],
    })
    if (candidates.length > 0) {
      appendCandidates(CANDIDATE_LOG, candidates)
      writeMemoryEvent({
        event: "candidate_extracted",
        sessionId: sid || undefined,
        scope: buildScope(sid),
        memory: { source: "task_completed", count: candidates.length },
        outcome: { status: "ok" },
      })
    }
  }
  return ""
}

function postCompact(): string {
  const rawInput = readStdin()
  const sid = extractSessionId(rawInput)
  const parsed = safeJsonParse<Record<string, unknown>>(rawInput) ?? {}
  const summary = sanitize(flattenText(parsed.summary) || flattenText(parsed.compact_summary) || "")
  writeMemoryEvent({
    event: "post_compact_summary",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { summary },
    outcome: { status: summary ? "ok" : "skipped" },
  })
  if (sid && summary) writeSessionBuffer(sid, "post compact", summary)
  return ""
}

function sessionEnd(): string {
  captureMemory()
  return ""
}

function findWritablePathDir(): string | undefined {
  for (const entry of (process.env.PATH ?? "").split(":")) {
    if (!entry) continue
    try {
      mkdirSync(entry, { recursive: true })
      writeFileSync(path.join(entry, ".akm-write-test"), "")
      rmSync(path.join(entry, ".akm-write-test"), { force: true })
      return entry
    } catch {
      // continue
    }
  }
  return undefined
}

function ensureOnPath(target: string) {
  if (!existsSync(target)) return
  const current = findCommandOnPath("akm")
  if (current === target) return
  const writableDir = findWritablePathDir()
  if (!writableDir) return
  const linkPath = path.join(writableDir, "akm")
  try {
    symlinkSync(target, linkPath)
  } catch {
    try {
      copyFileSync(target, linkPath)
    } catch {
      // ignore
    }
  }
}

function npmGlobalBin(): string {
  const bin = runCommand("npm", ["bin", "-g"])
  if (bin.ok && bin.stdout.trim()) return bin.stdout.trim()
  const prefix = runCommand("npm", ["prefix", "-g"])
  return prefix.ok && prefix.stdout.trim() ? path.join(prefix.stdout.trim(), "bin") : ""
}

function ensureAkm() {
  const existing = findCommandOnPath("akm")
  if (existing) {
    const version = firstLine(runCommand(existing, ["--version"]).stdout) || "unknown"
    appendLog(SESSION_LOG, "akm_ready", "path", existing, version)
    return
  }

  let installer = "path"
  let installedBin = ""
  if (findCommandOnPath("bun")) {
    installer = "bun"
    const globalBin = runCommand("bun", ["pm", "bin", "-g"])
    const install = runCommand("bun", ["install", "-g", PACKAGE_REF])
    if (install.ok && globalBin.ok && globalBin.stdout.trim()) installedBin = path.join(globalBin.stdout.trim(), "akm")
  }
  if (!installedBin && findCommandOnPath("npm")) {
    installer = "npm"
    const install = runCommand("npm", ["install", "-g", PACKAGE_REF])
    const globalBin = npmGlobalBin()
    if (install.ok && globalBin) installedBin = path.join(globalBin, "akm")
  }
  if (installedBin) ensureOnPath(installedBin)
  const resolved = findCommandOnPath("akm")
  if (resolved) {
    const version = firstLine(runCommand(resolved, ["--version"]).stdout) || "unknown"
    appendLog(SESSION_LOG, "akm_ready", installer, resolved, version)
  } else {
    appendLog(SESSION_LOG, "akm_missing", installer, PACKAGE_REF)
  }
}

function refQuality(ref: string): string {
  if (!ref) return "unknown"
  if (existsSync(QUALITY_CACHE)) {
    const lines = readFileSync(QUALITY_CACHE, "utf8").split("\n").filter(Boolean).reverse()
    for (const line of lines) {
      const [, cachedRef, quality] = line.split("\t")
      if (cachedRef === ref && quality) return quality
    }
  }
  const raw = akmRun(["--format", "json", "-q", "show", ref])
  const quality = safeJsonParse<Record<string, unknown>>(raw)?.quality
  const resolved = typeof quality === "string" && quality ? quality : "unknown"
  appendLog(QUALITY_CACHE, ref, resolved)
  return resolved
}

function detectAgentDefault(): string {
  if (!akmAvailable()) return ""
  const readCurrent = () => {
    const raw = akmRun(["--format", "json", "-q", "config", "get", "agent.default"])
    const parsed = safeJsonParse<unknown>(raw)
    if (typeof parsed === "string") return parsed
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>
      const value = record.value ?? record["agent.default"]
      return typeof value === "string" ? value : ""
    }
    return ""
  }
  const current = readCurrent()
  if (current) return current
  const setResult = akmRun(["--format", "json", "-q", "config", "set", "agent.default", "claude"])
  if (setResult.trim()) {
    appendLog(SESSION_LOG, "agent_default_initialized", "claude")
  } else {
    appendLog(SESSION_LOG, "agent_default_init_failed", "claude", "empty stdout from akm config set agent.default")
  }
  return readCurrent()
}

function runIndexOnSessionEnd(reason: string, sid: string, ref: string) {
  if (!INDEX_ON_SESSION_END || !akmAvailable()) return
  const result = akmRunChecked(["index"])
  if (!result.ok) appendLog(SESSION_LOG, "akm_index_failed", reason, sid, ref, sanitize(result.stderr))
}

function recordUserFeedback() {
  const rawInput = readStdin()
  const text = extractUserText(rawInput)
  const sid = extractSessionId(rawInput)
  if (!text) return
  appendLog(FEEDBACK_LOG, "user", "prompt", text)
  if (/\b(remember|memory|memories)\b/i.test(text)) {
    appendLog(MEMORY_LOG, "user", "intent", text)
    writeSessionBuffer(sid, "user memory intent", text)
  }
}

function recordPostTool() {
  const rawInput = readStdin()
  const { toolName, commandText, outputText, statusText, refs, sid } = extractPostToolFields(rawInput, MODE)
  if (/akm|\/akm/.test(commandText)) appendLog(FEEDBACK_LOG, "system", statusText, toolName || "Bash", commandText)
  for (const ref of refs) {
    appendLog(MEMORY_LOG, "system", toolName || "Bash", ref, commandText)
  }
  // Record one buffer section per post-tool event (command + status) and
  // accumulate ref candidates in a sidecar file. We deliberately do NOT
  // inject `- ref: <type>:<slug>` lines into the body — those lines were
  // the producer-side source of `missing-ref` lint flags whenever a
  // candidate turned out to be a heredoc/grep literal rather than a real
  // asset. Candidates are validated against the live stash at capture time
  // and written to frontmatter (`refs:` array), which is the authoritative
  // ref list for session-checkpoint memories.
  if (sid && refs.length > 0) {
    writeSessionBuffer(sid, `${toolName || "Bash"} ${statusText}`, `- command: ${commandText}`)
    appendSessionRefCandidates(sid, refs)
  }
  writeMemoryEvent({
    event: "tool_observation",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { tool: toolName || "Bash", command: commandText, outputPreview: outputText.slice(0, 400) },
    refs,
    outcome: { status: statusText === "failure" ? "failed" : "ok" },
  })
}

function autoFeedback() {
  if (!AUTO_FEEDBACK || !akmAvailable()) return
  const rawInput = readStdin()
  const { commandText, statusText, refs, commandRefs, sid } = extractPostToolFields(rawInput, MODE)
  if (!/akm|\/akm/.test(commandText)) return
  if (/akm\s+feedback|\/akm\s+feedback/.test(commandText)) return
  if (refs.length === 0) return
  const scopeArgs = buildRunScopeArgs(sid)
  for (const ref of refs) {
    if (/^(?:.*\/\/)?(?:memory|vault|lesson):/.test(ref)) continue
    if (refQuality(ref) === "proposed") {
      appendLog(FEEDBACK_LOG, "system", "skip_proposed", ref, statusText)
      continue
    }
    const signal = classifyFeedbackSignal({
      ref,
      polarity: statusText === "failure" ? "negative" : "positive",
      harness: "claude-code",
      sessionId: sid || undefined,
      directInput: commandRefs.includes(ref),
      note: `claude-code auto: source=${statusText === "failure" ? "tool_failure" : "tool_success"}; confidence=${(commandRefs.includes(ref) ? 0.65 : 0.25).toFixed(2)}`,
    })
    if (!shouldSubmitAutomaticFeedback(signal)) {
      writeMemoryEvent({
        event: "feedback_recorded",
        sessionId: sid || undefined,
        scope: buildScope(sid),
        refs: [ref],
        input: { source: signal.source, confidence: signal.confidence, note: signal.note },
        outcome: { status: "skipped", warnings: ["confidence below automatic submission threshold"] },
      })
      continue
    }
    const result = akmRun(["--format", "json", "-q", "feedback", ref, signal.polarity === "negative" ? "--negative" : "--positive", "--note", redactSecrets(signal.note).text, ...scopeArgs])
    if (!result.trim()) appendLog(FEEDBACK_LOG, "system", "feedback_failed", ref, statusText, "empty stdout from akm feedback")
    else {
      writeMemoryEvent({
        event: "feedback_recorded",
        sessionId: sid || undefined,
        scope: buildScope(sid),
        refs: [ref],
        input: { source: signal.source, confidence: signal.confidence, note: signal.note },
        outcome: { status: "ok" },
      })
    }
  }
}

function curatePrompt(): string {
  const rawInput = readStdin()
  const text = extractUserText(rawInput)
  const sid = extractSessionId(rawInput)
  if (text) {
    appendLog(FEEDBACK_LOG, "user", "prompt", text)
    if (/\b(remember|memory|memories)\b/i.test(text)) {
      appendLog(MEMORY_LOG, "user", "intent", text)
      writeSessionBuffer(sid, "user memory intent", text)
    }
  }
  if (!text) return ""
  const decision = shouldRecall(text)
  if (!decision.shouldRecall || !akmAvailable()) {
    writeMemoryEvent({
      event: "prompt_recall",
      sessionId: sid || undefined,
      scope: buildScope(sid),
      input: { promptPreview: text.slice(0, 280), query: decision.query, reason: decision.reason },
      outcome: { status: "skipped" },
    })
    return ""
  }
  const curated = akmRun(["--detail", "agent", "--format", "text", "-q", "curate", text, "--limit", String(CURATE_LIMIT), ...buildRunScopeArgs(sid)])
  writeMemoryEvent({
    event: "prompt_recall",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { promptPreview: text.slice(0, 280), query: decision.query, reason: decision.reason },
    refs: [...new Set(curated.match(REF_PATTERN) ?? [])],
    outcome: { status: curated.trim() ? "ok" : "skipped" },
  })
  if (!curated.trim()) return ""
  return emitHookContext("UserPromptSubmit", `${CURATED_PROMPT_HEADER}\n${curated.trim()}\n\n${CURATED_CONTEXT_TAIL}`)
}

function sessionStart(): string {
  const rawInput = readStdin()
  const sid = extractSessionId(rawInput)
  ensureAkm()
  if (!akmAvailable()) return ""

  const akm = findCommandOnPath("akm")
  if (akm) {
    try {
      const child = spawn(akm, ["index"], { detached: true, stdio: "ignore" })
      child.unref()
    } catch {
      // best-effort only
    }
  }

  const agentDefault = detectAgentDefault()
  const hints = akmRun(["--format", "text", "-q", "hints"]).trim()
  const curated = akmRun(["--detail", "agent", "--format", "text", "-q", "curate", "--limit", String(CURATE_LIMIT), ...buildRunScopeArgs(sid)]).trim()
  const pendingRaw = akmRun(["--format", "json", "-q", "proposal", "list", "--status", "pending"])
  const pendingItems = safeJsonParse<Record<string, unknown>>(pendingRaw)
  const pending = Array.isArray(pendingItems?.proposals)
    ? pendingItems?.proposals.length
    : Array.isArray(pendingItems?.hits)
      ? pendingItems?.hits.length
      : 0
  const pendingSummary = pending <= 0
    ? ""
    : pending === 1
      ? "There is 1 pending AKM proposal - review with `/akm-review-proposals` or `/akm-proposal list`."
      : `There are ${pending} pending AKM proposals - review with \`/akm-review-proposals\` or \`/akm-proposal list\`.`

  if (!hints && !curated && !agentDefault && !pendingSummary) return ""
  writeMemoryEvent({
    event: "session_started",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { agentDefault, pendingProposals: pending },
    refs: [...new Set(curated.match(REF_PATTERN) ?? [])],
    outcome: { status: "ok" },
  })
  let body = SESSION_START_HEADER
  if (agentDefault) body = `${body}\n\nAgent CLI: ${agentDefault} (configured via \`akm setup\`).`
  if (pendingSummary) body = `${body}\n\n${pendingSummary}`
  if (hints) body = `${body}\n\n${hints}`
  if (curated) body = `${body}\n\n${CURATED_SESSION_HEADER}\n${curated}\n\n${CURATED_CONTEXT_TAIL}`
  body = `${body}\n\n${SESSION_START_FOOTER}`
  return emitHookContext("SessionStart", body)
}

function captureMemory() {
  const reason = MODE || "session-end"
  if (!AUTO_MEMORY || !akmAvailable()) return
  const rawInput = readStdin()
  const sid = extractSessionId(rawInput)
  if (!sid) return
  const bufferPath = path.join(SESSIONS_DIR, `${sid}.md`)
  const refSidecar = path.join(SESSIONS_DIR, `${sid}.refs.jsonl`)
  if (!existsSync(bufferPath)) {
    rmSync(refSidecar, { force: true })
    return
  }
  const buffer = readFileSync(bufferPath, "utf8")
  const entries = (buffer.match(/^## /gm) ?? []).length
  if (entries < 2) {
    rmSync(bufferPath, { force: true })
    rmSync(refSidecar, { force: true })
    return
  }
  const dateTag = timestamp().slice(0, 10).replace(/-/g, "")
  const shortSid = sid.slice(0, 8)
  const name = `claude-session-${dateTag}-${shortSid}`
  // Validate any ref candidates that accumulated during the session: only
  // candidates that resolve to a real asset in the local stash become
  // entries in the durable memory's frontmatter `refs:` array. Literal
  // strings (heredocs, grep patterns, JSON values) silently drop out, so
  // `akm lint` will not flag them as `missing-ref`. The captured-memory
  // body still contains the raw command/heredoc text — the lint
  // carve-out treats the frontmatter `refs:` array as authoritative for
  // session-checkpoint memories.
  const refCandidates = readSessionRefCandidates(sid)
  const refsBlock = buildRefsFrontmatterBlock(refCandidates)
  const rawBody = `---\nakm_memory_kind: session_checkpoint\nharness: claude-code\nsession_id: ${sid}\nreason: ${reason}${refsBlock}\n---\n\n# Session summary (${timestamp()})\nReason: ${reason}\nSession: ${sid}\n\n${buffer}`
  const redactedBody = redactSecrets(rawBody).text
  const result = akmRun(["--format", "json", "-q", "remember", "--name", name, "--force", ...buildRunScopeArgs(sid)], redactedBody)
  if (result.trim()) {
    appendLog(MEMORY_LOG, "system", "captured", `memory:${name}`, reason)
    writeMemoryEvent({
      event: reason === "pre-compact" ? "pre_compact_checkpoint" : "durable_memory_written",
      sessionId: sid || undefined,
      scope: buildScope(sid),
      memory: { ref: `memory:${name}`, reason, kind: "session_checkpoint" },
      refs: [`memory:${name}`],
      outcome: { status: "ok" },
    })
    const candidates = extractCandidatesFromText({
      harness: "claude-code",
      sessionId: sid,
      text: redactedBody,
      evidence: [`memory:${name}`, reason],
    })
    if (candidates.length > 0) {
      appendCandidates(CANDIDATE_LOG, candidates)
      writeMemoryEvent({
        event: "candidate_extracted",
        sessionId: sid || undefined,
        scope: buildScope(sid),
        memory: { sourceRef: `memory:${name}`, count: candidates.length },
        refs: [`memory:${name}`],
        outcome: { status: "ok" },
      })
    }
    runIndexOnSessionEnd(reason, sid, `memory:${name}`)
    // Auto-signal so improve picks up this session memory on the next run.
    // Without a positive feedback event the signal gate would exclude it (minRetrievalCount=1).
    akmRun(["--format", "json", "-q", "feedback", `memory:${name}`, "--positive", "--note", "session checkpoint: auto-signal for improve eligibility"])
  } else {
    appendLog(MEMORY_LOG, "system", "capture_failed", `memory:${name}`, reason, "empty stdout from akm remember")
    writeMemoryEvent({
      event: reason === "pre-compact" ? "pre_compact_checkpoint" : "session_ended",
      sessionId: sid || undefined,
      scope: buildScope(sid),
      memory: { ref: `memory:${name}`, reason, kind: "session_checkpoint" },
      outcome: { status: "failed", error: "empty stdout from akm remember" },
    })
  }
  rmSync(bufferPath, { force: true })
  rmSync(refSidecar, { force: true })
}

function preToolAgent(): string {
  const rawInput = readStdin()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawInput)
  } catch {
    return "" // malformed — pass through
  }

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>
  const subagentType = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : null
  const rawModel = typeof toolInput.model === "string" ? toolInput.model : null

  // Read model from agent frontmatter if not set on the tool call directly
  let frontmatterModel: string | null = null
  if (subagentType) {
    const agentFilePath = path.join(process.env.HOME ?? ".", ".claude", "agents", `${subagentType}.md`)
    try {
      const content = readFileSync(agentFilePath, "utf8")
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (fmMatch) {
        const modelMatch = fmMatch[1].match(/^model:\s*(.+)$/m)
        if (modelMatch) frontmatterModel = modelMatch[1].trim()
      }
    } catch {
      // agent file not found — no frontmatter model
    }
  }

  const effectiveRaw = rawModel ?? frontmatterModel
  const resolved = resolveModel(effectiveRaw)
  if (!resolved || resolved === effectiveRaw) return ""

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { model: resolved },
    },
  })
}

function main(): string {
  switch (COMMAND) {
    case "ensure-akm":
      ensureAkm()
      return ""
    case "session-start":
      return sessionStart()
    case "user-feedback":
      recordUserFeedback()
      return ""
    case "curate-prompt":
      return curatePrompt()
    case "user-prompt-expansion":
      return userPromptExpansion()
    case "pre-tool":
      if (MODE === "bash") return preToolBash()
      return ""
    case "pre-tool-agent":
      return preToolAgent()
    case "post-tool-batch":
      return postToolBatch()
    case "subagent-start":
      return subagentStart()
    case "task-created":
      return taskCreated()
    case "task-completed":
      return taskCompleted()
    case "post-compact":
      return postCompact()
    case "session-end":
      return sessionEnd()
    case "post-tool":
      recordPostTool()
      return ""
    case "auto-feedback":
      autoFeedback()
      return ""
    case "capture-memory":
      captureMemory()
      return ""
    default:
      appendLog(SESSION_LOG, "runtime_error", "unknown_command", COMMAND)
      return ""
  }
}

try {
  const output = main()
  if (output) process.stdout.write(output)
} catch (error: unknown) {
  logRuntimeError(error instanceof Error ? error.message : String(error))
}
