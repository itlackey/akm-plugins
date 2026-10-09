// Host-agnostic core of the OpenCode V2 plugin. It has no dependency on
// `@opencode/plugin` or `effect`: index.ts adapts the V2 native API (tool
// registry, session hooks, event stream, logging) onto the functions here, and
// tests drive them directly with a fake `akm`.
//
// Semantics, against OpenCode 2.0.26 (see README "Hook mapping"):
//   - `session.prompt` hook   -> onPrompt(): decide whether the prompt warrants
//     recall and run `akm curate` for it. The hook is awaited by the runtime
//     before the model request is built, so we wait for curation for a bounded
//     time (recallWaitMs); a slower curation keeps running and lands on the
//     NEXT request instead of stalling this one.
//   - `session.context` hook  -> contextText(): the recalled block, framed as
//     DATA with its provenance banner, plus the standing AKM rules, within the
//     context budget. Pushed on EVERY request (the host rebuilds `system` each
//     time), so it survives compaction.
//   - event stream            -> onEvent(): session lifecycle; the extraction
//     checkpoint and state cleanup.
import { shouldRecall } from "../claude/shared/recall-policy"
import { redactObject } from "../claude/shared/redaction"
import { extractAkmRefsFromString } from "../claude/shared/ref-extraction"
import { createBundleDirResolver } from "../opencode-shared/bundle"
import { type EventWriter, writeOpencodeEvent } from "../opencode-shared/events"
import {
  type NegativeFeedback,
  createFeedbackTracker,
  parseToolOutput,
  spawnPositiveFeedback,
  submitNegativeFeedback,
} from "../opencode-shared/feedback"
import { createLearning, createPendingProposals } from "../opencode-shared/learning"
import {
  type CliError,
  type ResolvedAkmCommand,
  type ReadOperation,
  formatCliError,
  isCliError,
  readVerbToolOutput,
  resolveAkmCommand,
  runAkm,
} from "../opencode-shared/akm-cli"
import {
  AKM_CURATED_TAIL,
  AKM_HINTS_PREFIX,
  RECALLED_CONTENT_PROVENANCE,
  applyContextBudget,
  autoMemoryEnabled,
  buildScopedArgs,
  extractMinIntervalMs,
  formatWorkflowContext,
  gatherCwdContext,
  recallCurate,
  spawnSessionExtract,
  summarizeActiveWorkflows,
  truncateLogText,
} from "../opencode-shared/recall"
import {
  TOOL_SPECS,
  type ToolSpec,
  buildFeedbackArgs,
  buildRememberArgs,
  toJsonSchema,
  withProposedWarnings,
} from "../opencode-shared/tools"

export const PLUGIN_ID = "akm-opencode-v2"
const PACKAGE_NAME = "akm-opencode-v2"

export type LogLevel = "debug" | "info" | "warn" | "error"
/** Must not throw. index.ts routes it to the V2 logging channel (Effect logs). */
export type LogSink = (level: LogLevel, message: string, extra: Record<string, unknown>) => void

export type CoreOptions = {
  log: LogSink
  /** Project directory the plugin was loaded for (cwd for akm, project anchor for session-start recall). */
  directory: string
  /** The entrypoint's `import.meta.url`, so `akm-cli` resolves from the plugin package. */
  moduleUrl: string
  /** The project (worktree) root, exported to shell environments as AKM_PROJECT. Defaults to `directory`. */
  projectDirectory?: string
  /** The plugin's own version, exported to shell environments as AKM_PLUGIN_VERSION. */
  pluginVersion?: string
  /** Test seam: where structured memory events go. Defaults to the shared `opencode` ledger. */
  writeEvent?: EventWriter
  /** How long a prompt hook may wait for curation before the request proceeds without it. */
  recallWaitMs?: number
  /** Test seam: replaces command resolution. */
  resolveCommand?: () => ResolvedAkmCommand | CliError
  /** Test seam: replaces the extraction spawn. */
  extract?: typeof spawnSessionExtract
  now?: () => number
}

export type ToolOutcome = { text: string; ok: boolean }

