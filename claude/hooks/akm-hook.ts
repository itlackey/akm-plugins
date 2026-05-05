#!/usr/bin/env bun

import { accessSync, appendFileSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

const COMMAND = process.argv[2] ?? ""
const MODE = process.argv[3] ?? ""
const PACKAGE_REF = process.env.AKM_PACKAGE_REF ?? "akm-cli@latest"
const STATE_DIR = process.env.AKM_PLUGIN_STATE_DIR ?? path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? ".", ".local", "state"), "akm-claude")
const SESSIONS_DIR = path.join(STATE_DIR, "sessions")
const SESSION_LOG = path.join(STATE_DIR, "session.log")
const FEEDBACK_LOG = path.join(STATE_DIR, "feedback.log")
const MEMORY_LOG = path.join(STATE_DIR, "memory.log")
const QUALITY_CACHE = path.join(STATE_DIR, "quality-cache.tsv")
const SETUP_STAMP = path.join(STATE_DIR, "setup.stamp")
const CURATE_LIMIT = Number(process.env.AKM_CURATE_LIMIT ?? "5") || 5
const CURATE_MIN_CHARS = Number(process.env.AKM_CURATE_MIN_CHARS ?? "16") || 16
const CURATE_TIMEOUT = String(Number(process.env.AKM_CURATE_TIMEOUT ?? "8") || 8)
const CONTEXT_BUDGET_CHARS = Number(process.env.AKM_CONTEXT_BUDGET_CHARS ?? "4000") || 4000
const AUTO_FEEDBACK = (process.env.AKM_AUTO_FEEDBACK ?? "1") === "1"
const AUTO_MEMORY = (process.env.AKM_AUTO_MEMORY ?? "1") === "1"
const AUTO_SETUP = process.env.AKM_AUTO_SETUP ?? "1"
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
    appendFileSync(filePath, `${timestamp()}${fields.map((field) => `\t${field}`).join("")}\n`)
  } catch {
    // Logging must never throw.
  }
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

function extractPostToolFields(raw: string, mode: string): { toolName: string; commandText: string; statusText: string; refs: string[]; sid: string } {
  const parsed = safeJsonParse<Record<string, unknown>>(raw)
  if (!parsed) return { toolName: "", commandText: sanitize(raw), statusText: mode || "success", refs: [], sid: "" }
  const toolName = typeof parsed.tool === "string"
    ? parsed.tool
    : typeof parsed.tool_name === "string"
      ? parsed.tool_name
      : typeof parsed.toolName === "string"
        ? parsed.toolName
        : ""
  const commandText = sanitize(getText(parsed.input) || getText(parsed.tool_input) || getText(parsed.command) || "")
  const outputText = sanitize(getText(parsed.output) || getText(parsed.tool_output) || getText(parsed.response) || "")
  const refs = [...new Set(`${commandText}\n${outputText}`.match(REF_PATTERN) ?? [])]
  if (refs.length === 0 && commandText.includes("akm remember")) {
    const match = commandText.match(/--name\s+([A-Za-z0-9._/-]+)/)
    if (match) refs.push(`memory:${match[1]}`)
  }
  const sid = typeof parsed.session_id === "string"
    ? parsed.session_id.replace(/[^A-Za-z0-9._-]/g, "")
    : typeof parsed.sessionId === "string"
      ? parsed.sessionId.replace(/[^A-Za-z0-9._-]/g, "")
      : ""
  return { toolName, commandText, statusText: mode || "success", refs, sid }
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
  if (AUTO_SETUP !== "1" && AUTO_SETUP !== "force") return ""
  if (existsSync(SETUP_STAMP) && AUTO_SETUP !== "force") return ""
  const setup = akmRun(["--format", "json", "-q", "setup"])
  if (setup.trim()) {
    writeFileSync(SETUP_STAMP, timestamp())
    appendLog(SESSION_LOG, "akm_setup", "auto")
  } else {
    appendLog(SESSION_LOG, "akm_setup_failed", "auto", "empty stdout from akm setup")
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
    if (sid) appendFileSync(path.join(SESSIONS_DIR, `${sid}.md`), `## ${timestamp()} - user memory intent\n${text}\n\n`)
  }
}

function recordPostTool() {
  const rawInput = readStdin()
  const { toolName, commandText, statusText, refs, sid } = extractPostToolFields(rawInput, MODE)
  if (/akm|\/akm/.test(commandText)) appendLog(FEEDBACK_LOG, "system", statusText, toolName || "Bash", commandText)
  for (const ref of refs) {
    appendLog(MEMORY_LOG, "system", toolName || "Bash", ref, commandText)
    if (sid) appendFileSync(path.join(SESSIONS_DIR, `${sid}.md`), `## ${timestamp()} - ${toolName || "Bash"} ${statusText}\n- ref: ${ref}\n- command: ${commandText}\n\n`)
  }
}

function autoFeedback() {
  if (!AUTO_FEEDBACK || !akmAvailable()) return
  const rawInput = readStdin()
  const { commandText, statusText, refs, sid } = extractPostToolFields(rawInput, MODE)
  if (!/akm|\/akm/.test(commandText)) return
  if (/akm\s+feedback|\/akm\s+feedback/.test(commandText)) return
  if (refs.length === 0) return
  const sentimentFlag = statusText === "failure" ? "--negative" : "--positive"
  const note = statusText === "failure" ? "claude-code auto: tool failed" : "claude-code auto: tool succeeded"
  const scopeArgs = buildRunScopeArgs(sid)
  for (const ref of refs) {
    if (/^(?:.*\/\/)?(?:memory|vault|lesson):/.test(ref)) continue
    if (refQuality(ref) === "proposed") {
      appendLog(FEEDBACK_LOG, "system", "skip_proposed", ref, statusText)
      continue
    }
    const result = akmRun(["--format", "json", "-q", "feedback", ref, sentimentFlag, "--note", note, ...scopeArgs])
    if (!result.trim()) appendLog(FEEDBACK_LOG, "system", "feedback_failed", ref, statusText, "empty stdout from akm feedback")
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
      if (sid) appendFileSync(path.join(SESSIONS_DIR, `${sid}.md`), `## ${timestamp()} - user memory intent\n${text}\n\n`)
    }
  }
  if (!text || text.length < CURATE_MIN_CHARS || !akmAvailable()) return ""
  const curated = akmRun(["--detail", "agent", "--format", "text", "-q", "curate", text, "--limit", String(CURATE_LIMIT), ...buildRunScopeArgs(sid)])
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
  if (!existsSync(bufferPath)) return
  const buffer = readFileSync(bufferPath, "utf8")
  const entries = (buffer.match(/^## /gm) ?? []).length
  if (entries < 2) {
    rmSync(bufferPath, { force: true })
    return
  }
  const dateTag = timestamp().slice(0, 10).replace(/-/g, "")
  const shortSid = sid.slice(0, 8)
  const name = `claude-session-${dateTag}-${shortSid}`
  const body = `# Session summary (${timestamp()})\nReason: ${reason}\nSession: ${sid}\n\n${buffer}`
  const result = akmRun(["--format", "json", "-q", "remember", "--name", name, "--force", ...buildRunScopeArgs(sid)], body)
  if (result.trim()) {
    appendLog(MEMORY_LOG, "system", "captured", `memory:${name}`, reason)
    runIndexOnSessionEnd(reason, sid, `memory:${name}`)
  } else {
    appendLog(MEMORY_LOG, "system", "capture_failed", `memory:${name}`, reason, "empty stdout from akm remember")
  }
  rmSync(bufferPath, { force: true })
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
