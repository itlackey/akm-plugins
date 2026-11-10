// akm-opencode-v2: the AKM plugin for OpenCode 2.x (@opencode/plugin 2.1.4).
//
// This file is native wiring only. The recall policy, tool schemas, redaction,
// ref extraction, `akm` invocation and extraction flow live in
// ../opencode-shared and ./core.ts, shared with the V1 plugin (`akm-opencode`).
//
// Logging: the Promise plugin API has no logger, so this is an Effect plugin
// (`@opencode/plugin/effect`), and diagnostics go through Effect's logger
// captured from the plugin's own fiber context, i.e. the host's logger. Nothing
// here writes to the console, stdout or stderr.
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { realpathSync } from "node:fs"
import path from "node:path"
import { readPluginVersion } from "../opencode-shared/bundle"
import { readonlyOption } from "../opencode-shared/tools"
import { type LogLevel, PLUGIN_ID, createCore } from "./core"

/** Same directory despite a trailing slash or a symlink; falls back to the resolved path when it cannot be resolved. */
function sameDirectory(a: string, b: string): boolean {
  const real = (dir: string) => {
    const resolved = path.resolve(dir)
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  }
  return real(a) === real(b)
}

type EffectContext = Parameters<Parameters<typeof Plugin.define>[0]["effect"]>[0]

const LEVELS: Record<LogLevel, "Debug" | "Info" | "Warn" | "Error"> = {
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
}

/** The text of a completed tool result: `content` is a string or a list of parts, `output` is structured. */
function resultText(result: { content?: string | ReadonlyArray<{ type: string; text?: string }>; output?: unknown } | undefined): string {
  const content = result?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n")
  return typeof result?.output === "string" ? result.output : ""
}

/** A completed `read`'s file text: the structured `output.content` of a file result, not the framed rendering. */
function readFileText(result: { output?: unknown } | undefined): string | undefined {
  const output = result?.output as { type?: unknown; content?: unknown } | undefined
  return output?.type === "file" && typeof output.content === "string" ? output.content : undefined
}