export type ToolDefinition = {
  name: ToolSpec["name"]
  description: string
  inputSchema: Record<string, unknown>
  run: (input: Record<string, unknown>, context: { sessionID?: string; signal?: AbortSignal }) => Promise<ToolOutcome>
}

type SessionState = {
  curated?: string
  hints?: string
  workflow?: string
  lastQuery?: string
  generation: number
  lastExtractAt: number
  controllers: Set<AbortController>
}

const AUTO_CURATE = () => (process.env.AKM_AUTO_CURATE ?? "1") !== "0"
const CURATE_MIN_CHARS = () => Math.max(1, Number(process.env.AKM_CURATE_MIN_CHARS ?? "16") || 16)
const CURATE_TIMEOUT_MS = () => Math.max(1_000, (Number(process.env.AKM_CURATE_TIMEOUT ?? "8") || 8) * 1_000)
const READ_TOOL_TIMEOUT_MS = () => Math.max(1_000, (Number(process.env.AKM_READ_TOOL_TIMEOUT ?? "60") || 60) * 1_000)
const PENDING_PROPOSAL_TIMEOUT_MS = () => Math.max(500, (Number(process.env.AKM_PENDING_PROPOSAL_TIMEOUT ?? "2") || 2) * 1_000)
const SESSION_BUFFER_MAX_ENTRIES = () => Math.max(1, Number(process.env.AKM_SESSION_BUFFER_MAX_ENTRIES ?? "200") || 200)
const NEED_MORE_CONTEXT_HINT =
  "Need more AKM context? Use `akm_search` or `akm_curate` before writing or editing a file whose exact syntax you are not certain of."

function failureMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === "string") return truncateLogText(parsed.error, 400)
  } catch {
    // not JSON
  }
  return truncateLogText(text, 400)
}

