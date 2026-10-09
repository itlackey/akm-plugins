// akm-opencode-v2: the AKM plugin for OpenCode 2.x (@opencode/plugin 2.0.26).
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
import { type LogLevel, PLUGIN_ID, createCore } from "./core"

type EffectContext = Parameters<Parameters<typeof Plugin.define>[0]["effect"]>[0]

const LEVELS: Record<LogLevel, "Debug" | "Info" | "Warn" | "Error"> = {
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
}

const plugin = Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx: EffectContext) =>
    Effect.gen(function* () {
      // Run promise-shaped work with the plugin fiber's context so Effect.log*
      // reaches the host's logger.
      const services = yield* Effect.context<never>()
      const runPromise = Effect.runPromiseWith(services)

      const core = createCore({
        directory: ctx.location.directory,
        moduleUrl: import.meta.url,
        log: (level, message, extra) => {
          void runPromise(
            Effect.logWithLevel(LEVELS[level])(message).pipe(Effect.annotateLogs({ service: PLUGIN_ID, ...extra })),
          ).catch(() => undefined)
        },
      })

      // Cleanup: unregistering hooks/tools/subscriptions is scoped to the plugin
      // (they are released when the scope closes); this also cancels in-flight akm
      // calls and drops per-session state.
      yield* Effect.addFinalizer(() => Effect.sync(() => core.dispose()))

      // The five tools. `transform` re-runs on tool reload, so adding by id is idempotent.
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
        Effect.sync(() => {
          const text = core.contextText(String(input.sessionID))
          if (!text) return
          const last = input.system.length - 1
          // Merge into the last existing part rather than adding a new one, as the V1
          // plugin does for its single system entry: some chat templates reject more
          // than one system message, and the host's leading part stays a stable cache prefix.
          if (last >= 0) input.system[last] = { ...input.system[last], text: `${input.system[last].text}\n\n${text}` }
          else input.system.push({ type: "text", text } as (typeof input.system)[number])
        }),
      )

      // Tool post-processing: record the outcome of the plugin's own tools.
      yield* ctx.tool.hook("execute.after", (input) =>
        Effect.sync(() => {
          if (!input.tool.startsWith("akm_")) return
          core.log(input.status === "error" ? "warn" : "debug", "AKM tool result observed", {
            toolName: input.tool,
            sessionID: String(input.sessionID),
            callID: String(input.id),
            status: input.status,
          })
        }),
      )

      // Session lifecycle: one native event subscription, closed with the plugin scope.
      const directory = ctx.location.directory
      yield* Effect.forkScoped(
        Stream.runForEach(ctx.event.subscribe(), (event) => {
          // Other projects' sessions are not ours: one plugin instance per location.
          const eventDirectory = event.location?.directory
          if (eventDirectory && eventDirectory !== directory) return Effect.void
          return Effect.promise(() => core.onEvent(event as { type?: string; data?: unknown }))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => core.log("error", "AKM event subscription ended", { error: String(cause).slice(0, 400) })),
          ),
        ),
      )
    }),
})

export default plugin