const plugin = Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx: EffectContext) =>
    Effect.gen(function* () {
      // Run promise-shaped work with the plugin fiber's context so Effect.log*
      // reaches the host's logger.
      const services = yield* Effect.context<never>()
      const runPromise = Effect.runPromiseWith(services)

      // `{ "package": "akm-opencode-v2", "options": { "readonly": true } }` in the host's `plugins`.
      const mode = readonlyOption(ctx.options)
      const core = createCore({
        readonly: mode.readonly,
        directory: ctx.location.directory,
        pluginVersion: readPluginVersion(import.meta.url, PLUGIN_ID),
        moduleUrl: import.meta.url,
        session: (sessionID) => runPromise(ctx.session.get({ sessionID: sessionID as never })),
        log: (level, message, extra) => {
          void runPromise(
            Effect.logWithLevel(LEVELS[level])(message).pipe(Effect.annotateLogs({ service: PLUGIN_ID, ...extra })),
          ).catch(() => undefined)
        },
      })

      if (mode.warning) core.log("warn", mode.warning, { subsystem: "settings" })

      // Cleanup: unregistering hooks/tools/subscriptions is scoped to the plugin
      // (they are released when the scope closes); this also cancels in-flight akm
      // calls and drops per-session state.
      yield* Effect.addFinalizer(() => Effect.sync(() => core.dispose()))

      // The tools (the four read tools only in read-only mode). `transform` re-runs on tool reload, so adding by id is idempotent.
      yield* ctx.tool.transform((editor) => {
        for (const definition of core.tools) {
          editor.add({
            name: definition.name,
            description: definition.description,
            input: definition.inputSchema as never,
            // Offer these as ordinary tool calls, as the V1 plugin does. The V2 default
            // (codemode) hides a tool behind the `execute` script tool, which is a much
            // weaker prompt for the "curate first, show before relying" doctrine.
            options: { codemode: false },
            execute: (input, toolContext) =>
              Effect.promise(async () => {
                const outcome = await definition.run((input ?? {}) as Record<string, unknown>, {
                  sessionID: String(toolContext.sessionID),
                })
                return { content: outcome.text, metadata: { ok: outcome.ok } }
              }),
          })
        }
      })

      // Automatic recall, step 1: the prompt the user just sent.
      yield* ctx.session.hook("prompt", (input) =>
        Effect.promise(() => core.onPrompt(String(input.sessionID), String(input.prompt.text ?? ""))),
      )

      // Automatic recall, step 2: inject the recalled block into this request's system context.
      yield* ctx.session.hook("context", (input) =>
        Effect.promise(async () => {
          const text = await core.contextText(String(input.sessionID))
          if (!text) return
          const last = input.system.length - 1
          // Merge into the last existing part rather than adding a new one, as the V1
          // plugin does for its single system entry: some chat templates reject more
          // than one system message, and the host's leading part stays a stable cache prefix.
          if (last >= 0) input.system[last] = { ...input.system[last], text: `${input.system[last].text}\n\n${text}` }
          else input.system.push({ type: "text", text } as (typeof input.system)[number])
        }),
      )

      // Read-only mode registers neither the write gate, the auto-feedback tracking nor the shell hook.
      if (!mode.readonly) {
        // The write gate: records what it would have blocked; it never fails the call.
        yield* ctx.tool.hook("execute.before", (input) =>
          Effect.promise(() =>
            core.onToolBefore({ tool: input.tool, sessionID: String(input.sessionID), callID: String(input.id), input: input.input }),
          ),
        )

        // Tool post-processing, for every tool: note the akm refs it touched (what a later
        // "thanks, that worked" credits) and record the plugin's own tools' results.
        yield* ctx.tool.hook("execute.after", (input) =>
          Effect.promise(() =>
            core.onToolResult({
              tool: input.tool,
              sessionID: String(input.sessionID),
              callID: String(input.id),
              args: input.input,
              status: input.status,
              text: input.status === "error" ? String(input.error?.message ?? "") : resultText(input.result),
              readContent: input.status === "completed" ? readFileText(input.result) : undefined,
            }),
          ),
        )

        // Shell environment: the V2 analogue of V1's `shell.env`. `env` is the full environment
        // the host is about to spawn the shell with, mutated in place.
        yield* ctx.shell.hook("create.before", (input) => Effect.promise(() => core.shellEnv(input.env)))
      }

      // Session lifecycle: one native event subscription, closed with the plugin scope.
      const directory = ctx.location.directory
      // Session events can arrive without a `location` (2.1.4 sends only `sessionID`); the session's
      // own directory then decides whose it is. Remembered per session: it never changes.
      const sessionDirectory = new Map<string, string>()
      const ownsEvent = async (event: { location?: { directory?: string }; data?: unknown }): Promise<boolean> => {
        // Other projects' sessions are not ours: one plugin instance per location.
        const eventDirectory = event.location?.directory
        if (eventDirectory) return sameDirectory(eventDirectory, directory)
        const sessionID = (event.data as { sessionID?: unknown } | undefined)?.sessionID
        if (typeof sessionID !== "string") return true
        let owner = sessionDirectory.get(sessionID)
        if (!owner) {
          try {
            owner = String((await runPromise(ctx.session.get({ sessionID: sessionID as never }))).location.directory)
            sessionDirectory.set(sessionID, owner)
          } catch {
            return false // a session the host cannot tell us about is not ours to act on
          }
        }
        return sameDirectory(owner, directory)
      }
      yield* Effect.forkScoped(
        Stream.runForEach(ctx.event.subscribe(), (event) =>
          Effect.promise(async () => {
            const mine = await ownsEvent(event as { location?: { directory?: string }; data?: unknown })
            const data = (event as { type?: string; data?: { sessionID?: unknown } })
            if (data.type === "session.deleted" && typeof data.data?.sessionID === "string") sessionDirectory.delete(data.data.sessionID)
            if (mine) await core.onEvent(event as { type?: string; data?: unknown })
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => core.log("error", "AKM event subscription ended", { error: String(cause).slice(0, 400) })),
          ),
        ),
      )
    }),
})

export default plugin
