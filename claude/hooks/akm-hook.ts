#!/usr/bin/env bun

import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { AKM_VERSION_RANGE as AKM_REQUIRED_RANGE } from "../shared/akm-version"
import { satisfies, valid } from "../shared/vendor-semver"
import { classifyFeedbackSignal, shouldSubmitAutomaticFeedback } from "../shared/feedback-signals"
import { appendCandidates, extractCandidatesFromText, getCandidateLogPath, readCandidates } from "../shared/memory-candidates"
import { appendMemoryEvent, getEventLogPath, readJsonl, type AkmMemoryEvent } from "../shared/memory-events"
import { shouldRecall } from "../shared/recall-policy"
import { redactObject, redactSecrets } from "../shared/redaction"
import { extractAkmRefsFromString, extractAllRefs, validateRefCandidates } from "../shared/ref-extraction"

const COMMAND = process.argv[2] ?? ""
const MODE = process.argv[3] ?? ""

// ── Agent model alias resolution ─────────────────────────────────────────────
// The only valid Claude Code subagent model identifiers are the four Anthropic
// aliases below. Everything else (cross-provider aliases like `balanced`,
// `gpt-4o`, or full-ID prefixes like `anthropic/...` and `lab/...`) gets
// remapped via MODEL_ALIAS_MAP or falls back to `sonnet` so the Agent tool
// dispatch is never rejected upstream.
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

// Full Anthropic model IDs (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`,
// `claude-haiku-4-5-20251001`, `claude-3-5-sonnet-20241022`) are valid model
// selectors in Claude Code's Agent tool — the four short aliases are NOT the
// only accepted values. Pass full IDs straight through; only short aliases
// (`balanced`, `gpt-4o`, etc.) need remapping or the safe-fallback floor.
// The family token (opus/sonnet/haiku) can appear after an optional
// version-prefix block such as `3-5-` (claude-3-5-sonnet-20241022).
const FULL_CLAUDE_MODEL_ID_RE = /^claude-(?:[0-9]+(?:[.-][0-9]+)*-)?(?:opus|sonnet|haiku)\b/i

function resolveModel(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (CC_VALID_MODEL_ALIASES.has(raw)) return raw
  if (FULL_CLAUDE_MODEL_ID_RE.test(raw)) return raw
  const mapped = MODEL_ALIAS_MAP[raw.toLowerCase()]
  if (mapped) return mapped
  return "sonnet" // unknown alias → safe fallback
}
// AKM_REQUIRED_RANGE is the single shared version contract imported from
// ../shared/akm-version (also consumed by the OpenCode plugin). AKM_PACKAGE_REF
// is a SEPARATE concern: the install ref. Bun/npm install spec does NOT parse
// `akm-cli@^0.8.0-rc0 || ^0.8.0` as a disjunction — it would splat into argv
// tokens and refuse the install — so the package ref keeps a single clean
// range. The validator above (satisfies) accepts the full disjunction; a user
// can still pin a specific prerelease via AKM_PACKAGE_REF.
const AKM_PACKAGE_REF = process.env.AKM_PACKAGE_REF ?? "akm-cli@^0.8.0"
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
// SessionEnd `akm index` is opt-OUT (default enabled) because the README
// parity matrix advertises "Session-end `akm index` Shipped in both plugins";
// shipping it gated behind an opt-in env var made the claim a lie. Users
// who want to disable it (e.g. CI runners, low-power dev machines) set
// AKM_INDEX_ON_SESSION_END=0.
const INDEX_ON_SESSION_END = (process.env.AKM_INDEX_ON_SESSION_END ?? "1") !== "0"
const SCOPE_KEYS = (process.env.AKM_SCOPE_KEYS ?? "user,agent,run,channel").split(",").map((part) => part.trim()).filter(Boolean)
const CURATED_PROMPT_HEADER = "# AKM stash - assets relevant to this prompt"
const CURATED_SESSION_HEADER = "# AKM stash - assets relevant to this session"
const CURATED_CONTEXT_TAIL = "Tip: call `akm show <ref>` to fetch full content, and record `akm feedback <ref> --positive|--negative` once you know whether the asset helped."
const SESSION_START_FOOTER = "For verbs not covered by a slash command (save, import, clone, update, remove, list-sources, registry-search, reindex, config, upgrade, run-script, env writes, secret writes/run, agent, tasks, setup, ...), run `/akm-help` first to discover the right `akm` CLI invocation, then run it via Bash. v0.8.0 adds the `/akm-proposal`, `/akm-improve`, `/akm-propose`, `/akm-review-proposals`, and `/akm-setup` slash commands for the proposal queue and agent-CLI integration."
const SESSION_START_HEADER = [
  "# AKM is available in this session",
  "",
  'You have an AKM stash on this machine. Before writing anything from scratch, run `akm curate "<task>"` to find relevant assets with LLM-reranked relevance scores.',
  "",
  "**Choosing the right lookup command:**",
  "",
  '- **`akm curate "<task>"`** — use this when starting any new task, looking for patterns, docs, skills, or workflows. This is the PRIMARY lookup command. v0.8.0 automatically boosts assets that match the current project (cwd-anchored project-context ranking), so an explicit project name in the query is no longer required for ranking — but it still helps the reranker frame intent.',
  '  - Good: `akm curate "akm CLI improve command performance analysis"` (explicit framing, still ideal)',
  '  - Bad: `akm curate "improve performance analysis"` (too generic — the reranker has less to work with even with auto-boost)',
  '- **`akm search "<known name>"`** — use ONLY when you already know an asset exists (e.g. after `akm show` returned "not found") and need to locate its exact ref. Do not use as a discovery tool.',
  '- **`akm show <stash>//meta`** — when working in or with an unfamiliar stash, read its optional `.meta/` orientation (purpose, key assets, conventions, maintainer) before diving in. `akm show meta` reads your working stash\'s `.meta/index.md`; `akm show meta:<name>` reads other `.meta/` docs (e.g. `meta:about`). These docs are direct-read and never appear in `akm search`.',
  "",
  'Record `akm feedback <ref> --positive|--negative` whenever an asset materially helps or misses, and use `akm remember` to persist durable learnings so future sessions inherit them.',
].join("\n")
const REF_PATTERN = /(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|lesson|script|workflow|task|env|secret|wiki):[A-Za-z0-9._/-]+/g
const LOCAL_AKM_BUILD_CLI = process.env.AKM_LOCAL_BUILD_CLI?.trim() || ""
const CURATED_DIR = path.join(STATE_DIR, "curated")
const PROPOSAL_FLOW_RE = /\/akm-(improve|evolve|propose)\b/