export function createCore(options: CoreOptions) {
  const now = options.now ?? Date.now
  const recallWaitMs = options.recallWaitMs ?? Math.max(0, Number(process.env.AKM_RECALL_WAIT_MS ?? "3000") || 0)
  const sessions = new Map<string, SessionState>()
  const resolveCommand = options.resolveCommand ?? (() => resolveAkmCommand(options.moduleUrl, PACKAGE_NAME))
  const extractSession = options.extract ?? spawnSessionExtract
  let disposed = false
  const writeEvent = options.writeEvent ?? writeOpencodeEvent
  const tracker = createFeedbackTracker({ maxBufferEntries: SESSION_BUFFER_MAX_ENTRIES() })
  const bundleDir = createBundleDirResolver()

  // Logging is a boundary: redact, then hand to the sink, and never let a sink
  // failure escape into a hook.
  const log: LogSink = (level, message, extra) => {
    try {
      options.log(level, message, redactObject({ subsystem: "akm", ...extra }).value as Record<string, unknown>)
    } catch {
      // A broken logger must not break the host.
    }
  }

  const formatError = (error: unknown) => formatCliError(error, PACKAGE_NAME)
  const pendingProposals = createPendingProposals({
    list: async (args) => {
      const command = resolveCommand()
      if (isCliError(command)) throw new Error(command.error)
      const result = await runAkm(command, args, { timeoutMs: PENDING_PROPOSAL_TIMEOUT_MS(), cwd: options.directory, packageName: PACKAGE_NAME })
      if (!result.ok) throw new Error(result.error)
      return result.stdout
    },
    formatError,
  })
  const learning = createLearning({
    log,
    writeEvent,
    resolveCommand,
    formatError,
    addBufferEntry: tracker.addBufferEntry,
    onSubmitted: (sessionID) => pendingProposals.invalidate(sessionID),
  })

  function state(sessionID: string): SessionState {
    let existing = sessions.get(sessionID)
    if (!existing) {
      existing = { generation: 0, lastExtractAt: 0, controllers: new Set() }
      sessions.set(sessionID, existing)
    }
    return existing
  }

  function dropSession(sessionID: string): void {
    const existing = sessions.get(sessionID)
    tracker.clear(sessionID)
    pendingProposals.invalidate(sessionID)
    if (!existing) return
    for (const controller of existing.controllers) controller.abort()
    existing.controllers.clear()
    sessions.delete(sessionID)
  }

  /** One akm call that never throws: stdout text, or null (and a logged warning). */
  async function runBestEffort(
    sessionID: string | undefined,
    args: string[],
    meta: { operation: string },
  ): Promise<string | null> {
    const command = resolveCommand()
    if (isCliError(command)) {
      log("warn", "AKM command resolution failed", { operation: meta.operation, sessionID, error: command.error })
      return null
    }
    const controller = new AbortController()
    const owner = sessionID ? sessions.get(sessionID) : undefined
    owner?.controllers.add(controller)
    try {
      const result = await runAkm(command, args, {
        timeoutMs: CURATE_TIMEOUT_MS(),
        cwd: options.directory,
        signal: controller.signal,
        packageName: PACKAGE_NAME,
      })
      if (!result.ok) {
        if (!controller.signal.aborted) {
          log("warn", "AKM helper failed", { operation: meta.operation, sessionID, args, error: result.error })
        }
        return null
      }
      return result.stdout.trim() || null
    } finally {
      owner?.controllers.delete(controller)
    }
  }

  /** One in-process recall (`akm-cli/api`) that never throws: the curated text, or null (and a logged warning). */
  async function curate(sessionID: string, query: string, operation: string): Promise<string | null> {
    const controller = new AbortController()
    const owner = sessions.get(sessionID)
    owner?.controllers.add(controller)
    try {
      const outcome = await recallCurate(query, { cwd: options.directory, timeoutMs: CURATE_TIMEOUT_MS(), signal: controller.signal })
      if (outcome.ok) return outcome.text
      if (!outcome.aborted) log("warn", "AKM recall failed", { operation, sessionID, subsystem: "curation", error: outcome.error })
      return null
    } finally {
      owner?.controllers.delete(controller)
    }
  }

  // --- hooks ------------------------------------------------------------------

  /**
   * What the user's message means for the learning loop, independent of recall:
   * a correction/preference/workflow becomes a proposal in akm's review queue (never
   * an automatic memory write), and a "that worked" / "that's wrong" credits or
   * blames the refs this session touched. Starts work and returns; never throws.
   */
  function observeUserMessage(sessionID: string, text: string): void {
    try {
      learning.capturePromptLearning(text, sessionID, options.directory, options.directory)
    } catch (error: unknown) {
      log("warn", "AKM learning capture failed", { subsystem: "learning", sessionID, error: formatError(error) })
    }
    try {
      const plan = tracker.planFeedback(sessionID, text)
      for (const positive of plan.positive) startPositiveFeedback(sessionID, positive.ref, positive.note)
      if (plan.negative) void submitNegative(sessionID, plan.negative)
    } catch (error: unknown) {
      log("warn", "AKM auto-feedback failed", { subsystem: "feedback", sessionID, error: formatError(error) })
    }
  }

  function startPositiveFeedback(sessionID: string, ref: string, note: string): void {
    const command = resolveCommand()
    if (isCliError(command)) {
      log("warn", "AKM auto-feedback skipped", { subsystem: "feedback", toolName: "session.prompt", sessionID, ref, error: command.error })
      return
    }
    spawnPositiveFeedback(
      command,
      ref,
      note,
      (error) => log("warn", "AKM auto-feedback failed", { subsystem: "feedback", toolName: "session.prompt", sessionID, ref, error }),
      formatError,
    )
  }

  async function submitNegative(sessionID: string, negative: NegativeFeedback): Promise<void> {
    try {
      const command = resolveCommand()
      if (isCliError(command)) {
        log("warn", "AKM auto-feedback skipped", { subsystem: "feedback", toolName: "session.prompt", sessionID, ref: negative.ref, error: command.error })
        return
      }
      const result = await submitNegativeFeedback(command, negative, { timeoutMs: READ_TOOL_TIMEOUT_MS(), cwd: options.directory, packageName: PACKAGE_NAME })
      log(result.ok ? "info" : "warn", result.ok ? "AKM auto-feedback recorded" : "AKM auto-feedback failed", {
        subsystem: "feedback",
        sessionID,
        ref: negative.ref,
        reason: negative.explicit ? "explicit correction" : "negative retrospective signal",
        ...(result.error ? { error: result.error } : {}),
      })
    } catch (error: unknown) {
      log("warn", "AKM auto-feedback failed", { subsystem: "feedback", sessionID, ref: negative.ref, error: formatError(error) })
    }
  }

  /** `session.prompt` hook body. Never throws. */
  async function onPrompt(sessionID: string, promptText: string): Promise<void> {
    try {
      if (disposed) return
      const text = promptText.trim()
      if (!text) return
      // Read before the feedback plan updates the window, as the V1 hook does.
      const recentAssetFailure = tracker.hasRecentNegativeSignal(sessionID)
      observeUserMessage(sessionID, text)
      if (!AUTO_CURATE()) return
      const st = state(sessionID)
      const decision = shouldRecall(text, { activeWorkflow: !!st.workflow, recentAssetFailure })
      if (!decision.shouldRecall) {
        if (!(st.curated ?? "").includes(NEED_MORE_CONTEXT_HINT)) {
          st.curated = st.curated ? `${st.curated}\n\n${NEED_MORE_CONTEXT_HINT}` : NEED_MORE_CONTEXT_HINT
        }
        return
      }
      if (decision.query.length < CURATE_MIN_CHARS()) return
      // Dedupe: the same recall query within a session is not run twice (a retry
      // or a re-sent prompt must not respawn akm or stack identical blocks).
      if (st.lastQuery === decision.query) return
      st.lastQuery = decision.query
      const generation = ++st.generation
      const pending = curate(sessionID, decision.query, "prompt-curate").then((curated) => {
        // A newer prompt, or a deleted session, supersedes this result.
        if (disposed || sessions.get(sessionID) !== st || st.generation !== generation) return
        if (curated) st.curated = curated
        log("info", "AKM prompt recall finished", {
          sessionID,
          query: truncateLogText(decision.query, 200),
          reason: decision.reason,
          refs: extractAkmRefsFromString(curated ?? ""),
          outcome: curated ? "ok" : "skipped",
        })
      })
      pending.catch((error: unknown) => log("warn", "AKM background curate failed", { sessionID, error: formatCliError(error, PACKAGE_NAME) }))
      if (recallWaitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          pending.catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, recallWaitMs)
          }),
        ])
        if (timer) clearTimeout(timer)
      }
    } catch (error: unknown) {
      log("error", "AKM session.prompt hook failed", { hook: "session.prompt", sessionID, error: formatCliError(error, PACKAGE_NAME) })
    }
  }

  /** `session.context` hook body: the text to add to the request's system context, or "". Never throws. */
  async function contextText(sessionID: string): Promise<string> {
    try {
      if (disposed) return ""
      const st = sessions.get(sessionID)
      const blocks = [
        st?.curated ? `${RECALLED_CONTENT_PROVENANCE}${st.curated}${AKM_CURATED_TAIL}` : "",
        st?.hints ? `${AKM_HINTS_PREFIX}\n\n${st.hints}` : AKM_HINTS_PREFIX,
        st?.workflow ? formatWorkflowContext(st.workflow) : "",
        // The pending-proposal nag: only when something awaits review (cached for a minute).
        await pendingProposals.contextBlock(sessionID),
      ]
      return applyContextBudget(blocks).join("\n\n")
    } catch (error: unknown) {
      log("error", "AKM session.context hook failed", { hook: "session.context", sessionID, error: formatCliError(error, PACKAGE_NAME) })
      return ""
    }
  }

  async function onSessionCreated(sessionID: string): Promise<void> {
    const st = state(sessionID)
    const cwdContext = gatherCwdContext(options.directory)
    const [curated, hints, workflowRaw] = await Promise.all([
      AUTO_CURATE() && cwdContext && !st.curated ? curate(sessionID, cwdContext, "session-curate") : Promise.resolve(null),
      runBestEffort(sessionID, ["--format", "text", "-q", "hints"], { operation: "session-hints" }),
      runBestEffort(sessionID, ["--format", "json", "-q", "workflow", "list", "--active"], { operation: "active-workflow-summary" }),
    ])
    if (disposed || sessions.get(sessionID) !== st) return
    if (curated && !st.curated) st.curated = curated
    if (hints) st.hints = hints
    st.workflow = (workflowRaw && summarizeActiveWorkflows(workflowRaw)) || undefined
  }

  /** Min-interval-gated, fire-and-forget extraction of a native session into the proposal queue. */
  function maybeExtract(sessionID: string): void {
    if (disposed || !autoMemoryEnabled()) return
    const st = state(sessionID)
    const at = now()
    if (at - st.lastExtractAt < extractMinIntervalMs()) return
    const command = resolveCommand()
    if (isCliError(command)) return // akm unavailable: the periodic `akm improve` extract pass is the backstop
    st.lastExtractAt = at
    extractSession(
      command,
      sessionID,
      (outcome) => {
        if (outcome.ok) {
          log("info", "AKM extract completed", { subsystem: "extract", sessionID })
          return
        }
        log("warn", "AKM extract failed", {
          subsystem: "extract",
          sessionID,
          error: outcome.error,
          akmCode: outcome.akmCode,
          hint: outcome.hint,
          exitCode: outcome.exitCode,
          output: outcome.output,
        })
      },
      (error) => formatCliError(error, PACKAGE_NAME),
    )
  }

  /** `akm info`'s bundle directory (or AKM_BUNDLE_DIR), cached; undefined when akm cannot say. */
  function getBundleDir(): Promise<string | undefined> {
    return bundleDir.get(() => runBestEffort(undefined, ["info", "--format", "json", "-q"], { operation: "get-bundle-dir" }))
  }

  /**
   * `tool.execute.after` body, for EVERY tool: note the akm refs it touched (the
   * refs "thanks, that worked" later credits) and record what the plugin's own
   * tools returned. A tool outcome is never feedback by itself. Never throws.
   */
  async function onToolResult(call: {
    tool: string
    sessionID: string
    callID: string
    args: unknown
    status: string
    /** The tool's text output, or the error message when it failed. */
    text: string
  }): Promise<void> {
    try {
      if (disposed) return
      const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {}
      const common = { sessionID: call.sessionID, tool: call.tool, callID: call.callID, args, directory: options.directory, writeEvent }
      const { refs } = await tracker.observeToolRefs({ ...common, outputText: call.text, getBundleDir })
      if (!call.tool.startsWith("akm_")) return
      log(call.status === "error" ? "warn" : "debug", "AKM tool result observed", {
        toolName: call.tool,
        sessionID: call.sessionID,
        callID: call.callID,
        status: call.status,
        refs,
      })
      const parsed = parseToolOutput(call.text)
      if (parsed && typeof parsed === "object") tracker.observeAkmToolResult({ ...common, parsed })
    } catch (error: unknown) {
      log("error", "AKM tool.execute.after hook failed", { hook: "tool.execute.after", toolName: call.tool, sessionID: call.sessionID, error: formatError(error) })
    }
  }

  /**
   * `shell.create.before` body: tell every shell the agent starts which project
   * and plugin it is running under, and where the bundle is, so `akm` run from
   * the shell resolves the same bundle. Mutates `env` in place. Never throws.
   */
  async function shellEnv(env: Record<string, string | undefined>): Promise<void> {
    try {
      if (disposed) return
      env.AKM_PROJECT = options.projectDirectory ?? options.directory
      if (options.pluginVersion) env.AKM_PLUGIN_VERSION = options.pluginVersion
      const dir = await getBundleDir()
      if (dir) env.AKM_BUNDLE_DIR = dir
    } catch (error: unknown) {
      log("error", "AKM shell.create.before hook failed", { hook: "shell.create.before", error: formatError(error) })
    }
  }

  /** Native event stream handler. Never throws. */
  async function onEvent(event: { type?: string; data?: unknown }): Promise<void> {
    try {
      if (disposed || !event?.type) return
      const data = (event.data ?? {}) as { sessionID?: unknown }
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      if (!sessionID) return
      switch (event.type) {
        case "session.created":
          await onSessionCreated(sessionID)
          break
        case "session.execution.succeeded":
          // A turn finished: the V2 analogue of V1's per-turn `session.idle`.
          maybeExtract(sessionID)
          break
        case "session.deleted":
          dropSession(sessionID)
          break
        default:
          break
      }
    } catch (error: unknown) {
      log("error", "AKM event handler failed", { hook: "event", eventType: event?.type, error: formatCliError(error, PACKAGE_NAME) })
    }
  }

  // --- tools -------------------------------------------------------------------

  async function runTool(
    spec: ToolSpec["name"],
    input: Record<string, unknown>,
    context: { sessionID?: string; signal?: AbortSignal },
  ): Promise<ToolOutcome> {
    const fail = (error: string): ToolOutcome => ({ ok: false, text: JSON.stringify({ ok: false, error }) })
    try {
      if (disposed) return fail("The AKM plugin has been unloaded.")
      const command = resolveCommand()
      const callOptions = { timeoutMs: READ_TOOL_TIMEOUT_MS(), cwd: options.directory, signal: context.signal, packageName: PACKAGE_NAME }
      let outcome: ToolOutcome
      if (spec === "akm_search" || spec === "akm_show" || spec === "akm_curate") {
        const operation: ReadOperation = spec === "akm_search" ? "search" : spec === "akm_show" ? "show" : "curate"
        const mapped = operation === "curate" || operation === "show"
          ? { ...input, type: input.type === "any" ? undefined : input.type }
          : { ...input, type: input.type === "any" ? undefined : input.type, includeProposed: input.include_proposed }
        const result = await readVerbToolOutput(command, operation, mapped, callOptions)
        outcome = { ok: result.ok, text: operation === "search" && result.ok ? withProposedWarnings(result.output) : result.output }
      } else {
        if (isCliError(command)) return fail(command.error)
        let args: string[]
        if (spec === "akm_remember") {
          args = buildRememberArgs(
            { content: String(input.content ?? ""), name: input.name as string | undefined, force: input.force === true },
            { sessionID: context.sessionID },
          )
        } else {
          const built = buildFeedbackArgs(input as Parameters<typeof buildFeedbackArgs>[0])
          if ("refusal" in built) {
            log("warn", "AKM feedback refused", { toolName: spec, sessionID: context.sessionID, ref: input.ref, error: built.refusal })
            return fail(built.refusal)
          }
          args = built.args
        }
        const result = await runAkm(command, [...args, "--format", "json"], callOptions)
        outcome = result.ok
          ? { ok: true, text: result.stdout.trim() || JSON.stringify({ ok: true }) }
          : { ok: false, text: JSON.stringify({ ok: false, error: result.error }) }
      }
      log(outcome.ok ? "info" : "error", outcome.ok ? "AKM tool call completed" : "AKM tool call failed", {
        toolName: spec,
        sessionID: context.sessionID,
        refs: extractAkmRefsFromString(outcome.text),
        ...(outcome.ok ? {} : { error: failureMessage(outcome.text) }),
      })
      return outcome
    } catch (error: unknown) {
      const message = formatCliError(error, PACKAGE_NAME)
      log("error", "AKM tool call failed", { toolName: spec, sessionID: context.sessionID, error: message })
      return fail(message)
    }
  }

  const tools: ToolDefinition[] = (Object.keys(TOOL_SPECS) as ToolSpec["name"][]).map((name) => ({
    name,
    description: TOOL_SPECS[name].description,
    inputSchema: toJsonSchema(TOOL_SPECS[name]),
    run: (input, context) => runTool(name, input, context),
  }))

  /** Called by the host when the plugin unloads: cancel in-flight akm calls and drop all state. */
  function dispose(): void {
    disposed = true
    for (const id of [...sessions.keys()]) dropSession(id)
  }

  return {
    tools,
    onPrompt,
    contextText,
    onToolResult,
    shellEnv,
    onEvent,
    dispose,
    log,
    /** Test/diagnostic view of how many sessions hold state. */
    sessionCount: () => sessions.size,
  }
}

export type Core = ReturnType<typeof createCore>