function formatPathBullet(label: string, filePath: string): string {
  return `- ${label}: ${filePath}`
}

function countByValue(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
}

function uniqueRecent<T>(values: T[], key: (value: T) => string, limit: number): T[] {
  const selected: T[] = []
  const seen = new Set<string>()
  for (let index = values.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const value = values[index]
    const id = key(value)
    if (!id || seen.has(id)) continue
    seen.add(id)
    selected.push(value)
  }
  return selected.reverse()
}

function gatherCwdContext(): string {
  const parts: string[] = []
  const cwd = process.cwd()
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
      if (existsSync(path.join(cwd, indicator.file))) parts.push(indicator.label)
    } catch {}
  }
  try {
    const pkgPath = path.join(cwd, "package.json")
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
      if (pkg.name) parts.push(pkg.name)
      if (pkg.description) parts.push(String(pkg.description).slice(0, 120))
    }
  } catch {}
  try {
    const readme = path.join(cwd, "README.md")
    if (existsSync(readme)) {
      const firstContent = readFileSync(readme, "utf8").split("\n").find((l) => l.trim() && !l.startsWith("#"))
      if (firstContent) parts.push(firstContent.trim().slice(0, 100))
    }
  } catch {}
  return parts.join(", ")
}

mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(CURATED_DIR, { recursive: true })
mkdirSync(SESSIONS_DIR, { recursive: true })
// State directory holds session feedback / memory / candidate logs that may
// retain sensitive context post-redaction. Lock to owner-only.
for (const dir of [STATE_DIR, CURATED_DIR, SESSIONS_DIR]) {
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best-effort: filesystems / platforms without POSIX mode are silently
    // skipped (Windows, FAT, some FUSE mounts). We never crash a hook over
    // a hardening attempt.
  }
}

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
  const redacted = redactSecrets(body).text.replace(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*(?:\[[^\]]+\]|[^\s"'`,;]+)/g, "[REDACTED_ASSIGNMENT:$1]")
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

/**
 * Resolve the stash root(s) used for ref validation. Prefers explicit
 * environment override (`AKM_STASH_DIR`) so tests / sandboxed harnesses
 * don't have to spawn `akm`. Falls back to `akm config get stashDir`, then
 * to the conventional `$HOME/akm` location.
 *
 * Returns an array because future work may surface multiple roots; today
 * the array has at most one entry.
 */
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

type AkmCommandSpec = {
  command: string
  argsPrefix: string[]
  displayPath: string
}

function findCommandOnPath(command: string): string | undefined {
  const isWindows = process.platform === "win32"
  const searchPath = process.env.PATH ?? ""
  const separator = isWindows ? ";" : ":"
  // On Windows PATHEXT controls which extensions are tried; default to the
  // documented stock set. We try the bare name first (some installers drop
  // a side-by-side `akm` shim) and then each extension in turn. On POSIX
  // we only try the bare name with an executable-bit check.
  const extensions = isWindows
    ? [
        "",
        ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ]
    : [""]
  for (const entry of searchPath.split(separator)) {
    if (!entry) continue
    for (const ext of extensions) {
      const candidate = path.join(entry, command + ext)
      try {
        if (isWindows) {
          // X_OK is unreliable on Windows; existence + PATHEXT match is
          // the documented resolution rule (see CreateProcess on MSDN).
          accessSync(candidate, constants.F_OK)
        } else {
          accessSync(candidate, constants.X_OK)
        }
        return candidate
      } catch {
        // keep searching
      }
    }
  }
  return undefined
}

function firstLine(value: string): string {
  return value.replace(/\r/g, "").split("\n")[0] ?? ""
}

function parseAkmVersion(value: string): string {
  const line = firstLine(value).trim()
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/.exec(line)
  return match?.[1] ?? ""
}

function resolveAkmCommandSpec(): AkmCommandSpec | null {
  if (LOCAL_AKM_BUILD_CLI) {
    return {
      command: process.env.BUN || "bun",
      argsPrefix: [LOCAL_AKM_BUILD_CLI],
      displayPath: LOCAL_AKM_BUILD_CLI,
    }
  }
  const onPath = findCommandOnPath("akm")
  return onPath ? { command: onPath, argsPrefix: [], displayPath: onPath } : null
}

function readAkmVersion(commandSpec: AkmCommandSpec): string {
  const result = runCommand(commandSpec.command, [...commandSpec.argsPrefix, "--version"])
  return parseAkmVersion(result.stdout)
}

function akmVersionSatisfies(commandSpec: AkmCommandSpec): { ok: boolean; version: string; error?: string } {
  const version = readAkmVersion(commandSpec)
  if (!version) return { ok: false, version: "unknown", error: "unable to parse akm version" }
  if (!valid(version)) return { ok: false, version, error: "akm version is not valid semver" }
  if (!satisfies(version, AKM_REQUIRED_RANGE)) return { ok: false, version, error: `akm version does not satisfy ${AKM_REQUIRED_RANGE}` }
  return { ok: true, version }
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
  return !!resolveAkmCommandSpec()
}

function getAkmConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config")
  return path.join(configHome, "akm", "config.json")
}

function readAkmConfig(): Record<string, unknown> {
  try {
    const raw = readFileSync(getAkmConfigPath(), "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function readConfiguredAgentDefault(): string {
  const config = readAkmConfig()
  // 0.8.0 canonical shape: defaults.agent. Fall back to the legacy agent.default
  // slot when running against a pre-0.8 config that has not been migrated yet.
  const defaults = config.defaults
  if (defaults && typeof defaults === "object") {
    const value = (defaults as Record<string, unknown>).agent
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  const agent = config.agent
  if (agent && typeof agent === "object") {
    const value = (agent as Record<string, unknown>).default
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function writeConfiguredAgentDefault(platform: string): boolean {
  if (!platform.trim()) return false
  // #463: route through `akm config set --silent --layer user` so akm's
  // schema-walker / validator is the single source of truth for the on-disk
  // shape. Direct JSON writes here would bypass strict-mode validation and
  // the 5-backup ring buffer, and historically clobbered nearby keys when
  // the legacy `agent.default` slot triggered an auto-migration.
  //
  // --silent suppresses akm's normal stdout (we're invoked from a hook, not
  // a user prompt), and --layer user pins the write to the user-layer
  // config file regardless of where merged reads look — both flags were
  // added in akm-cli 0.8.0 specifically to make hook-driven writes safe.
  const profileSet = akmRunChecked([
    "config",
    "set",
    "--silent",
    "--layer",
    "user",
    `profiles.agent.${platform}`,
    JSON.stringify({ platform }),
  ])
  if (!profileSet.ok) return false
  const defaultSet = akmRunChecked([
    "config",
    "set",
    "--silent",
    "--layer",
    "user",
    "defaults.agent",
    platform,
  ])
  return defaultSet.ok
}

function akmRun(args: string[], input?: string): string {
  const akm = resolveAkmCommandSpec()
  if (!akm) return ""
  const timeout = findCommandOnPath("timeout")
  const result = timeout
    ? runCommand(timeout, ["--preserve-status", CURATE_TIMEOUT, akm.command, ...akm.argsPrefix, ...args], { input, suppressStderr: false })
    : runCommand(akm.command, [...akm.argsPrefix, ...args], { input, suppressStderr: false })
  if (!result.ok) {
    logSubprocessFailure("akm_failed", {
      command: timeout ?? akm.command,
      args: (timeout ? ["--preserve-status", CURATE_TIMEOUT, akm.command, ...akm.argsPrefix, ...args] : [...akm.argsPrefix, ...args]).join(" "),
      error: "akm invocation failed",
      stderr: sanitize(result.stderr),
    })
  }
  return result.stdout
}

/**
 * Async variant of `akmRun` — same args + behavior, but returns Promise<string>
 * so independent akm invocations can be issued concurrently via Promise.all.
 *
 * Used by `sessionStart` (#71) to run hints + curate + proposals in parallel
 * instead of sequentially. Worst-case perceived latency drops from ~3×timeout
 * to ~1×timeout for the typical case where all three calls hit the same
 * embedding/LLM bottleneck.
 */
async function akmRunAsync(args: string[], input?: string): Promise<string> {
  const akm = resolveAkmCommandSpec()
  if (!akm) return ""
  const timeout = findCommandOnPath("timeout")
  const cmd = timeout ? timeout : akm.command
  const fullArgs = timeout ? ["--preserve-status", CURATE_TIMEOUT, akm.command, ...akm.argsPrefix, ...args] : [...akm.argsPrefix, ...args]
  try {
    const proc = Bun.spawn([cmd, ...fullArgs], {
      stdin: input !== undefined ? new TextEncoder().encode(input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      logSubprocessFailure("akm_failed", {
        command: cmd,
        args: fullArgs.join(" "),
        error: `akm invocation failed (exit ${exitCode})`,
        stderr: sanitize(stderr),
      })
    }
    return stdout
  } catch (error) {
    logSubprocessFailure("akm_failed", {
      command: cmd,
      args: fullArgs.join(" "),
      error: error instanceof Error ? error.message : String(error),
      stderr: "",
    })
    return ""
  }
}

function akmRunChecked(args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const akm = resolveAkmCommandSpec()
  if (!akm) return { ok: false, stdout: "", stderr: "akm not found on PATH" }
  const timeout = findCommandOnPath("timeout")
  const result = timeout
    ? runCommand(timeout, ["--preserve-status", CURATE_TIMEOUT, akm.command, ...akm.argsPrefix, ...args], { input, suppressStderr: false })
    : runCommand(akm.command, [...akm.argsPrefix, ...args], { input, suppressStderr: false })
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

function sessionHasPendingCheckpointEvidence(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  const bufferPath = path.join(SESSIONS_DIR, `${sessionID}.md`)
  if (!existsSync(bufferPath)) return false
  const buffer = readFileSync(bufferPath, "utf8")
  return (buffer.match(/^## /gm) ?? []).length >= 2
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

function pretoolNonBash(): string {
  const rawInput = readStdin()
  const parsed = safeJsonParse<Record<string, unknown>>(rawInput)
  if (!parsed) return ""
  const text = getText(parsed.input) || getText(parsed.tool_input) || getText(parsed.command) || sanitize(rawInput)
  const refs = extractAkmRefsFromString(text)
  if (refs.length === 0) return ""
  const sid = extractSessionId(rawInput)
  const toolName = typeof parsed.tool === "string" ? parsed.tool : typeof parsed.tool_name === "string" ? parsed.tool_name : "nonbash"
  writeMemoryEvent({
    event: "tool_ref_observed",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { tool: toolName, phase: "pre" },
    refs,
    outcome: { status: "ok" },
  })
  return ""
}

function posttoolNonBash(): string {
  const rawInput = readStdin()
  const { commandText, outputText, refs, sid, toolName } = extractPostToolFields(rawInput, MODE)
  if (refs.length === 0) return ""
  writeMemoryEvent({
    event: "tool_ref_observed",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { tool: toolName, command: commandText, phase: "post", outputPreview: outputText.slice(0, 400) },
    refs,
    outcome: { status: MODE === "failure" ? "failed" : "ok" },
  })
  for (const ref of refs) {
    writeSessionBuffer(sid, `${toolName} ref`, `- ref: ${ref}`)
  }
  return ""
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
  if ((/\/akm-memory-(promote|reject)\b/.test(expanded) || /\/akm-proposal\s+(accept|reject|drain)\b/.test(expanded) || /\bproposal\s+drain\b/.test(expanded)) && !/\b(confirm|approved|approval)\b/i.test(expanded)) {
    return emitHookContext("UserPromptExpansion", "AKM note: mutating memory/proposal flows should be explicit. Confirm promotion/rejection or proposal acceptance before changing durable state.")
  }
  if (PROPOSAL_FLOW_RE.test(expanded)) ensureFreshProposalCheckpoint(rawInput)
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
    const bufferPath = path.join(SESSIONS_DIR, `${sid}.md`)
    const targetRefHints = [...new Set(summary.match(REF_PATTERN) ?? [])]
    const candidates = extractCandidatesFromText({
      harness: "claude-code",
      sessionId: sid,
      text: summary,
      evidence: [summary],
      sourcePaths: [bufferPath, EVENT_LOG, CANDIDATE_LOG],
      targetRefHints,
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

// checkAkmVersion replaces the pre-0.8.0 ensureAkm() behavior. Until 0.7.x the
// plugin silently spawned `bun install -g akm-cli@…` (or npm) on every
// SessionStart whenever akm was missing or out of range. Installing global
// packages without explicit user consent is too aggressive for a public
// release. Starting with 0.8.0 we detect-and-warn instead: if akm is missing
// or out of range, we write a clear stderr banner pointing at `/akm-setup` —
// which IS the explicit consent point — and return a structured verdict.
// Callers decide how to degrade. We never spawn an install from this path.
function checkAkmVersion(): { ok: boolean; reason?: string; version?: string; path?: string } {
  const existing = resolveAkmCommandSpec()
  if (existing) {
    const current = akmVersionSatisfies(existing)
    if (current.ok) {
      appendLog(SESSION_LOG, "akm_ready", "path", existing.displayPath, current.version)
      return { ok: true, version: current.version, path: existing.displayPath }
    }
    appendLog(SESSION_LOG, "akm_version_mismatch", "path", existing.displayPath, current.version, AKM_REQUIRED_RANGE, current.error ?? "out_of_range")
    writeAkmConsentBanner({ detected: current.version, detectedPath: existing.displayPath })
    return { ok: false, reason: "version-mismatch", version: current.version, path: existing.displayPath }
  }
  appendLog(SESSION_LOG, "akm_missing", "path", AKM_PACKAGE_REF, AKM_REQUIRED_RANGE)
  writeAkmConsentBanner({ detected: undefined, detectedPath: undefined })
  return { ok: false, reason: "not-installed" }
}

function writeAkmConsentBanner(info: { detected?: string; detectedPath?: string }) {
  const detectedLabel = info.detected
    ? `${info.detected}${info.detectedPath ? ` (${info.detectedPath})` : ""}`
    : "(not found on PATH)"
  const banner = [
    "─".repeat(60),
    "akm-plugin: akm CLI not installed or wrong version",
    `  detected: ${detectedLabel}`,
    `  required: ${AKM_REQUIRED_RANGE}`,
    "",
    "Run `/akm-setup` in this Claude Code session to install/upgrade",
    "with your explicit confirmation, or install manually:",
    `  bun install -g ${AKM_PACKAGE_REF}`,
    `  npm install -g ${AKM_PACKAGE_REF}`,
    "─".repeat(60),
  ].join("\n")
  try {
    process.stderr.write(banner + "\n")
  } catch {
    // best-effort; never crash the hook over a banner
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

type AgentDefaultResult = {
  value: string
  writeAttempted: boolean
  writeOk: boolean
  /** True when this SessionStart freshly initialised defaults.agent=claude. */
  initialized: boolean
}

/**
 * Resolve (and lazily initialise) `defaults.agent` for the Claude plugin.
 *
 * Pre-#72 behavior: when `defaults.agent` was empty, silently wrote
 * `defaults.agent=claude` + `profiles.agent.claude` to ~/.config/akm/config.json
 * with no user-visible signal. OpenCode users who installed the Claude plugin
 * to experiment saw their config silently flipped.
 *
 * Post-#72 behavior: we still write (the plugin needs the default to dispatch
 * improve/propose), but we ALSO surface a SessionStart additionalContext line
 * AND a stderr banner on the first write — see gatherSessionStartWarnings.
 * Users can opt OUT of the write entirely with `AKM_PLUGIN_NO_AUTO_DEFAULT=1`
 * (in which case the agent stays unset and improve/propose will refuse until
 * the user runs `/akm-setup`).
 */
function detectAgentDefault(): AgentDefaultResult {
  if (!akmAvailable()) return { value: "", writeAttempted: false, writeOk: false, initialized: false }
  const current = readConfiguredAgentDefault()
  if (current) return { value: current, writeAttempted: false, writeOk: true, initialized: false }
  if (process.env.AKM_PLUGIN_NO_AUTO_DEFAULT === "1") {
    appendLog(SESSION_LOG, "agent_default_skipped", "AKM_PLUGIN_NO_AUTO_DEFAULT=1")
    return { value: "", writeAttempted: false, writeOk: false, initialized: false }
  }
  const writeOk = writeConfiguredAgentDefault("claude")
  if (writeOk) {
    appendLog(SESSION_LOG, "agent_default_initialized", "claude")
  } else {
    appendLog(SESSION_LOG, "agent_default_init_failed", "claude", `failed to write ${getAkmConfigPath()}`)
  }
  return { value: readConfiguredAgentDefault(), writeAttempted: true, writeOk, initialized: writeOk }
}

function runIndexOnSessionEnd(reason: string, sid: string, ref: string) {
  if (!INDEX_ON_SESSION_END || !akmAvailable()) return
  const result = akmRunChecked(["index"])
  if (!result.ok) appendLog(SESSION_LOG, "akm_index_failed", reason, sid, ref, sanitize(result.stderr))
}

function writeStashMissingBanner(stashDir: string | undefined) {
  // additionalContext alone is often ignored by Claude in long-running
  // sessions, so we mirror the akm-missing path and write a clearly-marked
  // banner to stderr where the user can see it in their terminal. Hooks
  // never crash over a banner — wrap in try/catch.
  const banner = [
    "─".repeat(60),
    "akm-plugin: AKM stash directory missing",
    stashDir
      ? `  configured: ${stashDir} (path does not exist)`
      : "  configured: (none — neither AKM_STASH_DIR nor stashDir in config)",
    "",
    "AKM curation, search, and show will return empty until you run",
    "`/akm-setup` to initialize the stash, or set `AKM_STASH_DIR` to an",
    "existing directory. All other Claude features keep working.",
    "─".repeat(60),
  ].join("\n")
  try {
    process.stderr.write(banner + "\n")
  } catch {
    // best-effort; never crash the hook over a banner
  }
}

function gatherSessionStartWarnings(
  versionCheck: { ok: boolean; version?: string },
  agentDefault: AgentDefaultResult,
): string[] {
  const warnings: string[] = []

  // H1: stash directory does not exist — curation will return empty context
  // and most akm verbs (search/show/curate) will be no-ops. Surface this on
  // BOTH channels: additionalContext (so the agent sees the cue) AND stderr
  // (so the user sees it in their terminal, which is the more reliable
  // signal — additionalContext often gets compacted away).
  const stashRoots = resolveStashRoots()
  const stashDir = stashRoots[0]
  if (!stashDir || !existsSync(stashDir)) {
    warnings.push(
      stashDir
        ? `⚠ AKM stash directory \`${stashDir}\` does not exist. Run \`/akm-setup\` to initialize the stash, or set \`AKM_STASH_DIR\` to point at an existing one. AKM curation will be empty until then.`
        : `⚠ No AKM stash directory is configured. Run \`/akm-setup\` to choose one, or set \`AKM_STASH_DIR\`. AKM curation will be empty until then.`,
    )
    writeStashMissingBanner(stashDir)
    appendLog(SESSION_LOG, "stash_missing", stashDir ?? "(unconfigured)")
  }

  // H2: agent default write was attempted but failed — improve/propose
  // workflows will fall back to the unconfigured CLI and may fail mysteriously
  // downstream. Surface this so the user can re-run setup.
  if (agentDefault.writeAttempted && !agentDefault.writeOk) {
    warnings.push(
      `⚠ Failed to write \`defaults.agent\` to \`${getAkmConfigPath()}\`. \`/akm-improve\` and \`/akm-propose\` may not work until this is configured. Run \`/akm-setup\` to retry.`,
    )
  }

  // H3 (#72): agent default was just initialised by THIS SessionStart.
  // Surface the write so OpenCode users (who installed the Claude plugin to
  // experiment) see that their config was modified. Suppresses subsequent
  // SessionStart firings — only the initial write generates this notice.
  if (agentDefault.initialized) {
    warnings.push(
      `ℹ The Claude plugin set \`defaults.agent=claude\` in \`${getAkmConfigPath()}\` so \`/akm-improve\` and \`/akm-propose\` can dispatch tasks. ` +
        `To use a different default, run \`/akm-setup\`. To suppress this auto-write on future installs, set \`AKM_PLUGIN_NO_AUTO_DEFAULT=1\` before SessionStart.`,
    )
    try {
      process.stderr.write(
        [
          "─".repeat(60),
          "akm-plugin: defaults.agent initialized → claude",
          `  config: ${getAkmConfigPath()}`,
          "",
          "  Run /akm-setup to change defaults, or set",
          "  AKM_PLUGIN_NO_AUTO_DEFAULT=1 to opt out of this auto-write.",
          "─".repeat(60),
          "",
        ].join("\n"),
      )
    } catch {
      // best-effort; never crash the hook over a banner
    }
  }

  // L5: detected version is a pre-release. Banner range accepts ^0.8.0-rc0
  // but stable banner text says ^0.8.0 — make the rc status explicit so users
  // know to track stable when it lands.
  if (versionCheck.ok && versionCheck.version && /-/.test(versionCheck.version)) {
    warnings.push(
      `ℹ Detected pre-release \`akm-cli@${versionCheck.version}\`. Tracking is fine; upgrade to a stable 0.8.x once published for production use.`,
    )
  }

  return warnings
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

function ensureFreshProposalCheckpoint(rawInput?: string): string | null {
  if (!AUTO_MEMORY || !akmAvailable()) return null
  const payload = rawInput ?? readStdin()
  const sid = extractSessionId(payload)
  if (!sid || !sessionHasPendingCheckpointEvidence(sid)) return null
  return captureMemory({ rawInput: payload, reason: "proposal-prep", checkpoint: true })
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
    if (/^(?:.*\/\/)?(?:memory|env|secret|lesson):/.test(ref)) continue
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
    const result = akmRun(["--format", "json", "-q", "feedback", ref, signal.polarity === "negative" ? "--negative" : "--positive", "--reason", redactSecrets(signal.note).text, ...scopeArgs])
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

function formatEvidenceSummary(events: AkmMemoryEvent[], candidates: ReturnType<typeof readCandidates>, buffer: string): string[] {
  const lines: string[] = []
  const bufferedEntries = (buffer.match(/^## /gm) ?? []).length
  const allRefs = [...new Set(buffer.match(REF_PATTERN) ?? [])]
  const eventTypes = countByValue(events.map((event) => event.event))
  const statuses = countByValue(events.map((event) => event.outcome?.status ?? "unknown"))
  const candidateTypes = countByValue(candidates.map((candidate) => candidate.type))
  const targetedCandidates = countByValue(candidates.map((candidate) => candidate.targetRef).filter((value): value is string => !!value))

  lines.push("## Evidence aggregates")
  lines.push(`- buffered observations: ${bufferedEntries}`)
  if (allRefs.length > 0) lines.push(`- referenced assets: ${allRefs.slice(0, 6).join(", ")}`)
  if (eventTypes.length > 0) lines.push(`- event types: ${eventTypes.slice(0, 6).map(([event, count]) => `${event} (${count})`).join(", ")}`)
  if (statuses.length > 0) lines.push(`- event outcomes: ${statuses.map(([status, count]) => `${status} (${count})`).join(", ")}`)
  if (candidateTypes.length > 0) lines.push(`- candidate types: ${candidateTypes.map(([type, count]) => `${type} (${count})`).join(", ")}`)
  if (targetedCandidates.length > 0) lines.push(`- candidate targets: ${targetedCandidates.slice(0, 5).map(([ref, count]) => `${ref} (${count})`).join(", ")}`)
  lines.push("")

  const notableEvents = uniqueRecent(events, (event) => `${event.timestamp}:${event.event}:${(event.refs ?? []).join(",")}`, 5)
  if (notableEvents.length > 0) {
    lines.push("## Notable recent events")
    for (const event of notableEvents) {
      const status = event.outcome?.status ?? "unknown"
      const refs = Array.isArray(event.refs) && event.refs.length > 0 ? ` refs=${event.refs.join(", ")}` : ""
      const warning = event.outcome?.warnings?.[0] ? ` warning=${sanitize(event.outcome.warnings[0]).slice(0, 120)}` : ""
      lines.push(`- ${event.timestamp} ${event.event} (${status})${refs}${warning}`)
    }
    lines.push("")
  }

  const notableCandidates = uniqueRecent(candidates, (candidate) => candidate.id, 5)
  if (notableCandidates.length > 0) {
    lines.push("## Candidate highlights")
    for (const candidate of notableCandidates) {
      const target = candidate.targetRef ? ` target=${candidate.targetRef}` : ""
      lines.push(`- [${candidate.status}] ${candidate.type}/${candidate.scope}${target} :: ${candidate.content.slice(0, 180)}`)
    }
    lines.push("")
  }

  return lines
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
  const curated = akmRun(["--shape", "agent", "--format", "text", "-q", "curate", text, "--limit", String(CURATE_LIMIT), ...buildRunScopeArgs(sid)])
  writeMemoryEvent({
    event: "prompt_recall",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { promptPreview: text.slice(0, 280), query: decision.query, reason: decision.reason },
    refs: [...new Set(curated.match(REF_PATTERN) ?? [])],
    outcome: { status: curated.trim() ? "ok" : "skipped" },
  })
  if (!curated.trim()) return ""
  const curatedFile = path.join(CURATED_DIR, `prompt-${sid ?? "unknown"}.md`)
  try {
    writeFileSync(curatedFile, curated.trim())
  } catch {}
  return emitHookContext("UserPromptSubmit", `AKM stash curation written to \`${curatedFile}\`. Read that file to discover assets relevant to this task. ${CURATED_CONTEXT_TAIL}`)
}

async function sessionStart(): Promise<string> {
  const rawInput = readStdin()
  const sid = extractSessionId(rawInput)
  const versionCheck = checkAkmVersion()
  if (!versionCheck.ok) {
    // checkAkmVersion already wrote a stderr banner pointing the user at
    // `/akm-setup` for explicit-consent install. Emit a degraded SessionStart
    // context so the agent knows akm CLI tooling is unavailable this session
    // and won't keep trying to call it. We intentionally do NOT crash the
    // hook — the rest of Claude Code stays fully functional.
    return emitHookContext(
      "SessionStart",
      [
        "# AKM is NOT available in this session",
        "",
        `The akm CLI is missing or does not satisfy \`${AKM_REQUIRED_RANGE}\` (reason: ${versionCheck.reason ?? "unknown"}).`,
        "Do not call any `akm` Bash command. Tell the user to run `/akm-setup`",
        "in this session to install/upgrade akm-cli with their confirmation.",
      ].join("\n"),
    )
  }
  if (!akmAvailable()) return ""

  const akm = resolveAkmCommandSpec()
  if (akm) {
    try {
      const child = spawn(akm.command, [...akm.argsPrefix, "index"], { detached: true, stdio: "ignore" })
      child.unref()
    } catch {
      // best-effort only
    }
  }

  const agentDefault = detectAgentDefault()
  const sessionWarnings = gatherSessionStartWarnings(versionCheck, agentDefault)

  // #71 perceived-latency fix: hints, curate, and proposals have no
  // inter-dependency — issue them concurrently via Promise.all instead of
  // running them sequentially. Worst-case wall-clock drops from ~3×CURATE_TIMEOUT
  // to ~1×CURATE_TIMEOUT when all three calls hit the same embedding bottleneck.
  const cwdContext = gatherCwdContext()
  const [hintsRaw, curatedRaw, pendingRaw] = await Promise.all([
    akmRunAsync(["--format", "text", "-q", "hints"]),
    akmRunAsync([
      "--shape",
      "agent",
      "--format",
      "text",
      "-q",
      "curate",
      cwdContext,
      "--limit",
      String(CURATE_LIMIT),
      ...buildRunScopeArgs(sid),
    ]),
    akmRunAsync(["--format", "json", "-q", "proposal", "list", "--status", "pending"]),
  ])
  const hints = hintsRaw.trim()
  const curatedTrimmed = curatedRaw.trim()
  let curatedFile = ""
  if (curatedTrimmed) {
    curatedFile = path.join(CURATED_DIR, `session-${sid ?? "unknown"}.md`)
    try {
      writeFileSync(curatedFile, curatedTrimmed)
    } catch {}
  }
  const pendingItems = safeJsonParse<Record<string, unknown>>(pendingRaw)
  const pending = Array.isArray(pendingItems?.proposals)
    ? pendingItems?.proposals.length
    : Array.isArray(pendingItems?.hits)
      ? pendingItems?.hits.length
      : 0
  const pendingSummary =
    pending <= 0
      ? ""
      : pending === 1
        ? "There is 1 pending AKM proposal - review with `/akm-review-proposals` or `/akm-proposal list`."
        : `There are ${pending} pending AKM proposals - review with \`/akm-review-proposals\` or \`/akm-proposal list\`.`

  if (!hints && !curatedTrimmed && !agentDefault.value && !pendingSummary && sessionWarnings.length === 0) return ""
  writeMemoryEvent({
    event: "session_started",
    sessionId: sid || undefined,
    scope: buildScope(sid),
    input: { agentDefault: agentDefault.value, pendingProposals: pending },
    refs: [...new Set(curatedTrimmed.match(REF_PATTERN) ?? [])],
    outcome: { status: "ok" },
  })
  let body = SESSION_START_HEADER
  if (sessionWarnings.length > 0) body = `${body}\n\n${sessionWarnings.join("\n")}`
  if (agentDefault.value) body = `${body}\n\nAgent CLI: ${agentDefault.value} (configured via \`akm setup\`).`
  if (pendingSummary) body = `${body}\n\n${pendingSummary}`
  if (hints) body = `${body}\n\n${hints}`
  if (curatedFile) body = `${body}\n\nAKM stash curation written to \`${curatedFile}\`. Read that file to discover assets relevant to this session. ${CURATED_CONTEXT_TAIL}`
  body = `${body}\n\n${SESSION_START_FOOTER}`
  return emitHookContext("SessionStart", body)
}

function captureMemory(options?: { rawInput?: string; reason?: string; checkpoint?: boolean }) {
  const reason = options?.reason ?? MODE ?? "session-end"
  const isCheckpoint = options?.checkpoint === true
  if (!AUTO_MEMORY || !akmAvailable()) return null
  const rawInput = options?.rawInput ?? readStdin()
  const sid = extractSessionId(rawInput)
  if (!sid) return null
  const bufferPath = path.join(SESSIONS_DIR, `${sid}.md`)
  const refSidecar = path.join(SESSIONS_DIR, `${sid}.refs.jsonl`)
  if (!existsSync(bufferPath)) {
    if (!isCheckpoint) rmSync(refSidecar, { force: true })
    return null
  }
  const buffer = readFileSync(bufferPath, "utf8")
  const entries = (buffer.match(/^## /gm) ?? []).length
  if (entries < 2) {
    if (!isCheckpoint) {
      rmSync(bufferPath, { force: true })
      rmSync(refSidecar, { force: true })
    }
    return null
  }
  const dateTag = isCheckpoint
    ? timestamp().replace(/[-:TZ.]/g, "").slice(0, 14)
    : timestamp().slice(0, 10).replace(/-/g, "")
  const shortSid = sid.slice(0, 8)
  const name = isCheckpoint
    ? `claude-checkpoint-${dateTag}-${shortSid}`
    : `claude-session-${dateTag}-${shortSid}`
  const relatedEvents = readJsonl<AkmMemoryEvent>(EVENT_LOG)
    .filter((event) => event.sessionId === sid)
    .slice(-12)
  const relatedCandidates = readCandidates(CANDIDATE_LOG)
    .filter((candidate) => candidate.sessionId === sid)
    .slice(-8)
  const targetRefHints = relatedCandidates.flatMap((candidate) => candidate.targetRef ? [candidate.targetRef] : [])
  const summarySections: string[] = [buffer.trimEnd()]
  summarySections.push([
    "## Full-detail evidence files",
    formatPathBullet("Claude state dir", STATE_DIR),
    formatPathBullet("Session buffer", bufferPath),
    formatPathBullet("Structured event log", EVENT_LOG),
    formatPathBullet("Memory candidate log", CANDIDATE_LOG),
    formatPathBullet("Session log", SESSION_LOG),
    formatPathBullet("Feedback log", FEEDBACK_LOG),
    formatPathBullet("Memory log", MEMORY_LOG),
    process.env.AKM_EVAL_HARNESS_LOG?.trim() ? formatPathBullet("Harness log", process.env.AKM_EVAL_HARNESS_LOG.trim()) : "",
  ].filter(Boolean).join("\n"))
  summarySections.push(formatEvidenceSummary(relatedEvents, relatedCandidates, buffer).join("\n").trimEnd())
  if (relatedEvents.length > 0) {
    summarySections.push([
      "## Plugin event summary",
      ...relatedEvents.map((event) => {
        const status = event.outcome?.status ?? "unknown"
        const refs = Array.isArray(event.refs) && event.refs.length > 0 ? ` — refs: ${event.refs.join(", ")}` : ""
        return `- ${event.timestamp} — ${event.event} (${status})${refs}`
      }),
    ].join("\n"))
  }
  if (relatedCandidates.length > 0) {
    summarySections.push([
      "## Memory candidates observed",
      ...relatedCandidates.map((candidate) => {
        const target = candidate.targetRef ? ` target=${candidate.targetRef}` : ""
        return `- [${candidate.status}] ${candidate.type}/${candidate.scope}${target}: ${candidate.content}`
      }),
    ].join("\n"))
  }
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
  const rawBody = `---\nakm_memory_kind: session_checkpoint\nharness: claude-code\nsession_id: ${sid}\nreason: ${reason}${refsBlock}\n---\n\n# Session summary (${timestamp()})\nReason: ${reason}\nSession: ${sid}\n\n${summarySections.join("\n\n")}`
  const redactedBody = redactSecrets(rawBody).text.replace(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*(?:\[[^\]]+\]|[^\s"'`,;]+)/g, "[REDACTED_ASSIGNMENT:$1]")
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
      evidence: [`memory:${name}`, reason, ...targetRefHints],
      sourcePaths: [bufferPath, EVENT_LOG, CANDIDATE_LOG, SESSION_LOG, FEEDBACK_LOG, MEMORY_LOG].concat(
        process.env.AKM_EVAL_HARNESS_LOG?.trim() ? [process.env.AKM_EVAL_HARNESS_LOG.trim()] : [],
      ),
      targetRefHints,
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
    akmRun(["--format", "json", "-q", "feedback", `memory:${name}`, "--positive", "--reason", "session checkpoint: auto-signal for improve eligibility"])
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
  if (!isCheckpoint) {
    rmSync(bufferPath, { force: true })
    rmSync(refSidecar, { force: true })
  }
  return `memory:${name}`
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

  // Read model from agent frontmatter if not set on the tool call directly.
  // Note: we deliberately do NOT special-case `akm:` prefixed subagent_type
  // values — the Agent tool's subagent_type is always a known
  // ~/.claude/agents/<name>.md file reference, not a runtime-resolved stash
  // ref. Stash agents are surfaced via the `/akm-agent` slash command
  // (which materializes them at user request), not via on-the-fly dispatch.
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

/**
 * SessionEnd → event-driven extraction. Fires `akm extract --type claude-code
 * --session-id <id>` for the just-ended session so its durable insights reach
 * the proposal queue in seconds instead of waiting for the periodic `akm improve` extract pass.
 *
 * Safe + idempotent: `--session-id` respects the content-hash ledger (akm
 * #602 / the beta.33 fix), so a re-fire or a later backstop run is a cheap skip
 * with zero LLM calls — no `--force`. Detached + unref'd so it never blocks
 * session close. Skipped on transient terminations (`clear`/`resume`) where the
 * session isn't really done; the hourly `akm improve` extract pass remains the
 * backstop for crashes that fire no hook.
 */
function extractSession(): string {
  const raw = readStdin()
  const sid = extractSessionId(raw)
  if (!sid) return ""
  const reason = safeJsonParse<Record<string, unknown>>(raw)?.reason
  if (reason === "clear" || reason === "resume") return ""
  const akm = resolveAkmCommandSpec()
  if (!akm) return ""
  try {
    const child = spawn(
      akm.command,
      [...akm.argsPrefix, "extract", "--type", "claude-code", "--session-id", sid],
      { detached: true, stdio: "ignore" },
    )
    child.unref()
  } catch {
    // Best-effort: a failed spawn must never block session close; the cron backstop covers it.
  }
  return ""
}

async function main(): Promise<string> {
  switch (COMMAND) {
    case "ensure-akm":
    case "check-akm":
      // Legacy alias "ensure-akm" no longer installs anything; both subcommands
      // are now version checks that warn-and-point-at-/akm-setup. See
      // checkAkmVersion() for the rationale (Item 2, 0.8.0 polish plan).
      checkAkmVersion()
      return ""
    case "session-start":
      return await sessionStart()
    case "user-feedback":
      recordUserFeedback()
      return ""
    case "curate-prompt":
      return curatePrompt()
    case "user-prompt-expansion":
      return userPromptExpansion()
    case "pre-tool":
      // Bash gating was removed in 0.8.0 — defer to the platform's
      // permission system (see claude/README.md "Locking down destructive
      // commands"). Non-bash matchers still flow through pre-tool-nonbash
      // for ref observation.
      return ""
    case "pre-tool-agent":
      return preToolAgent()
    case "pre-tool-nonbash":
      return pretoolNonBash()
    case "post-tool-nonbash":
      posttoolNonBash()
      return ""
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
    case "extract-session":
      return extractSession()
    case "post-tool":
      recordPostTool()
      return ""
    case "auto-feedback":
      autoFeedback()
      return ""
    case "capture-memory":
      captureMemory({ checkpoint: MODE === "proposal-prep" })
      return ""
    default:
      appendLog(SESSION_LOG, "runtime_error", "unknown_command", COMMAND)
      return ""
  }
}

// `main` is async (#71 made sessionStart parallel via Promise.all). Bun
// supports top-level await; this guarantees the process does not exit
// until the awaits resolve and stdout.write has run.
try {
  const output = await main()
  if (output) process.stdout.write(output)
} catch (error: unknown) {
  logRuntimeError(error instanceof Error ? error.message : String(error))
}
